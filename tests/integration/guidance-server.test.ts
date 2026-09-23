import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeAgentCoordinator, isGuidanceToolAllowed } from "../../src/server/agent-runtime";
import type { ServerConfig } from "../../src/server/config";
import { resolveIdentity } from "../../src/server/identity";
import { runWithWorkspaceRepository, WorkspaceRepository, type AgentTurnRecord, type WorkspaceRepositoryService } from "../../src/server/persistence";
import type { JevAdapter, MinistralAdapter, MinistralResult } from "../../src/server/providers/contracts";
import { providerFailure } from "../../src/server/providers/http";
import type { RealtimeHubService } from "../../src/server/realtime";
import type { ServerMessage } from "../../src/shared/contracts";
import { workGuidanceTargets } from "../../src/modules/guidance";

const paths: string[] = [];
const config: ServerConfig = { environment: "test", host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", databasePath: ":memory:", allowDevelopmentIdentity: true, developmentEmail: "guide@example.test", agentMode: "scripted", openRouterApiKey: null };
const identity = (email: string) => Effect.runSync(resolveIdentity(["Cf-Access-Authenticated-User-Email", email], config));
const workspace = async () => { const directory = await mkdtemp(join(tmpdir(), "parcel-guidance-server-")); paths.push(directory); return join(directory, "workspace.sqlite"); };
const useRepository = <A>(filename: string, run: (repository: WorkspaceRepositoryService) => Effect.Effect<A, unknown>) => runWithWorkspaceRepository(filename, Effect.flatMap(WorkspaceRepository, run));
const hub = { publishAudit: () => Effect.void, publishAgent: () => Effect.void } as unknown as RealtimeHubService;
const jev: JevAdapter = { decide: () => Effect.fail(providerFailure("provider_error", "Jev was not expected.")) };
const response = (toolCalls: MinistralResult["toolCalls"], content = ""): MinistralResult => ({
  kind: "chat", content, toolCalls, finishReason: toolCalls.length === 0 ? "stop" : "tool_calls",
  metadata: { provider: "Scripted", requestedModel: "mistralai/ministral-3b-2512", actualModel: "scripted/test", providerRequestId: null, generationId: null, requestBytes: 10, responseBytes: 10, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 } },
  safeRequest: {}, safeResponse: { content, toolCalls },
});
const waitForTurn = async (repository: WorkspaceRepositoryService, user: ReturnType<typeof identity>, turnId: string): Promise<AgentTurnRecord> => {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const turn = await Effect.runPromise(repository.agentTurn(user, 1, turnId));
    if (turn?.status === "waiting_for_ui" || turn?.status === "failed" || turn?.status === "complete") return turn;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Guidance turn did not finish.");
};

afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("server guidance", () => {
  it("returns a server-owned conflict from the transaction that rejects a stale order review", async () => {
    const filename = await workspace();
    const owner = identity("stale-order@example.test");
    const other = identity("other@example.test");
    const proposal = await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(owner);
      yield* repository.snapshot(other);
      const stale = yield* repository.prepareResolution(owner, 1, "BB-1042");
      const accepted = yield* repository.prepareResolution(owner, 1, "BB-1042");
      yield* repository.accept(owner, 1, accepted.id, "accepted-guide-key");
      return stale;
    }));
    await expect(useRepository(filename, (repository) => repository.accept(owner, 1, proposal.id, "stale-guide-key"))).rejects.toMatchObject({
      code: "stale_proposal",
      detail: { kind: "stale_review", proposalId: proposal.id, orderId: "BB-1042", reason: "order_changed", expectedVersion: 1, currentVersion: 2, resolved: true },
    });
    await expect(useRepository(filename, (repository) => repository.resolveGuidanceProblem(other, 1, proposal.id))).rejects.toMatchObject({ code: "invalid_guidance_context" });
    expect(await useRepository(filename, (repository) => repository.resolveGuidanceProblem(owner, 1, proposal.id))).toMatchObject({ orderId: "BB-1042", resolved: true });
    const state = await useRepository(filename, (repository) => repository.snapshot(owner));
    expect(state.orders.find((order) => order.id === "BB-1042")).toMatchObject({ version: 2, resolved: true });
  });

  it("maps changed stock to an order from the stored review policies", async () => {
    const filename = await workspace();
    const owner = identity("stale-stock@example.test");
    const proposal = await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(owner);
      const prepared = yield* repository.prepareResolution(owner, 1, "BB-1051");
      yield* repository.advanceScenario(owner, 1);
      return prepared;
    }));
    await expect(useRepository(filename, (repository) => repository.accept(owner, 1, proposal.id, "stale-stock-key"))).rejects.toMatchObject({
      code: "stale_proposal",
      detail: { kind: "stale_review", proposalId: proposal.id, orderId: "BB-1051", reason: "stock_changed", resolved: false },
    });
    const state = await useRepository(filename, (repository) => repository.snapshot(owner));
    expect(state.orders.find((order) => order.id === "BB-1051")?.version).toBe(1);
  });

  it("exposes only bounded guidance tools and denies injected write and direct navigation calls", async () => {
    const filename = await workspace();
    const owner = identity("guide-tools@example.test");
    const stale = await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(owner);
      const stale = yield* repository.prepareResolution(owner, 1, "BB-1042");
      const accepted = yield* repository.prepareResolution(owner, 1, "BB-1042");
      yield* repository.accept(owner, 1, accepted.id, "guide-tool-accept-key");
      return stale;
    }));
    const requests: string[][] = [];
    const ministral: MinistralAdapter = { complete: (request) => Effect.sync(() => {
      requests.push(request.tools?.map((tool) => tool.name) ?? []);
      return request.messages.at(-1)?.role === "tool"
        ? response([], "This review changed. I can guide you through the current item.")
        : response([
            { id: "prepare", name: "prepareReset", arguments: {} },
            { id: "navigate", name: "navigate", arguments: { view: "audit" } },
            { id: "read", name: "readGuidanceContext", arguments: {} },
          ]);
    }) };
    await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const coordinator = makeAgentCoordinator(config, { ministral, jev });
      const sent: ServerMessage[] = [];
      const turnId = "turn_guidance-denial-12345678";
      yield* Effect.promise(() => coordinator.start({ repository, hub, identity: owner, generation: 1, turnId, requestId: "guide-denial", message: "Help with the changed review", viewContext: { view: "work", focus: null, guidance: { problem: { kind: "stale_review", proposalId: stale.id }, visibleTargetIds: [] } }, connectionId: "guide-connection", send: async (message) => { sent.push(message); } }));
      const turn = yield* Effect.promise(() => waitForTurn(repository, owner, turnId));
      expect(turn.status).toBe("waiting_for_ui");
      expect(requests).toHaveLength(2);
      expect(requests.every((names) => names.every(isGuidanceToolAllowed))).toBe(true);
      expect(requests[0]).toEqual(expect.arrayContaining(["readGuidanceContext", "findGuides", "offerGuide", "showNote"]));
      expect(requests[0]).not.toEqual(expect.arrayContaining(["prepareReset", "navigate", "startTutorial"]));
      const toolMessages = turn.history.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as { error?: { code: string } });
      expect(toolMessages.filter((message) => message.error?.code === "forbidden_tool")).toHaveLength(2);
      expect(sent.some((message) => message.type === "agent_ui_operation")).toBe(false);
      expect((yield* repository.snapshot(owner)).currentProposal?.id).toBe(stale.id);
    }));
  });

  it("routes scripted guidance to the initiating browser and returns current context after a stale acknowledgement", async () => {
    const filename = await workspace();
    const owner = identity("guide-scripted@example.test");
    const stale = await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(owner);
      const stale = yield* repository.prepareResolution(owner, 1, "BB-1042");
      const accepted = yield* repository.prepareResolution(owner, 1, "BB-1042");
      yield* repository.accept(owner, 1, accepted.id, "guide-scripted-accept-key");
      return stale;
    }));
    await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const coordinator = makeAgentCoordinator(config);
      const sent: ServerMessage[] = [];
      const turnId = "turn_guidance-scripted-12345678";
      let offered = 0;
      yield* Effect.promise(() => coordinator.start({
        repository, hub, identity: owner, generation: 1, turnId, requestId: "guide-scripted", message: "Help me with this changed review",
        viewContext: { view: "work", focus: null, guidance: { problem: { kind: "stale_review", proposalId: stale.id }, visibleTargetIds: [workGuidanceTargets.orderRow("BB-1042")] } },
        connectionId: "first-browser", send: async (message) => {
          sent.push(message);
          if (message.type === "agent_ui_operation") {
            expect(coordinator.acknowledgeUi(owner, 1, turnId, message.operation.id, "second-browser", "applied")).toBe(false);
            if (message.operation.kind === "offer_guide") offered += 1;
            expect(coordinator.acknowledgeUi(owner, 1, turnId, message.operation.id, "first-browser", message.operation.kind === "offer_guide" && offered === 1 ? "stale_context" : "applied", message.operation.kind === "offer_guide" && offered === 1 ? { view: "audit", focus: null, guidance: { visibleTargetIds: [] } } : undefined)).toBe(true);
          }
        },
      }));
      const turn = yield* Effect.promise(() => waitForTurn(repository, owner, turnId));
      expect(turn.status).toBe("complete");
      const operations = sent.filter((message): message is Extract<ServerMessage, { readonly type: "agent_ui_operation" }> => message.type === "agent_ui_operation").map((message) => message.operation);
      const readContext = turn.history.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as { result?: { targets?: ReadonlyArray<{ mounted: boolean; label: string }>; guides?: ReadonlyArray<{ entityId: string | null; title: string }> } }).find((message) => message.result?.targets !== undefined);
      expect(readContext?.result?.targets?.filter((target) => target.mounted)).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Affected item in Work" })]));
      expect(readContext?.result?.guides?.[0]).toMatchObject({ entityId: "BB-1042" });
      const discovered = turn.history.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as { result?: { guides?: ReadonlyArray<{ entityId: string | null }> } }).find((message) => message.result?.guides !== undefined);
      expect(discovered?.result?.guides?.[0]).toMatchObject({ entityId: "BB-1042" });
      expect(operations.map((operation) => operation.kind)).toEqual(["offer_guide", "offer_guide"]);
      const offers = operations.filter((operation): operation is Extract<(typeof operations)[number], { readonly kind: "offer_guide" }> => operation.kind === "offer_guide");
      expect(offers).toHaveLength(2);
      expect(offers[1]?.contextRef).not.toBe(offers[0]?.contextRef);
      expect(operations.every((operation) => operation.turnId === turnId && operation.generation === 1)).toBe(true);
      expect(turn.history.at(-1)?.content).toContain("Show me");
      const toolResults = turn.history.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as { result?: { kind?: string; currentContext?: { view?: string } } });
      expect(toolResults).toEqual(expect.arrayContaining([expect.objectContaining({ result: expect.objectContaining({ kind: "stale_context", currentContext: expect.objectContaining({ view: "audit" }) }) })]));
      expect((yield* repository.snapshot(owner)).currentProposal?.id).toBe(stale.id);
    }));
  });

  it("shows a note only at a registered target in the current context", async () => {
    const filename = await workspace();
    const owner = identity("guide-note@example.test");
    const stale = await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(owner);
      const stale = yield* repository.prepareResolution(owner, 1, "BB-1042");
      const accepted = yield* repository.prepareResolution(owner, 1, "BB-1042");
      yield* repository.accept(owner, 1, accepted.id, "guide-note-accept-key");
      return stale;
    }));
    await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const coordinator = makeAgentCoordinator(config);
      const operations: Array<Extract<ServerMessage, { readonly type: "agent_ui_operation" }>["operation"]> = [];
      const turnId = "turn_guidance-note-12345678";
      yield* Effect.promise(() => coordinator.start({
        repository, hub, identity: owner, generation: 1, turnId, requestId: "guide-note", message: "Explain this changed review",
        viewContext: { view: "work", focus: null, guidance: { problem: { kind: "stale_review", proposalId: stale.id }, visibleTargetIds: [workGuidanceTargets.orderRow("BB-1042")] } },
        connectionId: "note-browser", send: async (message) => {
          if (message.type === "agent_ui_operation") {
            operations.push(message.operation);
            expect(coordinator.acknowledgeUi(owner, 1, turnId, message.operation.id, "note-browser", "applied")).toBe(true);
          }
        },
      }));
      expect((yield* Effect.promise(() => waitForTurn(repository, owner, turnId))).status).toBe("waiting_for_ui");
      expect(operations.map((operation) => operation.kind)).toEqual(expect.arrayContaining(["offer_guide", "show_note"]));
      const note = operations.find((operation): operation is Extract<(typeof operations)[number], { readonly kind: "show_note" }> => operation.kind === "show_note");
      expect(note?.note).toMatchObject({ targetId: workGuidanceTargets.orderRow("BB-1042"), entityId: "BB-1042" });
    }));
  });
});
