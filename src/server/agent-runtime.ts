import { Effect, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import type { AgentUiOperation, ServerMessage } from "../shared/contracts.js";
import type { ServerConfig } from "./config.js";
import type { RequestIdentity } from "./identity.js";
import type { AgentTurnRecord, WorkspaceRepositoryService } from "./persistence.js";
import type { RealtimeHubService } from "./realtime.js";
import { runAuditedJev, runAuditedMinistral } from "./providers/audit.js";
import { JEV_MODEL, MINISTRAL_MODEL, type ChatMessage, type JevAdapter, type JevRequest, type JevResult, type MinistralAdapter, type MinistralRequest, type MinistralResult, type ProviderMetadata } from "./providers/contracts.js";
import { providerFailure } from "./providers/http.js";
import { makeJevAdapter } from "./providers/jev.js";
import { makeMinistralAdapter } from "./providers/ministral.js";
import { findRegisteredTool, makeToolRegistry, modelToolsFromRegistry, ToolExecutionError, type AgentUiRequest } from "./tool-registry.js";
import { toolHandlers } from "./tool-handlers.js";

const maximumToolRounds = 3;
const maximumCallsPerRound = 6;
const uiTimeoutMs = 5_000;
const historyBytes = 24 * 1024;
const encoder = new TextEncoder();

type RuntimeFiber = ReturnType<typeof Effect.runFork>;
interface PendingOperation {
  readonly connectionId: string;
  readonly resolve: (outcome: "applied" | "missing") => void;
}
interface ActiveTurn {
  readonly key: string;
  readonly identity: RequestIdentity;
  readonly generation: number;
  readonly turnId: string;
  readonly requestId: string;
  readonly connectionId: string;
  readonly send: (message: ServerMessage) => Promise<void>;
  readonly hub: RealtimeHubService;
  connected: boolean;
  cancelled: boolean;
  providerFiber: RuntimeFiber | null;
  jevCount: number;
  uiMissing: boolean;
  readonly operations: Map<string, PendingOperation>;
}

export interface AgentStartContext {
  readonly repository: WorkspaceRepositoryService;
  readonly hub: RealtimeHubService;
  readonly identity: RequestIdentity;
  readonly generation: number;
  readonly turnId: string;
  readonly requestId: string;
  readonly message: string;
  readonly connectionId: string;
  readonly send: (message: ServerMessage) => Promise<void>;
}

const metadata = (model: string, request: unknown, response: unknown): ProviderMetadata => ({
  provider: "Scripted",
  requestedModel: model,
  actualModel: `scripted/${model}`,
  providerRequestId: null,
  generationId: null,
  requestBytes: encoder.encode(JSON.stringify(request)).byteLength,
  responseBytes: encoder.encode(JSON.stringify(response)).byteLength,
  usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: 0 },
});

