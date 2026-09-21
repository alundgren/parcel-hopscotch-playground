import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/server/config";
import { resolveIdentity } from "../../src/server/identity";
import { runWithWorkspaceRepository, WorkspaceRepository, type WorkspaceRepositoryService } from "../../src/server/persistence";

const paths: Array<string> = [];
const config: ServerConfig = { environment: "production", host: "127.0.0.1", port: 0, publicOrigin: "https://parcel.example.test", databasePath: ":memory:", allowDevelopmentIdentity: false, developmentEmail: null };
const identity = (email: string) => Effect.runSync(resolveIdentity(["Cf-Access-Authenticated-User-Email", email], config));
const workspace = async () => { const directory = await mkdtemp(join(tmpdir(), "parcel-hopscotch-commands-")); paths.push(directory); return join(directory, "workspace.sqlite"); };
const useRepository = <A>(filename: string, run: (repository: WorkspaceRepositoryService) => Effect.Effect<A, unknown>) => runWithWorkspaceRepository(filename, Effect.flatMap(WorkspaceRepository, run));

afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("reviewed fulfilment commands", () => {
  it("prepares and accepts deterministic reviewed changes for all six exception families", async () => {
    const filename = await workspace();
    const user = identity("families@example.test");
    const examples = ["BB-1042", "BB-1051", "BB-1068", "BB-1070", "BB-1088", "BB-1096"] as const;
    const families = ["address", "substitution", "bundle", "weight", "carrier", "duplicate"];

    for (const [index, orderId] of examples.entries()) {
      await useRepository(filename, (repository) => Effect.gen(function* () {
        const state = yield* repository.snapshot(user);
        const proposal = yield* repository.prepareResolution(user, state.generation, orderId);
        expect(proposal.ready).toBe(true);
        expect(proposal.changes).toHaveLength(1);
        expect(proposal.changes[0]?.family).toBe(families[index]);
        expect(proposal.changes[0]?.before).not.toBe(proposal.changes[0]?.after);
        const commit = yield* repository.accept(user, state.generation, proposal.id, `family-key-${index}`);
        expect(commit.receipt.changes[0]?.family).toBe(families[index]);
        expect(commit.snapshot.orders.find((order) => order.id === orderId)?.version).toBe(2);
      }));
    }
    const database = new DatabaseSync(filename);
    const stock = database.prepare("SELECT sku, quantity, version FROM inventory WHERE user_id = ? ORDER BY sku").all(user.id);
    database.close();
    expect(stock).toEqual([
      { sku: "MUG-SAGE", quantity: 3, version: 2 },
      { sku: "SIDE-PLATE", quantity: 2, version: 2 },
    ]);
  });

  it("rejects a stale batch atomically when one reviewed record changes", async () => {
    const filename = await workspace();
    const user = identity("stale@example.test");
    const proposal = await useRepository(filename, (repository) => Effect.gen(function* () {
      const state = yield* repository.snapshot(user);
      return yield* repository.prepareBatch(user, state.generation);
    }));
    expect(proposal.changes.length).toBeGreaterThan(1);
    await useRepository(filename, (repository) => repository.advanceScenario(user, proposal.generation));
    await expect(useRepository(filename, (repository) => repository.accept(user, proposal.generation, proposal.id, "stale-batch-key"))).rejects.toMatchObject({ code: "stale_proposal" });
    const state = await useRepository(filename, (repository) => repository.snapshot(user));
    for (const change of proposal.changes) expect(state.orders.some((order) => order.id === change.orderId)).toBe(true);
    const database = new DatabaseSync(filename);
    const completed = database.prepare("SELECT SUM(completed) AS completed FROM orders WHERE user_id = ?").get(user.id) as { completed: number };
    database.close();
    expect(Number(completed.completed)).toBe(0);
  });

  it("returns the same receipt for duplicate acceptance and rejects another user's proposal", async () => {
    const filename = await workspace();
    const owner = identity("owner@example.test");
    const other = identity("other@example.test");
    const proposal = await useRepository(filename, (repository) => Effect.gen(function* () {
      const state = yield* repository.snapshot(owner);
      return yield* repository.prepareResolution(owner, state.generation, "BB-1042");
    }));
    await useRepository(filename, (repository) => repository.snapshot(other));
    await expect(useRepository(filename, (repository) => repository.accept(other, 1, proposal.id, "other-user-key"))).rejects.toMatchObject({ code: "proposal_not_found" });
    const first = await useRepository(filename, (repository) => repository.accept(owner, 1, proposal.id, "same-user-key"));
    const duplicate = await useRepository(filename, (repository) => repository.accept(owner, 1, proposal.id, "same-user-key"));
    expect(duplicate.receipt.id).toBe(first.receipt.id);
    expect(duplicate.snapshot.orders.find((order) => order.id === "BB-1042")?.version).toBe(2);
    const another = await useRepository(filename, (repository) => repository.prepareResolution(owner, 1, "BB-1068"));
    await expect(useRepository(filename, (repository) => repository.accept(owner, 1, another.id, "same-user-key"))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("previews checked Undo and refuses to overwrite a later change", async () => {
    const filename = await workspace();
    const user = identity("undo@example.test");
    const receipt = await useRepository(filename, (repository) => Effect.gen(function* () {
      const state = yield* repository.snapshot(user);
      const proposal = yield* repository.prepareResolution(user, state.generation, "BB-1051");
      return (yield* repository.accept(user, state.generation, proposal.id, "undo-source-key")).receipt;
    }));
    const undo = await useRepository(filename, (repository) => repository.prepareUndo(user, 1, receipt.id));
    expect(undo.changes[0]).toMatchObject({ orderId: "BB-1051", expectedVersion: 2 });
    await useRepository(filename, (repository) => repository.advanceScenario(user, 1));
    await expect(useRepository(filename, (repository) => repository.accept(user, 1, undo.id, "conflicting-undo-key"))).rejects.toMatchObject({ code: "stale_proposal" });
  });

  it("resets only one user, retains audit records, and rejects old-generation proposals and keys", async () => {
    const filename = await workspace();
    const first = identity("reset@example.test");
    const second = identity("untouched@example.test");
    const accepted = await useRepository(filename, (repository) => Effect.gen(function* () {
      const firstState = yield* repository.snapshot(first);
      yield* repository.snapshot(second);
      const proposal = yield* repository.prepareResolution(first, firstState.generation, "BB-1042");
      const commit = yield* repository.accept(first, 1, proposal.id, "accepted-before-reset");
      return { proposal, receipt: commit.receipt };
    }));
    await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.advanceScenario(first, 1);
      yield* repository.prepareResolution(first, 1, "BB-1068");
    }));
    const seededState = new DatabaseSync(filename);
    seededState.prepare("INSERT INTO chat_messages (id, user_id, generation, role, body, created_at) VALUES ('chat-before-reset', ?, 1, 'user', 'hello', ?)").run(first.id, new Date().toISOString());
    seededState.prepare("INSERT INTO tutorial_state (user_id, generation, tutorial_id, step) VALUES (?, 1, 'address-correction', 2)").run(first.id);
    seededState.close();
    const reset = await useRepository(filename, (repository) => Effect.gen(function* () {
      const proposal = yield* repository.prepareReset(first, 1);
      return yield* repository.accept(first, 1, proposal.id, "reset-confirmation-key");
    }));
    expect(reset.generationChanged).toBe(true);
    expect(reset.snapshot).toMatchObject({ generation: 2, sequence: 1 });
    expect(reset.snapshot.orders).toHaveLength(24);
    expect(reset.receipt.kind).toBe("reset");
    const other = await useRepository(filename, (repository) => repository.snapshot(second));
    expect(other).toMatchObject({ generation: 1, sequence: 0 });
    await expect(useRepository(filename, (repository) => repository.accept(first, 1, accepted.proposal.id, "accepted-before-reset"))).rejects.toMatchObject({ code: "generation_changed" });
    await expect(useRepository(filename, (repository) => repository.accept(first, 2, accepted.proposal.id, "accepted-before-reset"))).rejects.toMatchObject({ code: "proposal_not_found" });
    const database = new DatabaseSync(filename);
    const audit = database.prepare("SELECT kind, generation FROM audit_records WHERE user_id = ? ORDER BY completed_at").all(first.id) as Array<{ kind: string; generation: number }>;
    const cleared = database.prepare("SELECT (SELECT COUNT(*) FROM chat_messages WHERE user_id = ?) AS chat, (SELECT COUNT(*) FROM tutorial_state WHERE user_id = ?) AS tutorial, (SELECT COUNT(*) FROM proposals WHERE user_id = ?) AS proposals, (SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts, (SELECT COUNT(*) FROM scenario_events WHERE user_id = ?) AS events").get(first.id, first.id, first.id, first.id, first.id) as { chat: number; tutorial: number; proposals: number; receipts: number; events: number };
    database.close();
    expect(audit).toEqual([{ kind: "command", generation: 1 }, { kind: "reset", generation: 2 }]);
    expect(cleared).toEqual({ chat: 0, tutorial: 0, proposals: 0, receipts: 1, events: 1 });
    expect(accepted.receipt.id).not.toBe(reset.receipt.id);
  });

  it("serializes duplicate acceptance and a scenario change without partial work", async () => {
    const filename = await workspace();
    const user = identity("concurrent@example.test");
    const proposal = await useRepository(filename, (repository) => Effect.gen(function* () {
      const state = yield* repository.snapshot(user);
      return yield* repository.prepareBatch(user, state.generation);
    }));
    const [first, second] = await Promise.all([
      useRepository(filename, (repository) => repository.accept(user, 1, proposal.id, "concurrent-same-key")),
      useRepository(filename, (repository) => repository.accept(user, 1, proposal.id, "concurrent-same-key")),
    ]);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(first.snapshot.orders.length).toBe(24 - proposal.changes.length);

    const raceUser = identity("scenario-race@example.test");
    const substitution = await useRepository(filename, (repository) => Effect.gen(function* () {
      const state = yield* repository.snapshot(raceUser);
      return yield* repository.prepareResolution(raceUser, state.generation, "BB-1051");
    }));
    const raced = await Promise.allSettled([
      useRepository(filename, (repository) => repository.advanceScenario(raceUser, 1)),
      useRepository(filename, (repository) => repository.accept(raceUser, 1, substitution.id, "scenario-race-key")),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = raced.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "stale_proposal" });
  });

  it("bounds deterministic stock advancement", async () => {
    const filename = await workspace();
    const user = identity("bounded-scenario@example.test");
    await useRepository(filename, (repository) => repository.snapshot(user));
    for (let step = 0; step < 4; step += 1) {
      const result = await useRepository(filename, (repository) => repository.advanceScenario(user, 1));
      expect(result.message).toContain("Scenario advanced");
    }
    await expect(useRepository(filename, (repository) => repository.advanceScenario(user, 1))).rejects.toMatchObject({ code: "scenario_complete" });
  });
});
