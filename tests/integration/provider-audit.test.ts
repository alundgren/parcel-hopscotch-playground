import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "../../src/shared/contracts";
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
    expect(recovered).toMatchObject({ outcome: "interrupted", errorCode: "server_restart", costUsd: null });

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
      });
    }));
    expect(completed).toMatchObject({ outcome: "success", costUsd: 0.00001, inputTokens: 8, errorCode: null });

    const database = new DatabaseSync(filename);
    const rows = database.prepare("SELECT COUNT(*) AS count FROM provider_attempts WHERE user_id = ?").get(owner.id) as { count: number };
    database.close();
    expect(Number(rows.count)).toBe(1);
  });
});
