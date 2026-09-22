import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditAttemptDetail, ServerMessage } from "../../src/shared/contracts";
import type { ServerConfig } from "../../src/server/config";
import { resolveIdentity, type RequestIdentity } from "../../src/server/identity";
import {
  runWithWorkspaceRepository,
  WorkspaceRepository,
  workspacePersistenceLayer,
} from "../../src/server/persistence";
import {
  runAuditedMinistral,
  type MinistralAdapter,
  type MinistralResult,
} from "../../src/server/providers";
import { makeMinistralAdapter } from "../../src/server/providers/ministral";
import { RealtimeHub, realtimeHubLayer } from "../../src/server/realtime";

const paths: Array<string> = [];
const config: ServerConfig = {
  environment: "production",
  host: "127.0.0.1",
  port: 0,
  publicOrigin: "https://parcel.example.test",
  databasePath: ":memory:",
  allowDevelopmentIdentity: false,
  developmentEmail: null,
  agentMode: "unavailable",
  openRouterApiKey: null,
};
const identity = (email: string): RequestIdentity =>
  Effect.runSync(resolveIdentity(["Cf-Access-Authenticated-User-Email", email], config));
const workspace = async () => {
  const directory = await mkdtemp(join(tmpdir(), "parcel-hopscotch-provider-"));
  paths.push(directory);
  return join(directory, "workspace.sqlite");
};

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const result = (overrides: Partial<MinistralResult["metadata"]> = {}): MinistralResult => ({
  kind: "chat",
  content: "done",
  toolCalls: [],
  finishReason: "stop",
  metadata: {
    provider: "Mistral",
    requestedModel: "mistralai/ministral-3b-2512",
    actualModel: "mistralai/ministral-3b-2512",
    providerRequestId: "provider-request",
    generationId: "generation-id",
    requestBytes: 12,
    responseBytes: 34,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: null },
    ...overrides,
  },
  safeRequest: { messages: [{ role: "user", content: "safe" }] },
  safeResponse: { content: "done" },
});

const chatRequest = { messages: [{ role: "user" as const, content: "Check order BB-1042." }] };

