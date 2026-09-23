import { Effect, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import { exploreScenarios } from "../shared/explore.js";
import type { AgentUiOperation, AgentViewContext, ServerMessage } from "../shared/contracts.js";
import type { ServerConfig } from "./config.js";
import type { RequestIdentity } from "./identity.js";
import type { AgentTurnRecord, ResolvedAgentViewContext, WorkspaceRepositoryService } from "./persistence.js";
import type { RealtimeHubService } from "./realtime.js";
import { runAuditedJev, runAuditedMinistral } from "./providers/audit.js";
import { JEV_MODEL, MINISTRAL_MODEL, ProviderError, providerBounds, type ChatMessage, type JevAdapter, type JevRequest, type JevResult, type MinistralAdapter, type MinistralRequest, type MinistralResult, type ProviderMetadata } from "./providers/contracts.js";
import { buildMinistralWireRequest } from "./providers/chat-request.js";
import { jsonBytes, providerFailure } from "./providers/http.js";
import { makeJevAdapter } from "./providers/jev.js";
import { makeMinistralAdapter } from "./providers/ministral.js";
import { findRegisteredTool, makeToolRegistry, modelToolsFromRegistry, ToolExecutionError, type AgentUiRequest } from "./tool-registry.js";
import { toolHandlers } from "./tool-handlers.js";

const maximumToolRounds = 8;
const maximumCallsPerRound = 6;
const uiTimeoutMs = 5_000;
const finalAcknowledgementTimeoutMs = 5_000;
const maximumToolResultBytes = 4 * 1024;
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
  readonly startedMonotonicMs: number;
  serverCompleted: boolean;
  readonly operations: Map<string, PendingOperation>;
}
interface Admission {
  readonly turnId: string;
  readonly done: Promise<void>;
  readonly release: () => void;
}
interface PendingCompletion {
  readonly generation: number;
  readonly turnId: string;
  readonly connectionId: string;
  readonly active: ActiveTurn;
  readonly repository: WorkspaceRepositoryService;
  readonly history: ReadonlyArray<ChatMessage>;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface AgentStartContext {
  readonly repository: WorkspaceRepositoryService;
  readonly hub: RealtimeHubService;
  readonly identity: RequestIdentity;
  readonly generation: number;
  readonly turnId: string;
  readonly requestId: string;
  readonly message: string;
  readonly viewContext: AgentViewContext;
  readonly connectionId: string;
  readonly send: (message: ServerMessage) => Promise<void>;
}

export interface ExploreScenarioStartContext extends Omit<AgentStartContext, "message" | "viewContext"> {
  readonly scenario: "consent";
}

export interface ExploreScenarioLaunch {
  readonly scenario: "consent";
  readonly outcome: "completed" | "failed";
  readonly attemptId: string;
  readonly turnId: string;
  readonly message: string;
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

const contextPrefix = "Authenticated application context: ";
const selectedOrderFromMessages = (messages: ReadonlyArray<ChatMessage>): string | null => {
  const context = messages.find((message) => message.role === "system" && message.content.startsWith(contextPrefix));
  if (context?.role !== "system") return null;
  try {
    const resolved = JSON.parse(context.content.slice(contextPrefix.length)) as ResolvedAgentViewContext;
    return resolved.focus?.kind === "order" ? resolved.focus.order.id : null;
  } catch {
    return null;
  }
};

const scriptedMinistral = (): MinistralAdapter => ({
  complete: (request) => Effect.gen(function* () {
    const last = request.messages.at(-1);
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const text = lastUser?.role === "user" ? lastUser.content.toLowerCase() : "";
    if (text.includes("simulate the provider failure fixture")) {
      return yield* providerFailure("provider_error", "The deterministic provider failure fixture stopped this request.");
    }
    if (text.includes("slow turn")) yield* Effect.sleep(600);
    if (last?.role === "tool") {
      const toolCallIndex = request.messages.findLastIndex((message) => message.role === "assistant" && message.toolCalls !== undefined);
      const toolMessages = request.messages.slice(toolCallIndex + 1).filter((message) => message.role === "tool");
      const failed = toolMessages.some((message) => message.role === "tool" && message.content.includes('"ok":false'));
      const overviewOrders = toolMessages.map((message) => JSON.parse(message.content) as { result?: { orders?: Array<{ id: string; status: string; family: string; issue: string }> } })
        .find((message) => message.result?.orders !== undefined)?.result?.orders ?? [];
      const overviewText = [
        ...["ready", "review", "waiting"].map((status) => `${status[0]!.toUpperCase()}${status.slice(1)}: ${overviewOrders.filter((order) => order.status === status).length}`),
        ...overviewOrders.filter((order) => order.status === "review").slice(0, 3).map((order) => `${order.id}: ${order.status}, ${order.family}. ${order.issue}`),
      ].join("\n");
      const content = failed
        ? "I could not finish every requested step. The completed results remain visible, and you can retry the missing step."
        : text.includes("tutorial") || text.includes("teach") || text.includes("learn")
          ? "The tutorial is ready. Your verified work advances it, and you can dismiss it at any time."
        : text.includes("reset")
          ? "The reset is ready for your review. Nothing changes until you accept it."
          : text.includes("summarize the queue")
            ? overviewText
          : text.includes("attention")
            ? "I grouped the current queue and opened Work so you can review what is ready and what still needs a decision."
          : text.includes("audit")
            ? "I opened Audit. Return to Work to continue the conversation."
            : text.includes("explore")
              ? "I opened Explore. Return to Work to continue the conversation."
              : text.includes("green") || text.includes("ready") || text.includes("batch")
                ? "The eligible orders are ready for your review. Nothing changes until you accept the batch."
                : text.includes("consent")
                  ? "This remains for human review."
                  : "I found the order and showed the relevant evidence."
      const response = { content, toolCalls: [] };
      return { kind: "chat", content, toolCalls: [], finishReason: "stop", metadata: metadata(MINISTRAL_MODEL, request, response), safeRequest: request, safeResponse: response };
    }
    const id = () => `call_${randomUUID()}`;
    const orderMatch = /bb-\d{4}/i.exec(text)?.[0]?.toUpperCase() ?? selectedOrderFromMessages(request.messages) ?? "BB-1042";
    const toolCalls = text.includes("stop") && text.includes("tutorial")
      ? [{ id: id(), name: "stopTutorial", arguments: {} }]
      : text.includes("tutorial") || text.includes("teach") || text.includes("learn")
        ? [{ id: id(), name: "startTutorial", arguments: { tutorialId: text.includes("substitut") || text.includes("replacement") ? "substitution-review" : text.includes("batch") ? "batch-approval" : "address-correction" } }]
      : text.includes("reset")
      ? [{ id: id(), name: "prepareReset", arguments: {} }]
      : (text.includes("attention") || text.includes("summarize the queue"))
        ? [
            { id: id(), name: "listOrders", arguments: {} },
            { id: id(), name: "groupOrders", arguments: { groupBy: "status" } },
            { id: id(), name: "navigate", arguments: { view: "work" } },
          ]
      : text.includes("audit")
        ? [{ id: id(), name: "navigate", arguments: { view: "audit" } }]
      : text.includes("explore")
        ? [{ id: id(), name: "navigate", arguments: { view: "explore" } }]
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
  decide: (request) => Effect.sleep(JSON.stringify(request.state).toLowerCase().includes("picture first") ? 600 : 0).pipe(Effect.map((): JevResult => {
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
  })),
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
    const adapterConfig = { apiKey: config.openRouterApiKey, maximumConcurrency: providerBounds.maximumConcurrency };
    return { ministral: makeMinistralAdapter(adapterConfig), jev: makeJevAdapter(adapterConfig) };
  }
  return { ministral: unavailableMinistral, jev: unavailableJev };
};

const safeToolResult = (toolName: string, result: unknown) => {
  const encoded = JSON.stringify({ ok: true, result });
  if (encoder.encode(encoded).byteLength <= maximumToolResultBytes) return encoded;
  return JSON.stringify({
    ok: true,
    truncated: true,
    result: { summary: `${toolName} completed, but its result exceeded the per-tool context limit. Use narrower filters or a detail tool for more information.` },
  });
};
const safeToolFailure = (error: unknown) => JSON.stringify({
  ok: false,
  error: {
    code: error instanceof ToolExecutionError ? error.code : "tool_failed",
    message: error instanceof Error ? error.message : "The tool failed.",
  },
});
const isProviderError = (error: unknown): error is ProviderError =>
  error instanceof ProviderError || (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ProviderError");

const historyGroups = (messages: ReadonlyArray<ChatMessage>): Array<Array<ChatMessage>> => {
  const groups: Array<Array<ChatMessage>> = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      const group: Array<ChatMessage> = [message];
      index += 1;
      while (index < messages.length && messages[index]?.role === "tool") group.push(messages[index++]!);
      groups.push(group);
    } else {
      groups.push([message]);
      index += 1;
    }
  }
  return groups;
};

const compactToolContent = (content: string): string => {
  try {
    const value = JSON.parse(content) as { ok?: unknown; error?: unknown; result?: unknown };
    if (value.ok === false) {
      const error = typeof value.error === "object" && value.error !== null ? value.error as { code?: unknown; message?: unknown } : {};
      return JSON.stringify({
        ok: false,
        truncated: true,
        error: {
          code: typeof error.code === "string" ? error.code.slice(0, 64) : "tool_failed",
          message: typeof error.message === "string" ? error.message.slice(0, 512) : "The tool failed.",
        },
      });
    }
    if (value.ok === true && typeof value.result === "object" && value.result !== null) {
      const result = value.result as { ok?: unknown; message?: unknown };
      if (result.ok === false) {
        return JSON.stringify({
          ok: true,
          truncated: true,
          result: {
            ok: false,
            message: typeof result.message === "string" ? result.message.slice(0, 512) : "The requested UI result was not available.",
          },
        });
      }
    }
    if (value.ok === true) {
      return JSON.stringify({ ok: true, truncated: true, result: { summary: "This tool completed, but its detailed result was compacted to keep the next bounded model request valid." } });
    }
  } catch {
    // Stored tool messages are validated before this path. Never turn an unreadable result into success.
  }
  return JSON.stringify({ ok: false, truncated: true, error: { code: "invalid_tool_result", message: "The earlier tool result could not be read after context compaction." } });
};

const compactToolGroup = (group: ReadonlyArray<ChatMessage>): Array<ChatMessage> => group.map((message) => message.role === "tool"
  ? { role: "tool" as const, toolCallId: message.toolCallId, content: compactToolContent(message.content) }
  : message);

const consentDisclosure = (output: unknown): string | null => {
  if (typeof output !== "object" || output === null) return null;
  const value = output as { consent?: unknown; evidence?: unknown; alternatives?: unknown };
  if (typeof value.consent !== "string" || typeof value.evidence !== "string" || !Array.isArray(value.alternatives)) return null;
  const alternatives = value.alternatives.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const alternative = entry as { label?: unknown; probability?: unknown };
    if (typeof alternative.label !== "string" || typeof alternative.probability !== "number" || !Number.isFinite(alternative.probability)) return [];
    const percentage = Number((alternative.probability * 100).toFixed(2));
    return [`${alternative.label} ${percentage}%`];
  });
  if (alternatives.length !== value.alternatives.length) return null;
  return `Evidence: \"${value.evidence.replace(/\s+/g, " ").trim()}\" Consent: ${value.consent}. Alternatives: ${alternatives.join(", ")}.`;
};

export const makeAgentCoordinator = (
  config: ServerConfig,
  suppliedAdapters?: { readonly ministral: MinistralAdapter; readonly jev: JevAdapter },
  suppliedTimeouts?: { readonly finalAcknowledgementMs?: number },
) => {
  const adapters = suppliedAdapters ?? adaptersFor(config);
  const registry = makeToolRegistry(toolHandlers);
  const modelTools = modelToolsFromRegistry(registry);
  const activeByUser = new Map<string, ActiveTurn>();
  const admissionsByUser = new Map<string, Admission>();
  const completionConnections = new Map<string, PendingCompletion>();
  const finalAckMs = suppliedTimeouts?.finalAcknowledgementMs ?? finalAcknowledgementTimeoutMs;

  const boundedRequest = (
    system: ChatMessage,
    applicationContext: ChatMessage,
    priorTurns: ReadonlyArray<ReadonlyArray<ChatMessage>>,
    currentHistory: ReadonlyArray<ChatMessage>,
  ): MinistralRequest => {
    const requestFor = (messages: ReadonlyArray<ChatMessage>): MinistralRequest => ({ messages, tools: modelTools, toolChoice: "auto", maxOutputTokens: providerBounds.maximumOutputTokens });
    const fits = (messages: ReadonlyArray<ChatMessage>): boolean =>
      messages.length <= 32 && jsonBytes(buildMinistralWireRequest(requestFor(messages))) <= providerBounds.maximumContextBytes;
    const currentGroups = historyGroups(currentHistory);
    const first = currentGroups.shift() ?? [];
    const retained: Array<ReadonlyArray<ChatMessage>> = [];
    let omittedCurrent = false;
    for (const original of currentGroups.reverse()) {
      let group = original;
      const candidate = [system, applicationContext, ...first, ...group, ...retained.flat()];
      if (retained.length === 0 && !fits(candidate)) group = compactToolGroup(group);
      const next = [system, applicationContext, ...first, ...group, ...retained.flat()];
      if (!fits(next)) {
        omittedCurrent = true;
        break;
      }
      retained.unshift(group);
    }
    const omitted: ChatMessage = { role: "system", content: "Earlier completed tool outcomes from this active turn were omitted to keep this request within its fixed context limit." };
    const selectedPrior: Array<ReadonlyArray<ChatMessage>> = [];
    for (const prior of [...priorTurns].reverse()) {
      const candidate = [system, applicationContext, ...selectedPrior.flat(), ...(omittedCurrent ? [omitted] : []), ...first, ...retained.flat()];
      const withPrior = [system, applicationContext, ...prior, ...candidate.slice(2)];
      if (!fits(withPrior)) break;
      selectedPrior.unshift(prior);
    }
    const messages = [system, applicationContext, ...selectedPrior.flat(), ...(omittedCurrent ? [omitted] : []), ...first, ...retained.flat()];
    if (!fits(messages)) throw providerFailure("invalid_request", "The current correlated tool results exceeded the bounded model context.");
    return requestFor(messages);
  };

  const sendState = async (active: ActiveTurn, repository: WorkspaceRepositoryService) => {
    const state = await Effect.runPromise(repository.snapshot(active.identity));
    if (state.generation !== active.generation || (active.cancelled && state.activeTurn?.id === active.turnId)) return;
    await Effect.runPromise(active.hub.publishAgent(active.identity.id, active.generation, state, active.connectionId));
    const current = await Effect.runPromise(repository.snapshot(active.identity));
    if (!active.connected || current.generation !== active.generation || state.sequence < current.sequence || (active.cancelled && state.activeTurn?.id === active.turnId)) return;
    await Promise.race([
      active.send({ type: "agent_state", state }).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
  };

  const update = async (active: ActiveTurn, repository: WorkspaceRepositoryService, history: ReadonlyArray<ChatMessage>, status: AgentTurnRecord["status"], phase: string, options: { readonly error?: string | null; readonly proposalId?: string; readonly finished?: boolean; readonly measurement?: AgentTurnRecord["measurement"] } = {}) => {
    const serverCompletedNow = options.finished === true && !active.serverCompleted;
    if (serverCompletedNow) active.serverCompleted = true;
    await Effect.runPromise(repository.updateAgentTurn(active.identity, active.generation, active.turnId, {
      status,
      phase,
      history,
      error: options.error,
      proposalId: options.proposalId,
      finishedAt: options.finished ? new Date().toISOString() : undefined,
      measurement: options.measurement,
      serverDurationMs: serverCompletedNow ? Math.max(0, performance.now() - active.startedMonotonicMs) : undefined,
      serverMeasurement: serverCompletedNow ? "complete" : undefined,
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
    if (active.cancelled) throw new Error("cancelled");
    await ensureCurrentGeneration(active, repository);
    if (active.cancelled) throw new Error("cancelled");
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
    if (active.cancelled) throw new Error("cancelled");
    await ensureCurrentGeneration(active, repository);
    active.uiMissing ||= outcome === "missing";
    await Effect.runPromise(repository.recordApplicationAudit(active.identity, active.generation, {
      kind: "ui",
      label: operation.kind === "highlight" ? "Highlight target" : operation.kind === "navigate" ? "Open view" : "Show proposal",
      outcome,
      requestId: id,
      turnId: active.turnId,
      proposalId: operation.kind === "present_proposal" ? operation.proposalId : null,
      body: { operation: full, acknowledgement: outcome },
    }));
    await update(active, repository, history, "running", "Working");
    return outcome === "applied"
      ? { applied: true, message: operation.kind === "highlight" ? "The target is highlighted." : operation.kind === "navigate" ? "The view is open." : "The proposal is visible." }
      : { applied: false, message: "The target was not available in the initiating browser. The result is saved and can be retried." };
  };

  const ensureCurrentGeneration = async (active: ActiveTurn, repository: WorkspaceRepositoryService) => {
    const state = await Effect.runPromise(repository.snapshot(active.identity));
    if (state.generation !== active.generation) throw new Error("This workspace was reset while the turn was running.");
  };

  const releaseActive = (active: ActiveTurn) => {
    if (activeByUser.get(active.identity.id) === active) activeByUser.delete(active.identity.id);
  };

  const clearPendingCompletion = (active: ActiveTurn) => {
    const pending = completionConnections.get(active.identity.id);
    if (pending?.active !== active) return;
    clearTimeout(pending.timeout);
    completionConnections.delete(active.identity.id);
  };

  const expireCompletion = async (pending: PendingCompletion) => {
    if (completionConnections.get(pending.active.identity.id) !== pending) return;
    completionConnections.delete(pending.active.identity.id);
    pending.active.uiMissing = true;
    await update(pending.active, pending.repository, pending.history, "complete", "Complete with missing UI", { finished: true, measurement: "incomplete" }).catch(() => undefined);
    releaseActive(pending.active);
  };

  const waitForFinalRender = (active: ActiveTurn, repository: WorkspaceRepositoryService, history: ReadonlyArray<ChatMessage>) => {
    let pending: PendingCompletion;
    const timeout = setTimeout(() => { void expireCompletion(pending); }, finalAckMs);
    pending = { generation: active.generation, turnId: active.turnId, connectionId: active.connectionId, active, repository, history: [...history], timeout };
    completionConnections.set(active.identity.id, pending);
  };

  const runTurn = async (active: ActiveTurn, repository: WorkspaceRepositoryService, hub: RealtimeHubService, initial: AgentTurnRecord, viewContext: ResolvedAgentViewContext, finalView: "chat" | "audit" = "chat") => {
    let history = [...initial.history];
    const disclosures: Array<string> = [];
    let consentRequestId: string | null = null;
    try {
      const priorGroups = await Effect.runPromise(repository.agentHistories(active.identity, active.generation, active.turnId, 6));
      const system: ChatMessage = { role: "system", content: "You are the Bracken & Beam fulfilment assistant. Use only the registered tools. Never accept or commit a proposal. Prepare exact previews for the person to review. Application policy owns stock, arithmetic, permissions, and eligibility. For queue overviews, report each status total on its own line as Ready: N, Review: N, Waiting: N. Use listOrders.queueTotals for these whole-queue totals; listOrders.count describes only its filtered result. Then give one to three review orders, if any exist, each on its own line as ID: status, family. Exact recorded issue. Include only these lines, with no inferred urgency or other claims. Match each named order to its returned status; never place a ready order under review or waiting. If a filtered list has no review examples, fetch them before claiming none exist. Read individual order facts before describing issues. Independent status and family groups are not intersections; match order IDs to combine them. Omit unused filters rather than inventing filter values. Use getOrder for order IDs, evidence, and claimed prior acceptance; it reads but does not open the order. Compare its current value and flags with latestReceipt.change and committedVersion. Resolved Ready means the change was accepted but packing is pending; Completed means released to packing. After already_resolved, read getOrder and explain the recorded change; do not repeat resolution or offer Undo unasked. prepareBatch includes every eligible Ready order; no single-order packing tool exists. Undo reverses the whole receipt, never selected orders. If only one order may change, say the current controls cannot do that; never suggest batch then Undo. Prepare a batch only for an explicit full-batch preview, and leave acceptance to the person. To show or highlight order evidence, first navigate to the order view with its orderId, then highlight orderEvidence after navigation succeeds. Never claim a UI operation succeeded when its result says ok: false. Use classifyNote only for actual customer or operator note text, never for an ID or a request to find an order. Use checkConsent to assess an order's customer consent. For teaching requests, inspect the task and start the matching available tutorial: address-correction, substitution-review, or batch-approval. Prepare tools show the review automatically; the application acknowledges a displayed proposal, so do not request another narration step. Keep answers concise. A work item named in the latest user message overrides the selected application context. If a tool reports a missing UI target or another recoverable result, say what remains available. The application displays validated consent evidence and every returned alternative directly; do not repeat them unless the person asks." };
      const applicationContext: ChatMessage = { role: "system", content: `${contextPrefix}${JSON.stringify(viewContext)}` };
      for (let round = 0; round < maximumToolRounds; round += 1) {
        if (active.cancelled) throw new Error("cancelled");
        await ensureCurrentGeneration(active, repository);
        await update(active, repository, history, "running", round === 0 ? "Thinking" : "Checking results");
        if (active.cancelled) throw new Error("cancelled");
        await ensureCurrentGeneration(active, repository);
        if (active.cancelled) throw new Error("cancelled");
        const request = boundedRequest(system, applicationContext, priorGroups, history);
        const result = await providerResult(active, runAuditedMinistral({
          repository, identity: active.identity, generation: active.generation,
          requestId: `${active.turnId}:chat:${round + 1}`, turnId: active.turnId,
          mode: config.agentMode,
          notify: (userId, attempt) => hub.publishAudit(userId, attempt),
        }, adapters.ministral, request));
        if (!result.ok) throw result.error;
        if (active.cancelled) throw new Error("cancelled");
        await ensureCurrentGeneration(active, repository);
        const returnedContent = result.value.content.trim();
        const finalContent = result.value.toolCalls.length === 0 && disclosures.length > 0
          ? `${disclosures.join(" ")} ${returnedContent}`.trim()
          : result.value.content;
        const assistant: ChatMessage = { role: "assistant", content: finalContent || null, ...(result.value.toolCalls.length === 0 ? {} : { toolCalls: result.value.toolCalls }) };
        history.push(assistant);
        if (result.value.toolCalls.length === 0) {
          if (returnedContent.length === 0) throw new Error("The provider returned no final answer.");
          const content = finalContent.trim();
          if (!active.uiMissing) waitForFinalRender(active, repository, history);
          await update(
            active,
            repository,
            history,
            active.uiMissing ? "complete" : "waiting_for_ui",
            active.uiMissing ? "Complete with missing UI" : finalView === "audit" ? "Rendering Audit result" : "Rendering answer",
            { finished: true, ...(active.uiMissing ? { measurement: "incomplete" as const } : {}) },
          );
          return consentRequestId;
        }
        if (result.value.toolCalls.length > maximumCallsPerRound) throw new Error("The provider requested too many tools in one round.");
        let displayedProposal = false;
        const toolFailures: Array<string> = [];
        for (const call of result.value.toolCalls) {
          if (active.cancelled) throw new Error("cancelled");
          await ensureCurrentGeneration(active, repository);
          if (active.cancelled) throw new Error("cancelled");
          const tool = findRegisteredTool(registry, call.name);
          let content: string;
          let output: unknown = null;
          let providerError: ProviderError | null = null;
          if (tool === null) {
            content = safeToolFailure(new ToolExecutionError("unknown_tool", `Unknown tool: ${call.name}`));
          } else {
            try {
              output = await tool.execute({
                repository, identity: active.identity, generation: active.generation,
                turnId: active.turnId, requestId: call.id,
                runJev: async (jevRequest: JevRequest) => {
                  if (active.cancelled) throw new Error("cancelled");
                  await ensureCurrentGeneration(active, repository);
                  if (active.cancelled) throw new Error("cancelled");
                  active.jevCount += 1;
                  const jev = await providerResult(active, runAuditedJev({
                    repository, identity: active.identity, generation: active.generation,
                    requestId: `${active.turnId}:jev:${active.jevCount}`, turnId: active.turnId,
                    mode: config.agentMode,
                    notify: (userId, attempt) => hub.publishAudit(userId, attempt),
                  }, adapters.jev, jevRequest));
                  if (!jev.ok) throw jev.error;
                  await ensureCurrentGeneration(active, repository);
                  return jev.value;
                },
                requestUi: async (operation) => {
                  const acknowledgement = await requestUi(active, repository, history, operation);
                  if (operation.kind === "navigate" || operation.kind === "present_proposal") {
                    displayedProposal = operation.kind === "present_proposal" && acknowledgement.applied;
                  }
                  return acknowledgement;
                },
              }, call.arguments);
              if (active.cancelled) throw new Error("cancelled");
              await ensureCurrentGeneration(active, repository);
              if (call.name === "checkConsent") {
                consentRequestId = `${active.turnId}:jev:${active.jevCount}`;
                const disclosure = consentDisclosure(output);
                if (disclosure !== null && !disclosures.includes(disclosure)) disclosures.push(disclosure);
              }
              content = safeToolResult(call.name, output);
            } catch (error) {
              if (active.cancelled || (error instanceof Error && error.message === "cancelled")) throw error;
              content = safeToolFailure(error);
              if (isProviderError(error)) providerError = error;
            }
          }
          const payload = JSON.parse(content) as { ok: boolean; error?: { message?: string }; result?: { ok?: boolean; message?: string } };
          if (!payload.ok || payload.result?.ok === false) toolFailures.push(`${call.name}: ${payload.error?.message ?? payload.result?.message ?? "The tool failed."}`);
          history.push({ role: "tool", content, toolCallId: call.id });
          let auditedResult: unknown = content;
          try { auditedResult = JSON.parse(content); } catch { /* The bounded text still records the terminal tool outcome. */ }
          const proposalId = typeof output === "object" && output !== null && "id" in output && typeof (output as { id?: unknown }).id === "string" && (output as { id: string }).id.startsWith("proposal_")
            ? (output as { id: string }).id
            : null;
          await Effect.runPromise(repository.recordApplicationAudit(active.identity, active.generation, {
            kind: "tool",
            label: tool === null ? call.name : tool.purpose,
            outcome: providerError === null && typeof auditedResult === "object" && auditedResult !== null && (auditedResult as { ok?: unknown }).ok !== false ? "completed" : "failed",
            requestId: call.id,
            turnId: active.turnId,
            proposalId,
            body: { ...(proposalId === null ? {} : { state: "prepared" }), tool: call.name, arguments: call.arguments, result: auditedResult },
          }));
          await update(active, repository, history, "running", "Working");
          if (providerError !== null) throw providerError;
        }
        if (displayedProposal) {
          if (active.cancelled) throw new Error("cancelled");
          await ensureCurrentGeneration(active, repository);
          const acknowledgement = "The proposal is ready for your review. Nothing changes until you accept it.";
          history.push({ role: "assistant", content: [...disclosures, acknowledgement, ...toolFailures, ...(active.uiMissing ? ["Some requested UI could not be displayed."] : [])].join(" ") });
          const failed = toolFailures.length > 0;
          if (!failed && !active.uiMissing) waitForFinalRender(active, repository, history);
          await update(active, repository, history, failed ? "failed" : active.uiMissing ? "complete" : "waiting_for_ui",
            failed ? "Failed" : active.uiMissing ? "Complete with missing UI" : finalView === "audit" ? "Rendering Audit result" : "Rendering answer",
            { finished: true, ...(failed ? { error: toolFailures.join(" ") } : {}), ...(failed || active.uiMissing ? { measurement: "incomplete" as const } : {}) });
          return consentRequestId;
        }
      }
      throw new Error("The turn reached the eight-request tool limit.");
    } catch (error) {
      clearPendingCompletion(active);
      if (active.cancelled || (error instanceof Error && error.message === "cancelled")) {
        const message = `${disclosures.join(" ")} Cancelled. Any proposal already shown is still available for your review.`.trim();
        history.push({ role: "assistant", content: message });
        await update(active, repository, history, "cancelled", "Cancelled", { finished: true, measurement: "incomplete" }).catch(() => undefined);
      } else {
        const failure = error instanceof Error && error.message.includes("reset")
          ? "This turn stopped because the workspace was reset."
          : isProviderError(error) && error.code === "credits_exhausted"
            ? "This turn stopped because the prepaid model credits are exhausted. No further model requests were made."
            : "I could not complete that turn. You can retry it, and any proposal already shown is still available for review.";
        const message = `${disclosures.join(" ")} ${failure}`.trim();
        history.push({ role: "assistant", content: message });
        await update(active, repository, history, "failed", "Failed", { error: message, finished: true, measurement: "incomplete" }).catch(() => undefined);
      }
    } finally {
      if (completionConnections.get(active.identity.id)?.active !== active) releaseActive(active);
      for (const pending of active.operations.values()) pending.resolve("missing");
      active.operations.clear();
    }
  };

  return {
    registry,
    runExploreScenario: async (context: ExploreScenarioStartContext): Promise<{ readonly started: true }> => {
      const current = activeByUser.get(context.identity.id);
      if (current !== undefined) throw new Error("Wait for the current turn to finish or cancel it first.");
      const pendingAdmission = admissionsByUser.get(context.identity.id);
      if (pendingAdmission !== undefined) throw new Error("Wait for the current turn to finish or cancel it first.");
      let releaseAdmission: () => void = () => {};
      const admission: Admission = {
        turnId: context.turnId,
        done: new Promise<void>((resolve) => { releaseAdmission = resolve; }),
        release: () => releaseAdmission(),
      };
      admissionsByUser.set(context.identity.id, admission);
      const startedMonotonicMs = performance.now();
      let active: ActiveTurn | null = null;
      try {
        const created = await Effect.runPromise(context.repository.createAgentTurn(
          context.identity,
          context.generation,
          context.turnId,
          context.requestId,
          context.connectionId,
          exploreScenarios.find((scenario) => scenario.id === "consent")!.prompt,
        ));
        if (!created.created) throw new Error("That Explore scenario was already started.");
        active = {
          key: `${context.identity.id}:${context.generation}:${context.turnId}`,
          identity: context.identity,
          generation: context.generation,
          turnId: context.turnId,
          requestId: context.requestId,
          connectionId: context.connectionId,
          send: context.send,
          hub: context.hub,
          connected: true,
          cancelled: false,
          providerFiber: null,
          jevCount: 0,
          uiMissing: false,
          startedMonotonicMs,
          serverCompleted: false,
          operations: new Map(),
        };
        activeByUser.set(context.identity.id, active);
        await context.send({ type: "agent_state", state: await Effect.runPromise(context.repository.snapshot(context.identity)) });
        const admitted = active;
        void (async () => {
          try {
            const viewContext = await Effect.runPromise(context.repository.resolveAgentViewContext(context.identity, context.generation, { view: "explore", focus: null }));
            const consentRequestId = await runTurn(admitted, context.repository, context.hub, created.turn, viewContext, "audit");
            const turn = await Effect.runPromise(context.repository.agentTurn(context.identity, context.generation, context.turnId));
            if (admitted.cancelled || turn?.status === "cancelled") throw new Error("cancelled");
            const attempts = await Effect.runPromise(context.repository.providerAttempts(context.identity, 1, consentRequestId == null ? { turnId: context.turnId } : { requestId: consentRequestId }));
            const attempt = attempts[0];
            if (attempt === undefined) throw new Error("The scenario did not produce an inference trace.");
            const completed = consentRequestId != null && turn?.status === "waiting_for_ui" && turn.phase === "Rendering Audit result";
            const message = completed ? "The consent result is available in Audit." : "The consent scenario did not complete. Inspect its recorded results in Audit.";
            if (!completed) {
              clearPendingCompletion(admitted);
              await update(admitted, context.repository, turn?.history ?? created.turn.history, "failed", "Failed", { error: message, finished: true, measurement: "incomplete" });
              releaseActive(admitted);
            }
            const result: ExploreScenarioLaunch = { scenario: "consent", outcome: completed ? "completed" : "failed", attemptId: attempt.id, turnId: context.turnId, message };
            await context.send({
              type: "command_result",
              requestId: context.requestId,
              result: { kind: "explore", ...result },
              state: await Effect.runPromise(context.repository.snapshot(context.identity)),
            });
          } catch (cause) {
            clearPendingCompletion(admitted);
            const cancelled = admitted.cancelled || (cause instanceof Error && cause.message === "cancelled");
            const message = cancelled ? "Cancelled. The consent check did not change any work." : cause instanceof Error ? cause.message : "The consent check failed.";
            const history = await Effect.runPromise(context.repository.agentTurn(context.identity, context.generation, context.turnId)).then((turn) => turn?.history ?? []).catch(() => []);
            await update(admitted, context.repository, [...history, { role: "assistant", content: message }], cancelled ? "cancelled" : "failed", cancelled ? "Cancelled" : "Failed", { error: cancelled ? null : message, finished: true, measurement: "incomplete" }).catch(() => undefined);
            releaseActive(admitted);
            await context.send({ type: "error", requestId: context.requestId, code: cancelled ? "explore_scenario_cancelled" : "explore_scenario_failed", message }).catch(() => undefined);
          }
        })();
        return { started: true };
      } catch (cause) {
        if (active !== null) {
          clearPendingCompletion(active);
          const cancelled = active.cancelled || (cause instanceof Error && cause.message === "cancelled");
          const message = cancelled ? "Cancelled. The consent check did not change any work." : cause instanceof Error ? cause.message : "The consent check failed.";
          const history = await Effect.runPromise(context.repository.agentTurn(context.identity, context.generation, context.turnId)).then((turn) => turn?.history ?? []).catch(() => []);
          await update(active, context.repository, [...history, { role: "assistant", content: message }], cancelled ? "cancelled" : "failed", cancelled ? "Cancelled" : "Failed", { error: cancelled ? null : message, finished: true, measurement: "incomplete" }).catch(() => undefined);
          releaseActive(active);
        }
        throw cause;
      } finally {
        if (admissionsByUser.get(context.identity.id) === admission) admissionsByUser.delete(context.identity.id);
        admission.release();
      }
    },
    start: async (context: AgentStartContext) => {
      const current = activeByUser.get(context.identity.id);
      if (current !== undefined) {
        if (current.turnId !== context.turnId || current.generation !== context.generation) throw new Error("Wait for the current turn to finish or cancel it first.");
        const turn = await Effect.runPromise(context.repository.agentTurn(context.identity, context.generation, context.turnId));
        if (turn === null) throw new Error("The active turn is not available.");
        await context.send({ type: "agent_state", state: await Effect.runPromise(context.repository.snapshot(context.identity)) });
        return { started: false, turn };
      }
      const pendingAdmission = admissionsByUser.get(context.identity.id);
      if (pendingAdmission !== undefined) {
        if (pendingAdmission.turnId !== context.turnId) throw new Error("Wait for the current turn to finish or cancel it first.");
        await pendingAdmission.done;
        const turn = await Effect.runPromise(context.repository.agentTurn(context.identity, context.generation, context.turnId));
        if (turn === null) throw new Error("The earlier attempt did not start this turn. You can retry it.");
        await context.send({ type: "agent_state", state: await Effect.runPromise(context.repository.snapshot(context.identity)) });
        return { started: false, turn };
      }
      let releaseAdmission: () => void = () => {};
      const admission: Admission = {
        turnId: context.turnId,
        done: new Promise<void>((resolve) => { releaseAdmission = resolve; }),
        release: () => releaseAdmission(),
      };
      admissionsByUser.set(context.identity.id, admission);
      const startedMonotonicMs = performance.now();
      let active: ActiveTurn | null = null;
      try {
        const existing = await Effect.runPromise(context.repository.agentTurn(context.identity, context.generation, context.turnId));
        if (existing !== null) {
          await context.send({ type: "agent_state", state: await Effect.runPromise(context.repository.snapshot(context.identity)) });
          return { started: false, turn: existing };
        }
        const viewContext = await Effect.runPromise(context.repository.resolveAgentViewContext(context.identity, context.generation, context.viewContext));
        const created = await Effect.runPromise(context.repository.createAgentTurn(context.identity, context.generation, context.turnId, context.requestId, context.connectionId, context.message));
        if (!created.created) {
          await context.send({ type: "agent_state", state: await Effect.runPromise(context.repository.snapshot(context.identity)) });
          return { started: false, turn: created.turn };
        }
        active = { key: `${context.identity.id}:${context.generation}:${context.turnId}`, identity: context.identity, generation: context.generation, turnId: context.turnId, requestId: context.requestId, connectionId: context.connectionId, send: context.send, hub: context.hub, connected: true, cancelled: false, providerFiber: null, jevCount: 0, uiMissing: false, startedMonotonicMs, serverCompleted: false, operations: new Map() };
        activeByUser.set(context.identity.id, active);
        try {
          await context.send({ type: "agent_state", state: await Effect.runPromise(context.repository.snapshot(context.identity)) });
        } catch (error) {
          active.connected = false;
          const message = "I could not start that turn because its initiating browser was unavailable. You can retry it.";
          await update(active, context.repository, [...created.turn.history, { role: "assistant", content: message }], "failed", "Failed", { error: message, finished: true, measurement: "incomplete" }).catch(() => undefined);
          releaseActive(active);
          throw error;
        }
        void runTurn(active, context.repository, context.hub, created.turn, viewContext);
        return { started: true, turn: created.turn };
      } finally {
        if (admissionsByUser.get(context.identity.id) === admission) admissionsByUser.delete(context.identity.id);
        admission.release();
      }
    },
    cancel: async (repository: WorkspaceRepositoryService, identity: RequestIdentity, generation: number, turnId: string) => {
      const active = activeByUser.get(identity.id);
      if (active === undefined || active.turnId !== turnId || active.generation !== generation) return false;
      const completion = completionConnections.get(identity.id);
      if (completion?.active === active) {
        clearPendingCompletion(active);
        active.uiMissing = true;
        await update(active, repository, completion.history, "complete", "Complete with missing UI", { finished: true, measurement: "incomplete" }).catch(() => undefined);
        releaseActive(active);
        return true;
      }
      active.cancelled = true;
      if (active.providerFiber !== null) Effect.runFork(Fiber.interrupt(active.providerFiber));
      for (const operation of active.operations.values()) operation.resolve("missing");
      return true;
    },
    cancelGeneration: async (identity: RequestIdentity, generation: number) => {
      const completion = completionConnections.get(identity.id);
      const removedCompletion = completion?.generation === generation;
      if (removedCompletion && completion !== undefined) {
        clearTimeout(completion.timeout);
        completionConnections.delete(identity.id);
        releaseActive(completion.active);
      }
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
      clearTimeout(completion.timeout);
      completionConnections.delete(identity.id);
      releaseActive(completion.active);
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
      const completion = completionConnections.get(identity.id);
      if (completion?.connectionId === connectionId) {
        clearTimeout(completion.timeout);
        completionConnections.delete(identity.id);
        releaseActive(completion.active);
      }
      const active = activeByUser.get(identity.id);
      if (active?.connectionId !== connectionId) return;
      active.connected = false;
      active.uiMissing = true;
      for (const operation of active.operations.values()) operation.resolve("missing");
    },
  };
};

export type AgentCoordinator = ReturnType<typeof makeAgentCoordinator>;
