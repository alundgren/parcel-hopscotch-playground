import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/server/config";
import { resolveIdentity } from "../../src/server/identity";
import { resolutionFacts } from "../../src/server/fulfilment";
import { runWithWorkspaceRepository, WorkspaceRepository, type WorkspaceRepositoryService } from "../../src/server/persistence";

const paths: Array<string> = [];
const config: ServerConfig = { environment: "production", host: "127.0.0.1", port: 0, publicOrigin: "https://parcel.example.test", databasePath: ":memory:", allowDevelopmentIdentity: false, developmentEmail: null };
const identity = (email: string) => Effect.runSync(resolveIdentity(["Cf-Access-Authenticated-User-Email", email], config));
const workspace = async () => { const directory = await mkdtemp(join(tmpdir(), "parcel-hopscotch-commands-")); paths.push(directory); return join(directory, "workspace.sqlite"); };
const useRepository = <A>(filename: string, run: (repository: WorkspaceRepositoryService) => Effect.Effect<A, unknown>) => runWithWorkspaceRepository(filename, Effect.flatMap(WorkspaceRepository, run));
const raceWorker = (filename: string, email: string, action: "accept" | "scenario", proposalId: string, gate: string) => new Promise<{ ok: boolean; kind?: string; code?: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/fixtures/command-race-worker.ts", filename, email, action, proposalId, gate], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("exit", (code) => { if (code !== 0) reject(new Error(stderr || `Worker exited ${code}`)); else resolve(JSON.parse(stdout) as { ok: boolean; kind?: string; code?: string }); });
});

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
      { sku: "CARAFE-SMOKE", quantity: 2, version: 1 },
      { sku: "MUG-SAGE", quantity: 3, version: 2 },
      { sku: "SIDE-PLATE", quantity: 2, version: 2 },
      { sku: "THROW-NATURAL", quantity: 2, version: 1 },
    ]);
  });

  it("prepares exact per-order facts and holds every ambiguous seeded case", async () => {
    const filename = await workspace();
    const user = identity("all-seeds@example.test");
    const orderIds = await useRepository(filename, (repository) => repository.orderIds(user));
    const proposals = await useRepository(filename, (repository) => Effect.forEach(orderIds, (orderId) => repository.prepareResolution(user, 1, orderId)));
    const held = new Set(["BB-1076", "BB-1081", "BB-1116", "BB-1118", "BB-1120", "BB-1123"]);
    expect(proposals).toHaveLength(24);
    for (const [index, proposal] of proposals.entries()) {
      const orderId = orderIds[index]!;
      const facts = resolutionFacts[orderId]!;
      expect(proposal.ready).toBe(!held.has(orderId));
      if (held.has(orderId)) {
        expect(proposal.changes).toEqual([]);
        expect(proposal.omissions).toEqual([{ orderId, reason: facts.heldReason }]);
      } else {
        expect(proposal.changes[0]).toMatchObject({ orderId: facts.affectedOrderId ?? orderId, before: facts.before.summary, after: facts.after.summary, effect: facts.effect });
      }
    }
    expect(proposals[orderIds.indexOf("BB-1072")]?.changes[0]?.after).toBe("Sjövik");
    expect(proposals[orderIds.indexOf("BB-1104")]?.changes[0]?.after).toContain("Smoke glass carafe");
    expect(proposals[orderIds.indexOf("BB-1095")]?.changes[0]?.orderId).toBe("BB-1096");
  });

  it("rejects a stale batch atomically when one reviewed record changes", async () => {
    const filename = await workspace();
    const user = identity("stale@example.test");
    const proposal = await useRepository(filename, (repository) => Effect.gen(function* () {
      const state = yield* repository.snapshot(user);
      return yield* repository.prepareBatch(user, state.generation);
    }));
    expect(proposal.changes.length).toBeGreaterThan(1);
    const advanced = await useRepository(filename, (repository) => repository.advanceScenario(user, proposal.generation));
    expect(advanced.snapshot.orders.find((order) => order.id === "BB-1051")?.version).toBe(1);
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

  it("persists the reviewed business value, prevents repeat reservation, and restores both on Undo", async () => {
    const filename = await workspace();
    const user = identity("persisted-value@example.test");
    const receipt = await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(user);
      const proposal = yield* repository.prepareResolution(user, 1, "BB-1051");
      return (yield* repository.accept(user, 1, proposal.id, "persist-value-key")).receipt;
    }));
    const accepted = await useRepository(filename, (repository) => repository.snapshot(user));
    expect(accepted.orders.find((order) => order.id === "BB-1051")?.businessValue).toBe("Sage stoneware mug, quantity 1, £24.00");
    await expect(useRepository(filename, (repository) => repository.prepareResolution(user, 1, "BB-1051"))).rejects.toMatchObject({ code: "already_resolved" });
    const undo = await useRepository(filename, (repository) => repository.prepareUndo(user, 1, receipt.id));
    await useRepository(filename, (repository) => repository.accept(user, 1, undo.id, "persist-undo-key"));
    const restored = await useRepository(filename, (repository) => repository.snapshot(user));
    expect(restored.orders.find((order) => order.id === "BB-1051")?.businessValue).toBe("Blue stoneware mug, quantity 1, £24.00");
    const database = new DatabaseSync(filename);
    const stock = database.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND sku = 'MUG-SAGE'").get(user.id) as { quantity: number };
    database.close();
    expect(Number(stock.quantity)).toBe(4);
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
    const database = new DatabaseSync(filename);
    const reserved = database.prepare("SELECT sku, quantity FROM inventory WHERE user_id = ? AND sku IN ('MUG-SAGE', 'THROW-NATURAL') ORDER BY sku").all(user.id);
    database.close();
    expect(reserved).toEqual([{ sku: "MUG-SAGE", quantity: 3 }, { sku: "THROW-NATURAL", quantity: 1 }]);

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
    const held = await useRepository(filename, (repository) => repository.prepareResolution(user, 1, "BB-1051"));
    expect(held).toMatchObject({ ready: false, changes: [], omissions: [{ orderId: "BB-1051" }] });
    await expect(useRepository(filename, (repository) => repository.accept(user, 1, held.id, "held-stock-key"))).rejects.toMatchObject({ code: "proposal_not_ready" });
    await expect(useRepository(filename, (repository) => repository.advanceScenario(user, 1))).rejects.toMatchObject({ code: "scenario_complete" });
  });

  it("serializes acceptance and stock advancement across independent processes", async () => {
    const filename = await workspace();
    const user = identity("cross-process@example.test");
    const proposal = await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(user);
      return yield* repository.prepareResolution(user, 1, "BB-1051");
    }));
    const gate = join(filename, "..", "race.go");
    const accepting = raceWorker(filename, "cross-process@example.test", "accept", proposal.id, gate);
    const advancing = raceWorker(filename, "cross-process@example.test", "scenario", proposal.id, gate);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(gate, "go");
    const [acceptResult, scenarioResult] = await Promise.all([accepting, advancing]);
    expect(scenarioResult).toMatchObject({ ok: true, kind: "scenario" });
    expect(acceptResult.ok || acceptResult.code === "stale_proposal").toBe(true);
    const final = await useRepository(filename, (repository) => repository.snapshot(user));
    const mug = final.orders.find((order) => order.id === "BB-1051");
    const database = new DatabaseSync(filename);
    const receipts = database.prepare("SELECT COUNT(*) AS count FROM receipts WHERE user_id = ?").get(user.id) as { count: number };
    const stock = database.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND sku = 'MUG-SAGE'").get(user.id) as { quantity: number };
    database.close();
    if (acceptResult.ok) {
      expect(mug?.businessValue).toContain("Sage stoneware mug");
      expect(Number(receipts.count)).toBe(1);
      expect(Number(stock.quantity)).toBe(2);
    } else {
      expect(mug?.businessValue).toContain("Blue stoneware mug");
      expect(Number(receipts.count)).toBe(0);
      expect(Number(stock.quantity)).toBe(3);
    }
  });
});