describe("provider attempt audit", () => {
  it("records a successful attempt for its internal owner and excludes credentials and login identity", async () => {
    const filename = await workspace();
    const owner = identity("audit-owner@example.test");
    const other = identity("audit-other@example.test");
    const key = "synthetic-secret-key-canary";
    let sentBody = "";
    const stream = [
      `data: ${JSON.stringify({ id: "p1", model: "mistralai/ministral-3b-2512", provider: "Mistral", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ id: "p1", model: "mistralai/ministral-3b-2512", provider: "Mistral", choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}`,
      "data: [DONE]",
      "",
      "",
    ].join("\n\n");
    const adapter = makeMinistralAdapter({ apiKey: key }, async (_url, init) => {
      sentBody = String(init?.body ?? "");
      return new Response(stream);
    });

    const records = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const state = yield* repository.snapshot(owner);
      yield* repository.snapshot(other);
      yield* runAuditedMinistral(
        { repository, identity: owner, generation: state.generation, requestId: "audit-success", turnId: "turn-success" },
        adapter,
        chatRequest,
      );
      const ownerRows = yield* repository.providerAttempts(owner);
      return {
        owner: ownerRows,
        detail: ownerRows[0] === undefined ? null : yield* repository.providerAttempt(owner, ownerRows[0].id),
        other: yield* repository.providerAttempts(other),
      };
    }));

    expect(records.owner).toHaveLength(1);
    expect(records.owner[0]).toMatchObject({
      userId: owner.id,
      generation: 1,
      outcome: "success",
      provider: "Mistral",
      inputTokens: 4,
      outputTokens: 1,
      costUsd: null,
      retryCount: 0,
    });
    expect(records.owner[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(records.owner[0]).not.toHaveProperty("request");
    expect(records.owner[0]).not.toHaveProperty("response");
    expect(records.detail).toMatchObject({ request: expect.any(Object), response: expect.any(Object) });
    expect(records.other).toEqual([]);
    expect(sentBody).not.toContain(key);
    expect(sentBody).not.toContain("audit-owner@example.test");
    expect(JSON.stringify(records)).not.toContain(key);
    expect(JSON.stringify(records)).not.toContain("audit-owner@example.test");
  });

  it("finalizes exhausted credits once without retrying and keeps unknown billing unknown", async () => {
    const filename = await workspace();
    const owner = identity("credits@example.test");
    let calls = 0;
    const adapter = makeMinistralAdapter({ apiKey: "synthetic-key" }, async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: 402, message: "No credits" } }), { status: 402 });
    });
    const attempts = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const state = yield* repository.snapshot(owner);
      yield* Effect.result(runAuditedMinistral(
        { repository, identity: owner, generation: state.generation, requestId: "credits", turnId: "turn-credits" },
        adapter,
        chatRequest,
      ));
      return yield* repository.providerAttempts(owner);
    }));
    expect(calls).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "credits_exhausted", costUsd: null, retryCount: 0, errorCode: "credits_exhausted" });
  });

  it("persists known charged usage on invalid output and redacts provider metadata", async () => {
    const filename = await workspace();
    const owner = identity("charged@example.test");
    const providerCanary = "Bearer provider-secret";
    const modelCanary = "model-login@example.test";
    const idCanary = "sk-or-v1-provider-id-secret";
    const stream = [
      `data: ${JSON.stringify({
        id: idCanary,
        model: modelCanary,
        provider: providerCanary,
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.00077 },
      })}`,
      "data: [DONE]",
      "",
      "",
    ].join("\n\n");
    const adapter = makeMinistralAdapter({ apiKey: "synthetic-key" }, async () =>
      new Response(stream, { headers: { "x-generation-id": "generation-login@example.test" } }));
    const records = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const state = yield* repository.snapshot(owner);
      yield* Effect.result(runAuditedMinistral(
        { repository, identity: owner, generation: state.generation, requestId: "charged-login@example.test", turnId: "turn-sk-or-v1-danger" },
        adapter,
        chatRequest,
      ));
      const summaries = yield* repository.providerAttempts(owner);
      return {
        summary: summaries[0],
        detail: summaries[0] === undefined ? null : yield* repository.providerAttempt(owner, summaries[0].id),
      };
    }));
    expect(records.summary).toMatchObject({
      outcome: "error",
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      costUsd: 0.00077,
      errorCode: "incomplete_response",
    });
    expect(records.detail?.response).toMatchObject({ usage: { costUsd: 0.00077 } });
    const serialized = JSON.stringify(records);
    for (const canary of [providerCanary, modelCanary, idCanary, "charged-login@example.test", "sk-or-v1-danger"]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("redacts sensitive fields nested in serialized chat history before persistence", async () => {
    const filename = await workspace();
    const owner = identity("serialized-history@example.test");
    const passwordCanary = "synthetic-password-canary";
    const cookieCanary = "synthetic-cookie-canary";
    const requestWithHistory = {
      messages: [
        { role: "user" as const, content: "Check the order." },
        { role: "assistant" as const, content: null, toolCalls: [{ id: "call-1", name: "getOrder", arguments: { password: passwordCanary } }] },
        { role: "tool" as const, toolCallId: "call-1", content: JSON.stringify({ cookie: cookieCanary, status: "ready" }) },
      ],
    };
    const adapter: MinistralAdapter = { complete: () => Effect.succeed(result()) };
    const detail = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const state = yield* repository.snapshot(owner);
      yield* runAuditedMinistral(
        { repository, identity: owner, generation: state.generation, requestId: "serialized", turnId: "turn-serialized" },
        adapter,
        requestWithHistory,
      );
      const attempts = yield* repository.providerAttempts(owner);
      return yield* repository.providerAttempt(owner, attempts[0]!.id);
    }));
    const serialized = JSON.stringify(detail?.request);
    expect(serialized).not.toContain(passwordCanary);
    expect(serialized).not.toContain(cookieCanary);
    expect(serialized).toContain("[redacted]");
  });

  it("persists known usage from complete frames before a truncated terminal event", async () => {
    const filename = await workspace();
    const owner = identity("truncated-stream@example.test");
    const frame = JSON.stringify({
      id: "charged-before-truncation",
      model: "mistralai/ministral-3b-2512",
      provider: "Mistral",
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.0042 },
    });
    const adapter = makeMinistralAdapter({ apiKey: "synthetic-key" }, async () =>
      new Response(`data: ${frame}\n\ndata: [DO`, { headers: { "x-generation-id": "header-generation" } }));
    const detail = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const state = yield* repository.snapshot(owner);
      yield* Effect.result(runAuditedMinistral(
        { repository, identity: owner, generation: state.generation, requestId: "truncated", turnId: "turn-truncated" },
        adapter,
        chatRequest,
      ));
      const attempts = yield* repository.providerAttempts(owner);
      return yield* repository.providerAttempt(owner, attempts[0]!.id);
    }));
    expect(detail).toMatchObject({
      outcome: "error",
      errorCode: "malformed_response",
      provider: "Mistral",
      actualModel: "mistralai/ministral-3b-2512",
      providerRequestId: "charged-before-truncation",
      generationId: "header-generation",
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      costUsd: 0.0042,
    });
    expect(detail?.response).not.toBeNull();
  });

  it("uses monotonic duration and sends only a bounded summary notification", async () => {
    const filename = await workspace();
    const owner = identity("notification@example.test");
    const readings = [100, 107];
    let notification: unknown = null;
    const adapter: MinistralAdapter = { complete: () => Effect.succeed(result()) };
    const started = performance.now();
    const attempt = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const state = yield* repository.snapshot(owner);
      yield* runAuditedMinistral(
        {
          repository,
          identity: owner,
          generation: state.generation,
          requestId: "notify",
          turnId: "turn-notify",
          monotonicNow: () => readings.shift() ?? 107,
          notify: (_userId, summary) => Effect.sync(() => { notification = summary; }).pipe(Effect.flatMap(() => Effect.never)),
        },
        adapter,
        chatRequest,
      );
      return (yield* repository.providerAttempts(owner))[0];
    }));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(attempt?.durationMs).toBe(7);
    expect(Object.keys(notification as Record<string, unknown>).sort()).toEqual([
      "actualModel", "costUsd", "durationMs", "generation", "id", "inputTokens", "kind",
      "mode", "outcome", "outputTokens", "provider", "requestedModel",
    ]);
    expect(notification).not.toHaveProperty("request");
    expect(notification).not.toHaveProperty("response");
  });

  it("aborts a stalled Effect fiber and finalizes the retained attempt as interrupted", async () => {
    const filename = await workspace();
    const owner = identity("interrupt@example.test");
    let aborted = false;
    const adapter = makeMinistralAdapter(
      { apiKey: "synthetic-key", timeoutMs: 10_000 },
      (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }),
    );
    const attempts = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const state = yield* repository.snapshot(owner);
      const fiber = yield* runAuditedMinistral(
        { repository, identity: owner, generation: state.generation, requestId: "interrupt", turnId: "turn-interrupt" },
        adapter,
        chatRequest,
      ).pipe(Effect.forkChild);
      yield* Effect.sleep(10);
      yield* Fiber.interrupt(fiber);
      return yield* repository.providerAttempts(owner);
    }));
    expect(aborted).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "interrupted", costUsd: null, errorCode: "interrupted" });
  });

  it("keeps old-generation completion after reset and notifies current sockets without closing them", async () => {
    const filename = await workspace();
    const owner = identity("late-audit@example.test");
    const received: Array<ServerMessage> = [];
    const closed: Array<number> = [];

    const attempts = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const hub = yield* RealtimeHub;
      const state = yield* repository.snapshot(owner);
      const deferred = yield* Deferred.make<MinistralResult>();
      const adapter: MinistralAdapter = { complete: () => Deferred.await(deferred) };
      const fiber = yield* runAuditedMinistral(
        {
          repository,
          identity: owner,
          generation: state.generation,
          requestId: "before-reset",
          turnId: "turn-before-reset",
          notify: (userId, attempt) => hub.publishAudit(userId, attempt),
        },
        adapter,
        chatRequest,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const resetProposal = yield* repository.prepareReset(owner, 1);
      const reset = yield* repository.accept(owner, 1, resetProposal.id, "provider-reset-key");
      yield* hub.register(owner.id, {
        id: "current-socket",
        generation: reset.snapshot.generation,
        clientId: "current-client",
        send: (message) => Effect.sync(() => { received.push(message); }),
        close: (code) => Effect.sync(() => { closed.push(code); }),
      });
      yield* Deferred.succeed(deferred, result());
      yield* Fiber.join(fiber);
      return yield* repository.providerAttempts(owner);
    }).pipe(Effect.provide([workspacePersistenceLayer(filename), realtimeHubLayer]))));

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ generation: 1, outcome: "success" });
    expect(received).toEqual([
      expect.objectContaining({
        type: "audit_event",
        event: "audit.attempt.completed",
        payload: expect.objectContaining({ generation: 1, outcome: "success" }),
      }),
    ]);
    expect(closed).toEqual([]);
  });

  it("recovers attempts only during explicit startup and accepts a later authoritative completion", async () => {
    const filename = await workspace();
    const owner = identity("restart-provider@example.test");
    const started = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      yield* repository.snapshot(owner);
      return yield* repository.startProviderAttempt({
        identity: owner,
        generation: 1,
        requestId: "abandoned",
        turnId: "turn-abandoned",
        kind: "chat",
        provider: "OpenRouter",
        model: "mistralai/ministral-3b-2512",
        request: { model: "mistralai/ministral-3b-2512" },
        requestBytes: 42,
      });
    }));
    expect(started.outcome).toBe("running");
    const readOnlyOpen = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      return yield* repository.providerAttempt(owner, started.id);
    }));
    expect(readOnlyOpen?.outcome).toBe("running");
    const recovered = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      expect(yield* repository.recoverProviderAttempts()).toBe(1);
      return yield* repository.providerAttempt(owner, started.id);
    }));
    expect(recovered).toMatchObject({ outcome: "interrupted", errorCode: "server_restart", costUsd: null, durationMs: null });

    const completed = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      return yield* repository.finishProviderAttempt(owner, started.id, {
        outcome: "success",
        provider: "Mistral",
        actualModel: "mistralai/ministral-3b-2512",
        providerRequestId: "late-provider-id",
        generationId: "late-generation-id",
        response: { content: "late but complete" },
        responseBytes: 44,
        inputTokens: 8,
        outputTokens: 3,
        totalTokens: 11,
        costUsd: 0.00001,
        errorCode: null,
        errorMessage: null,
        retryCount: 0,
        durationMs: 12,
      });
    }));
    expect(completed).toMatchObject({ outcome: "success", costUsd: 0.00001, inputTokens: 8, errorCode: null });

    const database = new DatabaseSync(filename);
    const rows = database.prepare("SELECT COUNT(*) AS count FROM provider_attempts WHERE user_id = ?").get(owner.id) as { count: number };
    database.close();
    expect(Number(rows.count)).toBe(1);
  });

  it("searches before pagination, preserves UTF-8 bytes and tiny live cost, and rejects another owner's detail lookup", async () => {
    const filename = await workspace();
    const owner = identity("audit-page-owner@example.test");
    const other = identity("audit-page-other@example.test");
    const created = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      yield* (yield* WorkspaceRepository).snapshot(other);
      const repository = yield* WorkspaceRepository;
      yield* repository.snapshot(owner);
      const ids: Array<string> = [];
      for (let index = 0; index < 15; index += 1) {
        const request = { messages: [{ role: "user", content: index === 0 ? "old retained needle café" : `request ${index}` }] };
        const started = yield* repository.startProviderAttempt({
          identity: owner, generation: 1, requestId: `page-${String(index).padStart(2, "0")}`,
          turnId: `turn-page-${String(index).padStart(2, "0")}`, kind: "chat", mode: "live",
          provider: "OpenRouter", model: "mistralai/ministral-3b-2512", request,
          requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
        });
        yield* repository.finishProviderAttempt(owner, started.id, {
          outcome: "success", provider: "Mistral", actualModel: "mistralai/ministral-3b-2512",
          providerRequestId: null, generationId: null, response: { content: "✓" },
          responseBytes: new TextEncoder().encode(JSON.stringify({ content: "✓" })).byteLength,
          inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: index === 0 ? 0.000000001 : null,
          errorCode: null, errorMessage: null, retryCount: 0, durationMs: 4,
        });
        ids.push(started.id);
      }
      const first = yield* repository.auditPage(owner, "", null, 7);
      const second = yield* repository.auditPage(owner, "", first.nextCursor, 7);
      const searched = yield* repository.auditPage(owner, "retained café", null, 7);
      const ownerDetail = yield* repository.auditDetail(owner, ids[0]!);
      const denied = yield* repository.auditDetail(other, ids[0]!);
      return { first, second, searched, ownerDetail, denied };
    }));

    expect(created.first).toMatchObject({ total: 15, attempts: expect.any(Array), nextCursor: expect.any(String) });
    expect(created.first.attempts).toHaveLength(7);
    expect(created.second.attempts).toHaveLength(7);
    expect(new Set([...created.first.attempts, ...created.second.attempts].map((attempt) => attempt.id)).size).toBe(14);
    expect(created.searched.attempts).toHaveLength(1);
    expect(created.searched.attempts[0]).toMatchObject({ requestLabel: "old retained needle café", mode: "live", costUsd: 0.000000001 });
    expect(created.ownerDetail?.requestBytes).toBe(new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: "old retained needle café" }] })).byteLength);
    expect(created.denied).toBeNull();
  });

  it("retains redacted tool, UI, terminal and accepted-receipt outcomes after reset", async () => {
    const filename = await workspace();
    const owner = identity("retained-results@example.test");
    const canary = "synthetic-cookie-secret";
    const result = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      yield* repository.snapshot(owner);
      const request = { messages: [{ role: "user", content: "Prepare BB-1042" }] };
      const started = yield* repository.startProviderAttempt({
        identity: owner, generation: 1, requestId: "prepare-request", turnId: "turn-retained-results",
        kind: "chat", mode: "scripted", provider: "OpenRouter", model: "mistralai/ministral-3b-2512",
        request, requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      });
      yield* repository.finishProviderAttempt(owner, started.id, {
        outcome: "success", provider: "Scripted", actualModel: "scripted/mistralai/ministral-3b-2512",
        providerRequestId: null, generationId: null, response: { tool: "prepareAddressCorrection" }, responseBytes: 35,
        inputTokens: null, outputTokens: null, totalTokens: null, costUsd: 0,
        errorCode: null, errorMessage: null, retryCount: 0, durationMs: 3,
      });
      const proposal = yield* repository.prepareResolution(owner, 1, "BB-1042");
      yield* repository.recordApplicationAudit(owner, 1, {
        kind: "tool", label: "Prepare an address correction", outcome: "completed",
        requestId: "call-prepare", turnId: "turn-retained-results", proposalId: proposal.id,
        body: { state: "prepared", arguments: { orderId: "BB-1042", cookie: canary }, result: proposal },
      });
      yield* repository.recordApplicationAudit(owner, 1, {
        kind: "ui", label: "Show proposal", outcome: "applied", requestId: "operation-1",
        turnId: "turn-retained-results", proposalId: proposal.id, body: { acknowledgement: "applied" },
      });
      const accepted = yield* repository.accept(owner, 1, proposal.id, "retained-result-key", "accept-request");
      yield* repository.recordCommandMeasurement(owner, 1, accepted.receipt.id, 18.5);
      const resetProposal = yield* repository.prepareReset(owner, 1);
      yield* repository.accept(owner, 1, resetProposal.id, "retained-reset-key", "reset-request");
      return { page: yield* repository.auditPage(owner, "Prepare BB-1042"), resetPage: yield* repository.auditPage(owner, ""), detail: yield* repository.auditDetail(owner, started.id) };
    }));

    expect(result.page.attempts).toHaveLength(1);
    expect(result.resetPage.markers).toHaveLength(1);
    expect(result.detail?.application.map((record) => [record.kind, record.outcome])).toEqual(expect.arrayContaining([
      ["tool", "completed"], ["ui", "applied"], ["receipt", "accepted"], ["command_visible", "complete"],
    ]));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(canary);
    expect(serialized).toContain("[redacted]");
    const bodyText = result.detail?.application.map((record) => record.bodyText).join("\n") ?? "";
    expect(bodyText).toContain('"state": "prepared"');
    expect(bodyText).toContain('"state": "accepted"');
  });

  it("pages every correlated application result and keeps terminal timing independent of the current page", async () => {
    const filename = await workspace();
    const owner = identity("paged-results@example.test");
    const result = await runWithWorkspaceRepository(filename, Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      yield* repository.snapshot(owner);
      const request = { messages: [{ role: "user", content: "Inspect a long tool trace" }] };
      const started = yield* repository.startProviderAttempt({
        identity: owner, generation: 1, requestId: "paged-results", turnId: "turn-paged-results",
        kind: "chat", mode: "scripted", provider: "OpenRouter", model: "mistralai/ministral-3b-2512",
        request, requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      });
      yield* repository.finishProviderAttempt(owner, started.id, {
        outcome: "success", provider: "Scripted", actualModel: "scripted/mistralai/ministral-3b-2512",
        providerRequestId: null, generationId: null, response: { content: "done" }, responseBytes: 18,
        inputTokens: null, outputTokens: null, totalTokens: null, costUsd: 0,
        errorCode: null, errorMessage: null, retryCount: 0, durationMs: 2,
      });
      for (let index = 0; index < 16; index += 1) {
        yield* repository.recordApplicationAudit(owner, 1, {
          kind: "tool", label: `Tool result ${index}`, outcome: "completed",
          requestId: `tool-${index}`, turnId: "turn-paged-results", body: { index },
        });
      }
      yield* repository.recordApplicationAudit(owner, 1, {
        kind: "turn", label: "Completed agent turn", outcome: "complete", requestId: "paged-results",
        turnId: "turn-paged-results", body: { completeDurationMs: 246.5, measurement: "complete", serverDurationMs: 125.25, serverMeasurement: "complete" },
      });
      for (let index = 0; index < 5; index += 1) {
        yield* repository.recordApplicationAudit(owner, 1, {
          kind: "ui", label: `UI result ${index}`, outcome: "applied",
          requestId: `ui-${index}`, turnId: "turn-paged-results", body: { index },
        });
      }
      const pages: Array<AuditAttemptDetail> = [];
      let cursor: string | null = null;
      do {
        const page: AuditAttemptDetail | null = yield* repository.auditDetail(owner, started.id, cursor);
        if (page === null) throw new Error("Expected owner-scoped audit detail.");
        pages.push(page);
        cursor = page.applicationNextCursor;
      } while (cursor !== null);
      return pages;
    }));

    const records = result.flatMap((page) => page.application);
    expect(result.length).toBe(3);
    expect(result.every((page) => page.application.length <= 8)).toBe(true);
    expect(records).toHaveLength(22);
    expect(new Set(records.map((record) => record.id)).size).toBe(22);
    expect(records.map((record) => record.label)).toEqual(expect.arrayContaining([
      "Tool result 0", "Tool result 15", "Completed agent turn", "UI result 0", "UI result 4",
    ]));
    expect(result.every((page) => page.browserDurationMs === 246.5 && page.browserMeasurement === "complete")).toBe(true);
    expect(result.every((page) => page.serverTurnDurationMs === 125.25 && page.serverTurnMeasurement === "complete")).toBe(true);
  });
});
