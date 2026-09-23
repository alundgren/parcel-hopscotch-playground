import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ServerConfig } from "../../src/server/config";
import { resolveIdentity } from "../../src/server/identity";
import { runWithWorkspaceRepository, WorkspaceRepository, type WorkspaceRepositoryService } from "../../src/server/persistence";
import type { TutorialState } from "../../src/shared/contracts";

const paths: Array<string> = [];
const config: ServerConfig = { environment: "production", host: "127.0.0.1", port: 0, publicOrigin: "https://parcel.example.test", databasePath: ":memory:", allowDevelopmentIdentity: false, developmentEmail: null, agentMode: "unavailable", openRouterApiKey: null };
const identity = (email: string) => Effect.runSync(resolveIdentity(["Cf-Access-Authenticated-User-Email", email], config));
const workspace = async () => { const directory = await mkdtemp(join(tmpdir(), "parcel-hopscotch-commands-")); paths.push(directory); return join(directory, "workspace.sqlite"); };
const useRepository = <A>(filename: string, run: (repository: WorkspaceRepositoryService) => Effect.Effect<A, unknown>) => runWithWorkspaceRepository(filename, Effect.flatMap(WorkspaceRepository, run));
const tutorialRevision = (state: TutorialState) => ({ tutorialId: state.id, tutorialInstanceId: state.instanceId, expectedStep: state.step });
const raceWorker = (filename: string, email: string, action: "accept" | "scenario", proposalId: string, gate: string) => new Promise<{ ok: boolean; kind?: string; code?: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/fixtures/command-race-worker.ts", filename, email, action, proposalId, gate], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("exit", (code) => { if (code !== 0) reject(new Error(stderr || `Worker exited ${code}`)); else resolve(JSON.parse(stdout) as { ok: boolean; kind?: string; code?: string }); });
});

afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("reviewed fulfilment commands", () => {
  it("advances tutorial progress only for the expected owner, generation, order and action", async () => {
    const filename = await workspace();
    const user = identity("tutorial-owner@example.test");
    const other = identity("tutorial-other@example.test");

    await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(user);
      yield* repository.snapshot(other);
      const started = yield* repository.startTutorial(user, 1, "address-correction");
      expect(started).toMatchObject({ step: 0, phase: "teaching" });

      const otherAction = yield* repository.recordTutorialAction(other, 1, { ...tutorialRevision(started), kind: "order_selected", orderId: "BB-1042" });
      expect(otherAction.advanced).toBe(false);
      expect(otherAction.snapshot.tutorial).toBeNull();

      const unrelated = yield* repository.recordTutorialAction(user, 1, { ...tutorialRevision(started), kind: "order_selected", orderId: "BB-1102" });
      expect(unrelated.advanced).toBe(false);
      expect(unrelated.snapshot.tutorial?.step).toBe(0);

      const selected = yield* repository.recordTutorialAction(user, 1, { ...tutorialRevision(started), kind: "order_selected", orderId: "BB-1042" });
      expect(selected.advanced).toBe(true);
      expect(selected.snapshot.tutorial?.step).toBe(1);

      const duplicate = yield* repository.recordTutorialAction(user, 1, { ...tutorialRevision(started), kind: "order_selected", orderId: "BB-1042" });
      expect(duplicate.advanced).toBe(false);
      expect(duplicate.snapshot.tutorial?.step).toBe(1);

      yield* repository.stopTutorial(user, 1);
      expect((yield* repository.snapshot(user)).tutorial).toBeNull();
      const resumed = yield* repository.startTutorial(user, 1, "address-correction");
      expect(resumed).toMatchObject({ instanceId: started.instanceId, step: 1 });

      const wrong = yield* repository.prepareResolution(user, 1, "BB-1102");
      expect((yield* repository.snapshot(user)).tutorial?.step).toBe(1);
      yield* repository.accept(user, 1, wrong.id, "wrong-tutorial-key");
      expect((yield* repository.snapshot(user)).tutorial?.step).toBe(1);

      const proposal = yield* repository.prepareResolution(user, 1, "BB-1042");
      const preparedSnapshot = yield* repository.snapshot(user);
      expect(preparedSnapshot.tutorial?.step).toBe(2);
      expect(preparedSnapshot.tutorialProposal?.id).toBe(proposal.id);
      const laterPending = yield* repository.prepareResolution(user, 1, "BB-1088");
      const proposalRecovery = yield* repository.snapshot(user);
      expect(proposalRecovery.currentProposal?.id).toBe(laterPending.id);
      expect(proposalRecovery.tutorialProposal?.id).toBe(proposal.id);
      const commit = yield* repository.accept(user, 1, proposal.id, "address-tutorial-key");
      expect(commit.snapshot.tutorial?.step).toBe(3);
      expect(commit.snapshot.tutorialProposal).toBeNull();
      expect(commit.snapshot.tutorialReceipt?.id).toBe(commit.receipt.id);

      const laterProposal = yield* repository.prepareResolution(user, 1, "BB-1068");
      const laterCommit = yield* repository.accept(user, 1, laterProposal.id, "later-unrelated-key");
      expect(laterCommit.snapshot.latestReceipt?.id).toBe(laterCommit.receipt.id);
      expect(laterCommit.snapshot.tutorialReceipt?.id).toBe(commit.receipt.id);

      const receiptStep = laterCommit.snapshot.tutorial!;
      const wrongReceipt = yield* repository.recordTutorialAction(user, 1, { ...tutorialRevision(receiptStep), kind: "receipt_confirmed", receiptId: (yield* repository.accept(user, 1, wrong.id, "wrong-tutorial-key")).receipt.id });
      expect(wrongReceipt.advanced).toBe(false);
      const confirmed = yield* repository.recordTutorialAction(user, 1, { ...tutorialRevision(receiptStep), kind: "receipt_confirmed", receiptId: commit.receipt.id });
      expect(confirmed.advanced).toBe(true);
      expect(confirmed.snapshot.tutorial).toMatchObject({ step: 4, phase: "practice" });
      expect(confirmed.snapshot.tutorialReceipt).toBeNull();
    }));

    await useRepository(filename, (repository) => Effect.gen(function* () {
      expect((yield* repository.snapshot(user)).tutorial).toMatchObject({ id: "address-correction", step: 4 });
      const reset = yield* repository.prepareReset(user, 1);
      const commit = yield* repository.accept(user, 1, reset.id, "tutorial-reset-key");
      expect(commit.snapshot).toMatchObject({ generation: 2, tutorial: null });
    }));

    await expect(useRepository(filename, (repository) => repository.recordTutorialAction(user, 1, { tutorialId: "address-correction", tutorialInstanceId: "stale-instance", expectedStep: 4, kind: "order_selected", orderId: "BB-1072" }))).rejects.toMatchObject({ code: "generation_changed" });
  });

  it("uses separate tutorial batch groups and preserves ordinary all-ready batches", async () => {
    const filename = await workspace();
    const guided = identity("batch-tutorial@example.test");
    const ordinary = identity("ordinary-batch@example.test");

    await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(guided);
      const started = yield* repository.startTutorial(guided, 1, "batch-approval");
      const beforeReady = yield* Effect.result(repository.prepareBatch(guided, 1));
      expect(beforeReady).toMatchObject({ _tag: "Failure", failure: { code: "tutorial_step_required" } });
      yield* repository.recordTutorialAction(guided, 1, { ...tutorialRevision(started), kind: "ready_filter_selected" });
      const teaching = yield* repository.prepareBatch(guided, 1);
      expect(teaching.changes.map((change) => change.orderId)).toEqual(["BB-1051", "BB-1063", "BB-1090"]);
      expect(teaching.omissions).toContainEqual({ orderId: "BB-1084", reason: "Outside this tutorial group." });
      const repeatedTeaching = yield* repository.prepareBatch(guided, 1);
      expect(repeatedTeaching.changes.map((change) => change.orderId)).toEqual(["BB-1051", "BB-1063", "BB-1090"]);
      const teachingCommit = yield* repository.accept(guided, 1, teaching.id, "batch-teaching-key");
      expect(teachingCommit.snapshot.tutorial?.step).toBe(3);
      const teachingReceipt = yield* repository.recordTutorialAction(guided, 1, { ...tutorialRevision(teachingCommit.snapshot.tutorial!), kind: "receipt_confirmed", receiptId: teachingCommit.receipt.id });
      yield* repository.recordTutorialAction(guided, 1, { ...tutorialRevision(teachingReceipt.snapshot.tutorial!), kind: "ready_filter_selected" });

      const practice = yield* repository.prepareBatch(guided, 1);
      expect(practice.changes.map((change) => change.orderId)).toEqual(["BB-1084", "BB-1110", "BB-1112"]);
      const repeatedPractice = yield* repository.prepareBatch(guided, 1);
      expect(repeatedPractice.changes.map((change) => change.orderId)).toEqual(["BB-1084", "BB-1110", "BB-1112"]);
      const practiceCommit = yield* repository.accept(guided, 1, practice.id, "batch-practice-key");
      const completed = yield* repository.recordTutorialAction(guided, 1, { ...tutorialRevision(practiceCommit.snapshot.tutorial!), kind: "receipt_confirmed", receiptId: practiceCommit.receipt.id });
      expect(completed.snapshot.tutorial).toMatchObject({ step: 8, phase: "complete" });
      yield* repository.stopTutorial(guided, 1);
      expect((yield* repository.snapshot(guided)).tutorial).toBeNull();

      yield* repository.snapshot(ordinary);
      const allReady = yield* repository.prepareBatch(ordinary, 1);
      expect(allReady.changes.map((change) => change.orderId)).toEqual(["BB-1051", "BB-1063", "BB-1090", "BB-1084", "BB-1110", "BB-1112"]);
    }));
  });

  it("rejects restarting a dismissed lesson when its remaining work changed outside the lesson", async () => {
    const filename = await workspace();
    const user = identity("tutorial-restart-conflict@example.test");
    const unavailable = identity("tutorial-practice-conflict@example.test");

    await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(user);
      const started = yield* repository.startTutorial(user, 1, "address-correction");
      const selected = yield* repository.recordTutorialAction(user, 1, { ...tutorialRevision(started), kind: "order_selected", orderId: "BB-1042" });
      yield* repository.stopTutorial(user, 1);
      const proposal = yield* repository.prepareResolution(user, 1, "BB-1042");
      yield* repository.accept(user, 1, proposal.id, "outside-tutorial-key");
      const restart = yield* Effect.result(repository.startTutorial(user, 1, "address-correction"));
      expect(restart).toMatchObject({ _tag: "Failure", failure: { code: "tutorial_unavailable" } });
      expect(selected.snapshot.tutorial?.step).toBe(1);

      yield* repository.snapshot(unavailable);
      const practice = yield* repository.prepareResolution(unavailable, 1, "BB-1072");
      yield* repository.accept(unavailable, 1, practice.id, "practice-before-tutorial-key");
      const unavailableStart = yield* Effect.result(repository.startTutorial(unavailable, 1, "address-correction"));
      expect(unavailableStart).toMatchObject({ _tag: "Failure", failure: { code: "tutorial_unavailable" } });
    }));
  });
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
    const expected: Record<string, { ready: boolean; affected?: string; before?: string; after?: string; reason?: string }> = {
      "BB-1042": { ready: true, before: "14 Willow Lane, Bath BA1 2AB", after: "41 Willow Lane, Bath BA1 2AB" },
      "BB-1072": { ready: true, before: "North Sjövik", after: "Sjövik" },
      "BB-1102": { ready: true, before: "22 Birch Road", after: "Flat 6, 22 Birch Road" },
      "BB-1114": { ready: true, before: "Bath BA1 4OF", after: "Bath BA1 4QF" },
      "BB-1051": { ready: true, before: "Blue stoneware mug, quantity 1, £24.00", after: "Sage stoneware mug, quantity 1, £24.00" },
      "BB-1063": { ready: true, before: "Natural linen throw, not reserved", after: "Natural linen throw, quantity 1 reserved" },
      "BB-1076": { ready: false, reason: "The customer asked for a picture first, so the replacement is not agreed." },
      "BB-1104": { ready: true, before: "Clear glass carafe, quantity 1, £38.00", after: "Smoke glass carafe, quantity 1, £38.00" },
      "BB-1068": { ready: true, before: "Breakfast set with 3 of 4 side plates", after: "Breakfast set with 4 of 4 side plates" },
      "BB-1081": { ready: false, reason: "The divider insert has not reached packing." },
      "BB-1090": { ready: true, before: "Matched candle pair with gift sleeve", after: "Matched candle pair confirmed" },
      "BB-1116": { ready: false, reason: "The small bowl scan is still absent." },
      "BB-1070": { ready: true, before: "One parcel at 15.8 kg", after: "Two parcels at 7.9 kg each" },
      "BB-1084": { ready: true, before: "One parcel at 2.4 kg against a 2.5 kg booking", after: "Booked parcel confirmed at 2.4 kg" },
      "BB-1107": { ready: true, before: "One parcel at 18.2 kg", after: "Two parcels at 9.1 kg each" },
      "BB-1118": { ready: false, reason: "The service cannot be selected until volumetric weight is reviewed." },
      "BB-1088": { ready: true, before: "No depot scan for 48 hours", after: "Warehouse follow-up queued for the delayed scan" },
      "BB-1092": { ready: true, before: "Missed collection", after: "Collection rebooked for tomorrow" },
      "BB-1110": { ready: true, before: "Carrier scan received at 08:12", after: "Carrier handoff confirmed" },
      "BB-1120": { ready: false, reason: "No collection scan has arrived." },
      "BB-1095": { ready: true, affected: "BB-1096", before: "Potential duplicate of BB-1095", after: "Held as the later potential duplicate" },
      "BB-1096": { ready: true, before: "Potential duplicate of BB-1095", after: "Held as the later potential duplicate" },
      "BB-1112": { ready: true, before: "Similar order awaiting comparison", after: "Order confirmed distinct" },
      "BB-1123": { ready: false, reason: "Separate payment references make this case ambiguous." },
    };
    expect(proposals).toHaveLength(24);
    for (const [index, proposal] of proposals.entries()) {
      const orderId = orderIds[index]!;
      const outcome = expected[orderId]!;
      expect(proposal.ready).toBe(outcome.ready);
      if (!outcome.ready) {
        expect(proposal.changes).toEqual([]);
        expect(proposal.omissions).toEqual([{ orderId, reason: outcome.reason }]);
      } else {
        expect(proposal.changes[0]).toMatchObject({ orderId: outcome.affected ?? orderId, before: outcome.before, after: outcome.after });
        expect(proposal.changes[0]?.effect).toBeTruthy();
      }
    }
  });

  it("uses canonical duplicate state from either entry point and restores its displayed before value", async () => {
    const filename = await workspace();
    const viaEarlier = identity("duplicate-earlier@example.test");
    const direct = identity("duplicate-direct@example.test");
    const apply = (user: ReturnType<typeof identity>, orderId: string, key: string) => useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(user);
      const proposal = yield* repository.prepareResolution(user, 1, orderId);
      const commit = yield* repository.accept(user, 1, proposal.id, key);
      return { proposal, commit };
    }));
    const earlier = await apply(viaEarlier, "BB-1095", "duplicate-earlier-key");
    const directResult = await apply(direct, "BB-1096", "duplicate-direct-key");
    expect(earlier.proposal.changes[0]).toMatchObject({ orderId: "BB-1096", before: "Potential duplicate of BB-1095", after: "Held as the later potential duplicate" });
    expect(directResult.proposal.changes[0]).toMatchObject({ orderId: "BB-1096", before: "Potential duplicate of BB-1095", after: "Held as the later potential duplicate" });
    expect(earlier.commit.snapshot.orders.find((order) => order.id === "BB-1096")?.businessValue).toBe("Held as the later potential duplicate");
    expect(directResult.commit.snapshot.orders.find((order) => order.id === "BB-1096")?.businessValue).toBe("Held as the later potential duplicate");
    const database = new DatabaseSync(filename);
    const stored = database.prepare("SELECT state_json FROM orders WHERE user_id = ? AND order_id = 'BB-1096'").get(viaEarlier.id) as { state_json: string };
    expect(JSON.parse(stored.state_json)).toMatchObject({ relatedOrderId: "BB-1095", held: true });
    database.close();
    const undone = await useRepository(filename, (repository) => Effect.gen(function* () {
      const proposal = yield* repository.prepareUndo(viaEarlier, 1, earlier.commit.receipt.id);
      return yield* repository.accept(viaEarlier, 1, proposal.id, "duplicate-undo-key");
    }));
    expect(undone.snapshot.orders.find((order) => order.id === "BB-1096")?.businessValue).toBe("Potential duplicate of BB-1095");
    const restoredDatabase = new DatabaseSync(filename);
    const restored = restoredDatabase.prepare("SELECT state_json FROM orders WHERE user_id = ? AND order_id = 'BB-1096'").get(viaEarlier.id) as { state_json: string };
    restoredDatabase.close();
    expect(JSON.parse(restored.state_json)).toMatchObject({ summary: "Potential duplicate of BB-1095", relatedOrderId: "BB-1095", held: false });
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

  it("reads the latest order receipt through resolution, packing, and Undo without crossing users", async () => {
    const filename = await workspace();
    const owner = identity("progress-owner@example.test");
    const other = identity("progress-other@example.test");
    await useRepository(filename, (repository) => Effect.gen(function* () {
      const initial = yield* repository.orderProgress(owner, 1, "BB-1051");
      expect(initial).toMatchObject({ order: { version: 1, businessValue: "Blue stoneware mug, quantity 1, £24.00" }, completed: false, resolved: false, latestReceipt: null });
      yield* repository.advanceScenario(owner, 1);
      yield* repository.advanceScenario(owner, 1);
      yield* repository.advanceScenario(owner, 1);
      const proposal = yield* repository.prepareResolution(owner, 1, "BB-1051");
      const accepted = yield* repository.accept(owner, 1, proposal.id, "progress-resolution-key");
      const resolved = yield* repository.orderProgress(owner, 1, "BB-1051");
      expect(resolved).toMatchObject({ order: { status: "ready", version: 2, businessValue: "Sage stoneware mug, quantity 1, £24.00" }, completed: false, resolved: true, latestReceipt: { id: accepted.receipt.id, kind: "accept", committedVersion: 2, totalChanges: 1, change: { before: "Blue stoneware mug, quantity 1, £24.00", after: "Sage stoneware mug, quantity 1, £24.00" } } });
      expect(resolved?.latestReceipt?.change).not.toHaveProperty("expectedVersion");
      expect((yield* repository.orderProgress(other, 1, "BB-1051"))?.latestReceipt).toBeNull();
      const batch = yield* repository.prepareBatch(owner, 1);
      expect(batch.changes.some((change) => change.orderId === "BB-1051")).toBe(true);
      const packed = yield* repository.accept(owner, 1, batch.id, "progress-packing-key");
      const completed = yield* repository.orderProgress(owner, 1, "BB-1051");
      expect(completed).toMatchObject({ order: { version: 3, businessValue: "Sage stoneware mug, quantity 1, £24.00" }, completed: true, resolved: true, latestReceipt: { id: packed.receipt.id, kind: "accept", committedVersion: 3, totalChanges: 6, change: { orderId: "BB-1051", after: "Sage stoneware mug, quantity 1, £24.00 · Packing" } } });
      const undoBatch = yield* repository.prepareUndo(owner, 1, packed.receipt.id);
      expect(undoBatch.changes.map((change) => change.orderId).sort()).toEqual(batch.changes.map((change) => change.orderId).sort());
      expect((yield* repository.snapshot(owner)).orders.some((order) => order.id === "BB-1051")).toBe(false);
      const otherProposal = yield* repository.prepareResolution(other, 1, "BB-1051");
      const otherReceipt = (yield* repository.accept(other, 1, otherProposal.id, "progress-other-key")).receipt;
      const undo = yield* repository.prepareUndo(other, 1, otherReceipt.id);
      const undone = (yield* repository.accept(other, 1, undo.id, "progress-undo-key")).receipt;
      expect(yield* repository.orderProgress(other, 1, "BB-1051")).toMatchObject({ order: { version: 3, businessValue: "Blue stoneware mug, quantity 1, £24.00" }, completed: false, resolved: false, latestReceipt: { id: undone.id, kind: "undo", committedVersion: 3, change: { after: "Blue stoneware mug, quantity 1, £24.00" } } });
    }));
    const database = new DatabaseSync(filename);
    const stock = database.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND sku = 'MUG-SAGE'").get(owner.id) as { quantity: number };
    database.close();
    expect(Number(stock.quantity)).toBe(0);
  });

  it("keeps an already reserved replacement ready when later stock is exhausted", async () => {
    const filename = await workspace();
    const user = identity("reserved-readiness@example.test");
    await useRepository(filename, (repository) => Effect.gen(function* () {
      yield* repository.snapshot(user);
      const proposal = yield* repository.prepareResolution(user, 1, "BB-1051");
      yield* repository.accept(user, 1, proposal.id, "reserved-ready-key");
      yield* repository.advanceScenario(user, 1);
      yield* repository.advanceScenario(user, 1);
      yield* repository.advanceScenario(user, 1);
    }));
    const snapshot = await useRepository(filename, (repository) => repository.snapshot(user));
    expect(snapshot.orders.find((order) => order.id === "BB-1051")).toMatchObject({ status: "ready", statusLabel: "Ready", businessValue: "Sage stoneware mug, quantity 1, £24.00" });
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
    seededState.prepare("INSERT INTO tutorial_state (user_id, generation, tutorial_id, instance_id, step, active) VALUES (?, 1, 'address-correction', 'tutorial-before-reset', 2, 1)").run(first.id);
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
    expect(audit).toEqual([{ kind: "receipt", generation: 1 }, { kind: "reset", generation: 2 }]);
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
    const exhausted = await useRepository(filename, (repository) => repository.snapshot(user));
    expect(exhausted.orders.find((order) => order.id === "BB-1051")).toMatchObject({ status: "review", statusLabel: "Review" });
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