const scriptedMinistral = (): MinistralAdapter => ({
  complete: (request) => Effect.gen(function* () {
    const last = request.messages.at(-1);
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const text = lastUser?.role === "user" ? lastUser.content.toLowerCase() : "";
    if (text.includes("slow turn")) yield* Effect.sleep(600);
    if (last?.role === "tool") {
      const toolMessages = request.messages.filter((message) => message.role === "tool");
      const failed = toolMessages.some((message) => message.role === "tool" && message.content.includes('"ok":false'));
      let consentSummary: string | null = null;
      if (text.includes("consent")) {
        try {
          const parsed = JSON.parse(last.content) as { result?: { consent?: string; evidence?: string; alternatives?: ReadonlyArray<{ label: string; probability: number }> } };
          const consent = parsed.result?.consent;
          const evidence = parsed.result?.evidence;
          const alternatives = parsed.result?.alternatives;
          if (consent !== undefined && evidence !== undefined && alternatives !== undefined) {
            consentSummary = `Evidence: \"${evidence}\"\nConsent: ${consent}. Alternatives: ${alternatives.map((item) => `${item.label} ${Math.round(item.probability * 100)}%`).join(", ")}. ${consent === "explicit" ? "Application policy still decides whether a proposal is eligible." : "This remains for human review."}`;
          }
        } catch {
          consentSummary = null;
        }
      }
      const content = consentSummary ?? (failed
        ? "I could not finish every requested step. The completed results remain visible, and you can retry the missing step."
        : text.includes("reset")
          ? "The reset is ready for your review. Nothing changes until you accept it."
          : text.includes("green") || text.includes("ready") || text.includes("batch")
            ? "The eligible orders are ready for your review. Nothing changes until you accept the batch."
            : "I found the order and showed the relevant evidence.")
      const response = { content, toolCalls: [] };
      return { kind: "chat", content, toolCalls: [], finishReason: "stop", metadata: metadata(MINISTRAL_MODEL, request, response), safeRequest: request, safeResponse: response };
    }
    const id = () => `call_${randomUUID()}`;
    const orderMatch = /bb-\d{4}/i.exec(text)?.[0]?.toUpperCase() ?? "BB-1042";
    const toolCalls = text.includes("reset")
      ? [{ id: id(), name: "prepareReset", arguments: {} }]
      : text.includes("consent")
        ? [{ id: id(), name: "checkConsent", arguments: { orderId: orderMatch } }]
        : text.includes("classif")
          ? [{ id: id(), name: "classifyNote", arguments: { note: lastUser?.role === "user" ? lastUser.content : "" } }]
          : text.includes("green") || text.includes("ready") || text.includes("batch")
            ? [{ id: id(), name: "prepareBatch", arguments: {} }]
            : [
                { id: id(), name: "getOrder", arguments: { orderId: orderMatch } },
                { id: id(), name: "navigate", arguments: { view: "order", orderId: orderMatch } },
                { id: id(), name: "highlight", arguments: { target: "orderEvidence", orderId: orderMatch } },
              ];
    const response = { content: "", toolCalls };
    return { kind: "chat", content: "", toolCalls, finishReason: "tool_calls", metadata: metadata(MINISTRAL_MODEL, request, response), safeRequest: request, safeResponse: response };
  }),
});

const scriptedJev = (): JevAdapter => ({
  decide: (request) => Effect.sync((): JevResult => {
    const stateText = JSON.stringify(request.state).toLowerCase();
    const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      if (question.type === "choice") {
        const keys = Object.keys(question.criteria);
        const selected = keys.includes("conditional") && /(if|might|picture|first)/.test(stateText)
          ? "conditional"
          : keys.includes("carrier") && /(carrier|collection|scan)/.test(stateText)
            ? "carrier"
            : keys[0] ?? "unclear";
        return [name, { type: "choice" as const, choice: selected, confidence: 0.98, probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 0.98 : 0.02 / Math.max(1, keys.length - 1)])) }];
      }
      if (question.type === "noul") return [name, { type: "noul" as const, noul: 0.5 }];
      return [name, { type: "score" as const, score: 0, confidence: 1, probabilities: { "0": 1 }, legend: {} }];
    }));
    const response = { answers };
    return { kind: "decisions", answers, metadata: metadata(JEV_MODEL, request, response), safeRequest: request, safeResponse: response };
  }),
});

const unavailableMinistral: MinistralAdapter = {
  complete: () => Effect.fail(providerFailure("configuration", "The live agent is unavailable because OPENROUTER_API_KEY is not configured.")),
};
const unavailableJev: JevAdapter = {
  decide: () => Effect.fail(providerFailure("configuration", "Jev is unavailable because OPENROUTER_API_KEY is not configured.")),
};

const adaptersFor = (config: ServerConfig): { readonly ministral: MinistralAdapter; readonly jev: JevAdapter } => {
  if (config.agentMode === "scripted") return { ministral: scriptedMinistral(), jev: scriptedJev() };
  if (config.agentMode === "live" && config.openRouterApiKey !== null) {
    const adapterConfig = { apiKey: config.openRouterApiKey, timeoutMs: 20_000, maximumConcurrency: 2 };
    return { ministral: makeMinistralAdapter(adapterConfig), jev: makeJevAdapter(adapterConfig) };
  }
  return { ministral: unavailableMinistral, jev: unavailableJev };
};

const safeToolResult = (result: unknown) => JSON.stringify({ ok: true, result });
const safeToolFailure = (error: unknown) => JSON.stringify({
  ok: false,
  error: {
    code: error instanceof ToolExecutionError ? error.code : "tool_failed",
    message: error instanceof Error ? error.message : "The tool failed.",
  },
});

const trimHistory = (system: ChatMessage, groups: ReadonlyArray<ReadonlyArray<ChatMessage>>, current: ReadonlyArray<ChatMessage>) => {
  const selected: Array<ReadonlyArray<ChatMessage>> = [];
  let size = encoder.encode(JSON.stringify([system, ...current])).byteLength;
  for (const group of [...groups].reverse()) {
    const groupSize = encoder.encode(JSON.stringify(group)).byteLength;
    if (size + groupSize > historyBytes) break;
    selected.unshift(group);
    size += groupSize;
  }
  return [system, ...selected.flat(), ...current];
};

export const makeAgentCoordinator = (config: ServerConfig, suppliedAdapters?: { readonly ministral: MinistralAdapter; readonly jev: JevAdapter }) => {
  const adapters = suppliedAdapters ?? adaptersFor(config);
  const registry = makeToolRegistry(toolHandlers);
  const modelTools = modelToolsFromRegistry(registry);
  const activeByUser = new Map<string, ActiveTurn>();
  const completionConnections = new Map<string, { readonly generation: number; readonly turnId: string; readonly connectionId: string }>();

  const sendState = async (active: ActiveTurn, repository: WorkspaceRepositoryService) => {
    const state = await Effect.runPromise(repository.snapshot(active.identity));
    await Effect.runPromise(active.hub.publishAgent(active.identity.id, active.generation, state, active.connectionId));
    if (!active.connected) return;
    await Promise.race([
      active.send({ type: "agent_state", state }).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
  };

  const update = async (active: ActiveTurn, repository: WorkspaceRepositoryService, history: ReadonlyArray<ChatMessage>, status: AgentTurnRecord["status"], phase: string, options: { readonly error?: string | null; readonly proposalId?: string; readonly finished?: boolean; readonly measurement?: AgentTurnRecord["measurement"] } = {}) => {
    await Effect.runPromise(repository.updateAgentTurn(active.identity, active.generation, active.turnId, {
      status,
      phase,
      history,
      error: options.error,
      proposalId: options.proposalId,
      finishedAt: options.finished ? new Date().toISOString() : undefined,
      measurement: options.measurement,
    }));
    await sendState(active, repository);
  };

  const providerResult = async <A, E>(active: ActiveTurn, effect: Effect.Effect<A, E>): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: E | Error }> => {
    const observed = effect.pipe(Effect.match({ onFailure: (error) => ({ ok: false as const, error }), onSuccess: (value) => ({ ok: true as const, value }) }));
    const fiber = Effect.runFork(observed);
    active.providerFiber = fiber;
    try {
      return await Effect.runPromise(Fiber.join(fiber));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error("The provider call was interrupted.") };
    } finally {
      if (active.providerFiber === fiber) active.providerFiber = null;
    }
  };

  const requestUi = async (active: ActiveTurn, repository: WorkspaceRepositoryService, history: ReadonlyArray<ChatMessage>, operation: AgentUiRequest) => {
    const id = `operation_${randomUUID()}`;
    const full = { ...operation, id, turnId: active.turnId, generation: active.generation } as AgentUiOperation;
    await update(active, repository, history, "waiting_for_ui", operation.kind === "highlight" ? "Highlighting" : operation.kind === "navigate" ? "Opening" : "Showing proposal", operation.kind === "present_proposal" ? { proposalId: operation.proposalId } : {});
    const outcome = active.connected ? await new Promise<"applied" | "missing">((resolve) => {
      active.operations.set(id, { connectionId: active.connectionId, resolve });
      const timer = setTimeout(() => {
        if (active.operations.delete(id)) resolve("missing");
      }, uiTimeoutMs);
      const stored = active.operations.get(id)!;
      active.operations.set(id, { ...stored, resolve: (value) => { clearTimeout(timer); resolve(value); } });
      void active.send({ type: "agent_ui_operation", operation: full }).catch(() => {
        if (active.operations.delete(id)) resolve("missing");
      });
    }) : "missing";
    active.operations.delete(id);
    active.uiMissing ||= outcome === "missing";
    await update(active, repository, history, "running", "Working");
    return outcome === "applied"
      ? { applied: true, message: operation.kind === "highlight" ? "The target is highlighted." : operation.kind === "navigate" ? "The view is open." : "The proposal is visible." }
      : { applied: false, message: "The target was not available in the initiating browser. The result is saved and can be retried." };
  };

  const ensureCurrentGeneration = async (active: ActiveTurn, repository: WorkspaceRepositoryService) => {
    const state = await Effect.runPromise(repository.snapshot(active.identity));
    if (state.generation !== active.generation) throw new Error("This workspace was reset while the turn was running.");
  };

  const runTurn = async (active: ActiveTurn, repository: WorkspaceRepositoryService, hub: RealtimeHubService, initial: AgentTurnRecord) => {
    let history = [...initial.history];
    try {
      const priorGroups = await Effect.runPromise(repository.agentHistories(active.identity, active.generation, active.turnId, 6));
      const system: ChatMessage = { role: "system", content: "You are the Bracken & Beam fulfilment assistant. Use only the registered tools. Never accept or commit a proposal. Prepare exact previews for the person to review. Application policy owns stock, arithmetic, permissions, and eligibility. Keep answers concise. If a tool reports a missing UI target or another recoverable result, say what remains available. For consent checks, repeat the selected evidence and every returned alternative with its probability so the person can review the classification." };
      for (let round = 0; round < maximumToolRounds; round += 1) {
        if (active.cancelled) throw new Error("cancelled");
        await ensureCurrentGeneration(active, repository);
        await update(active, repository, history, "running", round === 0 ? "Thinking" : "Checking results");
        const request: MinistralRequest = { messages: trimHistory(system, priorGroups, history), tools: modelTools, toolChoice: "auto", maxOutputTokens: 256 };
        const result = await providerResult(active, runAuditedMinistral({
          repository, identity: active.identity, generation: active.generation,
          requestId: `${active.turnId}:chat:${round + 1}`, turnId: active.turnId,
          notify: (userId, attempt) => hub.publishAudit(userId, attempt),
        }, adapters.ministral, request));
        if (!result.ok) throw result.error;
        if (active.cancelled) throw new Error("cancelled");
        await ensureCurrentGeneration(active, repository);
        const assistant: ChatMessage = { role: "assistant", content: result.value.content || null, ...(result.value.toolCalls.length === 0 ? {} : { toolCalls: result.value.toolCalls }) };
        history.push(assistant);
        if (result.value.toolCalls.length === 0) {
          const content = result.value.content.trim();
          if (content.length === 0) throw new Error("The provider returned no final answer.");
          if (!active.uiMissing) completionConnections.set(active.identity.id, { generation: active.generation, turnId: active.turnId, connectionId: active.connectionId });
          await update(
            active,
            repository,
            history,
            active.uiMissing ? "complete" : "waiting_for_ui",
            active.uiMissing ? "Complete with missing UI" : "Rendering answer",
            { finished: true, ...(active.uiMissing ? { measurement: "incomplete" as const } : {}) },
          );
          return;
        }
        if (result.value.toolCalls.length > maximumCallsPerRound) throw new Error("The provider requested too many tools in one round.");
        for (const call of result.value.toolCalls) {
          if (active.cancelled) throw new Error("cancelled");
          const tool = findRegisteredTool(registry, call.name);
          let content: string;
          if (tool === null) {
            content = safeToolFailure(new ToolExecutionError("unknown_tool", `Unknown tool: ${call.name}`));
          } else {
            try {
              const output = await tool.execute({
                repository, identity: active.identity, generation: active.generation,
                turnId: active.turnId, requestId: call.id,
                runJev: async (jevRequest: JevRequest) => {
                  active.jevCount += 1;
                  const jev = await providerResult(active, runAuditedJev({
                    repository, identity: active.identity, generation: active.generation,
                    requestId: `${active.turnId}:jev:${active.jevCount}`, turnId: active.turnId,
                    notify: (userId, attempt) => hub.publishAudit(userId, attempt),
                  }, adapters.jev, jevRequest));
                  if (!jev.ok) throw jev.error;
                  await ensureCurrentGeneration(active, repository);
                  return jev.value;
                },
                requestUi: (operation) => requestUi(active, repository, history, operation),
              }, call.arguments);
              content = safeToolResult(output);
            } catch (error) {
              content = safeToolFailure(error);
            }
          }
          history.push({ role: "tool", content, toolCallId: call.id });
          await update(active, repository, history, "running", "Working");
        }
      }
      throw new Error("The turn reached the three-round tool limit.");
    } catch (error) {
      if (active.cancelled || (error instanceof Error && error.message === "cancelled")) {
        history.push({ role: "assistant", content: "Cancelled. Any proposal already shown is still available for your review." });
        await update(active, repository, history, "cancelled", "Cancelled", { finished: true, measurement: "incomplete" }).catch(() => undefined);
      } else {
        const message = error instanceof Error && error.message.includes("reset")
          ? "This turn stopped because the workspace was reset."
          : "I could not complete that turn. You can retry it, and any proposal already shown is still available for review.";
        history.push({ role: "assistant", content: message });
        await update(active, repository, history, "failed", "Failed", { error: message, finished: true, measurement: "incomplete" }).catch(() => undefined);
      }
    } finally {
      activeByUser.delete(active.identity.id);
      for (const pending of active.operations.values()) pending.resolve("missing");
      active.operations.clear();
    }
  };

  return {
    registry,
    start: async (context: AgentStartContext) => {
      const existing = await Effect.runPromise(context.repository.agentTurn(context.identity, context.generation, context.turnId));
      if (existing !== null) {
        await context.send({ type: "agent_state", state: await Effect.runPromise(context.repository.snapshot(context.identity)) });
        return { started: false, turn: existing };
      }
      if (activeByUser.has(context.identity.id)) throw new Error("Wait for the current turn to finish or cancel it first.");
      const created = await Effect.runPromise(context.repository.createAgentTurn(context.identity, context.generation, context.turnId, context.requestId, context.connectionId, context.message));
      await context.send({ type: "agent_state", state: await Effect.runPromise(context.repository.snapshot(context.identity)) });
      if (!created.created) return { started: false, turn: created.turn };
      const active: ActiveTurn = { key: `${context.identity.id}:${context.generation}:${context.turnId}`, identity: context.identity, generation: context.generation, turnId: context.turnId, requestId: context.requestId, connectionId: context.connectionId, send: context.send, hub: context.hub, connected: true, cancelled: false, providerFiber: null, jevCount: 0, uiMissing: false, operations: new Map() };
      activeByUser.set(context.identity.id, active);
      void runTurn(active, context.repository, context.hub, created.turn);
      return { started: true, turn: created.turn };
    },
    cancel: async (identity: RequestIdentity, generation: number, turnId: string) => {
      const active = activeByUser.get(identity.id);
      if (active === undefined || active.turnId !== turnId || active.generation !== generation) return false;
      active.cancelled = true;
      if (active.providerFiber !== null) Effect.runFork(Fiber.interrupt(active.providerFiber));
      for (const operation of active.operations.values()) operation.resolve("missing");
      return true;
    },
    cancelGeneration: async (identity: RequestIdentity, generation: number) => {
      const completion = completionConnections.get(identity.id);
      const removedCompletion = completion?.generation === generation;
      if (removedCompletion) completionConnections.delete(identity.id);
      const active = activeByUser.get(identity.id);
      if (active === undefined || active.generation !== generation) return removedCompletion;
      active.cancelled = true;
      if (active.providerFiber !== null) Effect.runFork(Fiber.interrupt(active.providerFiber));
      for (const operation of active.operations.values()) operation.resolve("missing");
      return true;
    },
    acknowledgeComplete: (identity: RequestIdentity, generation: number, turnId: string, connectionId: string) => {
      const completion = completionConnections.get(identity.id);
      if (completion === undefined || completion.generation !== generation || completion.turnId !== turnId || completion.connectionId !== connectionId) return false;
      completionConnections.delete(identity.id);
      return true;
    },
    acknowledgeUi: (identity: RequestIdentity, generation: number, turnId: string, operationId: string, connectionId: string, outcome: "applied" | "missing") => {
      const active = activeByUser.get(identity.id);
      if (active === undefined || active.generation !== generation || active.turnId !== turnId || active.connectionId !== connectionId) return false;
      const operation = active.operations.get(operationId);
      if (operation === undefined || operation.connectionId !== connectionId) return false;
      operation.resolve(outcome);
      return true;
    },
    disconnect: async (repository: WorkspaceRepositoryService, identity: RequestIdentity, connectionId: string) => {
      await Effect.runPromise(repository.markAgentConnectionIncomplete(identity, connectionId));
      if (completionConnections.get(identity.id)?.connectionId === connectionId) completionConnections.delete(identity.id);
      const active = activeByUser.get(identity.id);
      if (active?.connectionId !== connectionId) return;
      active.connected = false;
      active.uiMissing = true;
      for (const operation of active.operations.values()) operation.resolve("missing");
    },
  };
};

export type AgentCoordinator = ReturnType<typeof makeAgentCoordinator>;
