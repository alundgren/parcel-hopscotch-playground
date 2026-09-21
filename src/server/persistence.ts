import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import type { CommandReceipt, OrderStatus, ReviewedProposal, WorkspaceSnapshot } from "../shared/contracts.js";
import { targets } from "../shared/targets.js";
import { evaluateResolution, resolutionFacts, type InventoryCondition, type OrderBusinessState, type ResolutionPolicy } from "./fulfilment.js";
import type { RequestIdentity } from "./identity.js";
import { seedOrders } from "./seeds.js";

export class WorkspaceStoreError extends Schema.TaggedError<WorkspaceStoreError>()("WorkspaceStoreError", { message: Schema.String }) {}
export class WorkspaceCommandError extends Schema.TaggedError<WorkspaceCommandError>()("WorkspaceCommandError", { code: Schema.String, message: Schema.String }) {}

interface PreparedPolicy extends ResolutionPolicy { readonly priorStatus: OrderStatus; readonly priorIssue: string; readonly priorCompleted: number; readonly priorResolved: number; readonly priorState: OrderBusinessState; readonly nextCompleted: number; readonly nextResolved: number }
interface StoredProposal { readonly public: ReviewedProposal; readonly policies: ReadonlyArray<PreparedPolicy>; readonly undoReceiptId?: string }
interface AppliedChange extends PreparedPolicy { readonly committedVersion: number }
interface StoredReceipt { readonly public: CommandReceipt; readonly applied: ReadonlyArray<AppliedChange> }

export interface CommandCommit { readonly receipt: CommandReceipt; readonly snapshot: WorkspaceSnapshot; readonly generationChanged: boolean }
export interface ScenarioCommit { readonly message: string; readonly snapshot: WorkspaceSnapshot }
export interface WorkspaceRepositoryService {
  readonly snapshot: (identity: RequestIdentity, now?: number) => Effect.Effect<WorkspaceSnapshot, WorkspaceStoreError>;
  readonly orderIds: (identity: RequestIdentity) => Effect.Effect<ReadonlyArray<string>, WorkspaceStoreError>;
  readonly prepareResolution: (identity: RequestIdentity, generation: number, orderId: string) => Effect.Effect<ReviewedProposal, WorkspaceCommandError>;
  readonly prepareBatch: (identity: RequestIdentity, generation: number) => Effect.Effect<ReviewedProposal, WorkspaceCommandError>;
  readonly prepareUndo: (identity: RequestIdentity, generation: number, receiptId: string) => Effect.Effect<ReviewedProposal, WorkspaceCommandError>;
  readonly prepareReset: (identity: RequestIdentity, generation: number) => Effect.Effect<ReviewedProposal, WorkspaceCommandError>;
  readonly accept: (identity: RequestIdentity, generation: number, proposalId: string, idempotencyKey: string) => Effect.Effect<CommandCommit, WorkspaceCommandError | WorkspaceStoreError>;
  readonly advanceScenario: (identity: RequestIdentity, generation: number) => Effect.Effect<ScenarioCommit, WorkspaceCommandError | WorkspaceStoreError>;
}
export class WorkspaceRepository extends Context.Service<WorkspaceRepository, WorkspaceRepositoryService>()("parcel-hopscotch/WorkspaceRepository") {}

const statusLabels: Record<OrderStatus, string> = { ready: "Ready", review: "Review", waiting: "Waiting" };
const ageLabel = (occurredAt: string, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(occurredAt)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
};
const fail = (code: string, message: string) => new WorkspaceCommandError({ code, message });
const transact = <A>(database: DatabaseSync, run: () => A): A => {
  database.exec("BEGIN IMMEDIATE");
  try { const value = run(); database.exec("COMMIT"); return value; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
};

const migrate = (database: DatabaseSync) => {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, identity_digest TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (user_id TEXT NOT NULL, order_id TEXT NOT NULL, item TEXT NOT NULL, issue TEXT NOT NULL, status TEXT NOT NULL, family TEXT NOT NULL, seed_position INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, completed INTEGER NOT NULL DEFAULT 0, resolved INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (user_id, order_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS order_evidence (user_id TEXT NOT NULL, order_id TEXT NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY (user_id, order_id, label), FOREIGN KEY (user_id, order_id) REFERENCES orders(user_id, order_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS inventory (user_id TEXT NOT NULL, sku TEXT NOT NULL, quantity INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (user_id, sku), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS scenario_events (user_id TEXT NOT NULL, generation INTEGER NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY (user_id, generation, sequence), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation INTEGER NOT NULL, proposal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_json TEXT NOT NULL, committed_at TEXT NOT NULL, undone_by TEXT, UNIQUE (user_id, generation, idempotency_key), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS tutorial_state (user_id TEXT NOT NULL, generation INTEGER NOT NULL, tutorial_id TEXT NOT NULL, step INTEGER NOT NULL, PRIMARY KEY (user_id, generation, tutorial_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS audit_records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL, body_json TEXT NOT NULL, completed_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  `);
  const columns = database.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "version")) database.exec("ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  if (!columns.some((column) => column.name === "completed")) database.exec("ALTER TABLE orders ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "resolved")) database.exec("ALTER TABLE orders ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "state_json")) database.exec("ALTER TABLE orders ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}'");
};

const seedUser = (database: DatabaseSync, userId: string) => {
  const count = database.prepare("SELECT COUNT(*) AS count FROM orders WHERE user_id = ?").get(userId) as { count: number };
  if (Number(count.count) === 0) {
    const order = database.prepare("INSERT INTO orders (user_id, order_id, item, issue, status, family, seed_position, version, completed, resolved, state_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)");
    const evidence = database.prepare("INSERT INTO order_evidence (user_id, order_id, label, value, occurred_at) VALUES (?, ?, ?, ?, ?)");
    seedOrders.forEach((item, position) => { order.run(userId, item.id, item.item, item.issue, item.status, item.family, position, JSON.stringify(resolutionFacts[item.id]!.before)); evidence.run(userId, item.id, item.evidenceLabel, item.evidenceValue, item.occurredAt); });
  }
  const hydrate = database.prepare("UPDATE orders SET state_json = ? WHERE user_id = ? AND order_id = ? AND state_json = '{}'");
  seedOrders.forEach((item) => hydrate.run(JSON.stringify(resolutionFacts[item.id]!.before), userId, item.id));
  const inventory = database.prepare("INSERT OR IGNORE INTO inventory (user_id, sku, quantity, version) VALUES (?, ?, ?, 1)");
  inventory.run(userId, "MUG-SAGE", 4);
  inventory.run(userId, "SIDE-PLATE", 3);
  inventory.run(userId, "THROW-NATURAL", 2);
  inventory.run(userId, "CARAFE-SMOKE", 2);
};

const ensureUser = (database: DatabaseSync, identity: RequestIdentity) => {
  database.prepare("INSERT OR IGNORE INTO users (id, identity_digest, generation, created_at) VALUES (?, ?, 1, ?)").run(identity.id, identity.digest, new Date().toISOString());
  const user = database.prepare("SELECT id, generation FROM users WHERE identity_digest = ?").get(identity.digest) as { id: string; generation: number } | undefined;
  if (user === undefined) throw new Error("Identity row was not created.");
  seedUser(database, user.id);
  return { id: user.id, generation: Number(user.generation) };
};

const sequenceFor = (database: DatabaseSync, userId: string, generation: number) => Number((database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM scenario_events WHERE user_id = ? AND generation = ?").get(userId, generation) as { sequence: number }).sequence);
const appendEvent = (database: DatabaseSync, userId: string, generation: number, kind: string, payload: unknown) => {
  const sequence = sequenceFor(database, userId, generation) + 1;
  database.prepare("INSERT INTO scenario_events (user_id, generation, sequence, kind, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)").run(userId, generation, sequence, kind, JSON.stringify(payload), new Date().toISOString());
  return sequence;
};

const readSnapshot = (database: DatabaseSync, identity: RequestIdentity, now = Date.now()): WorkspaceSnapshot => {
  const user = ensureUser(database, identity);
  const orders = database.prepare(`SELECT order_id, item, issue, status, family, version, state_json FROM orders WHERE user_id = ? AND completed = 0 ORDER BY CASE order_id WHEN 'BB-1051' THEN 0 WHEN 'BB-1063' THEN 1 WHEN 'BB-1042' THEN 2 WHEN 'BB-1088' THEN 3 ELSE 4 END, seed_position`).all(user.id) as Array<{ order_id: string; item: string; issue: string; status: OrderStatus; family: WorkspaceSnapshot["orders"][number]["family"]; version: number; state_json: string }>;
  const evidence = database.prepare("SELECT order_id, label, value, occurred_at FROM order_evidence WHERE user_id = ? ORDER BY order_id, occurred_at").all(user.id) as Array<{ order_id: string; label: string; value: string; occurred_at: string }>;
  const receipt = database.prepare("SELECT payload_json FROM receipts WHERE user_id = ? AND generation = ? ORDER BY committed_at DESC, rowid DESC LIMIT 1").get(user.id, user.generation) as { payload_json: string } | undefined;
  return {
    generation: user.generation,
    sequence: sequenceFor(database, user.id, user.generation),
    orders: orders.map((item) => ({ id: item.order_id, item: item.item, issue: item.issue, status: item.status, statusLabel: statusLabels[item.status], family: item.family, version: Number(item.version), businessValue: (JSON.parse(item.state_json) as OrderBusinessState).summary, targetId: targets.orderRow(item.order_id), evidence: evidence.filter((entry) => entry.order_id === item.order_id).map((entry) => ({ label: entry.label, value: entry.value, occurredAt: entry.occurred_at, age: ageLabel(entry.occurred_at, now) })) })),
    latestReceipt: receipt === undefined ? null : (JSON.parse(receipt.payload_json) as StoredReceipt).public,
  };
};

const expectGeneration = (actual: number, expected: number) => { if (actual !== expected) throw fail("generation_changed", "This workspace was reset. Refresh before continuing."); };
const rowFor = (database: DatabaseSync, userId: string, orderId: string) => database.prepare("SELECT order_id AS id, item, issue, status, family, version, completed, resolved, state_json FROM orders WHERE user_id = ? AND order_id = ?").get(userId, orderId) as ({ id: string; item: string; issue: string; status: OrderStatus; family: WorkspaceSnapshot["orders"][number]["family"]; version: number; completed: number; resolved: number; state_json: string } | undefined);
const inventoryFor = (database: DatabaseSync, userId: string, sku: string) => {
  const row = database.prepare("SELECT quantity, version FROM inventory WHERE user_id = ? AND sku = ?").get(userId, sku) as { quantity: number; version: number } | undefined;
  return row === undefined ? null : { sku, quantity: Number(row.quantity), version: Number(row.version) };
};
const storeProposal = (database: DatabaseSync, userId: string, stored: StoredProposal) => {
  database.prepare("INSERT INTO proposals (id, user_id, generation, status, payload_json, created_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(stored.public.id, userId, stored.public.generation, JSON.stringify(stored), stored.public.createdAt);
  return stored.public;
};
const makePublic = (generation: number, kind: ReviewedProposal["kind"], title: string, policies: ReadonlyArray<PreparedPolicy>, omissions: ReviewedProposal["omissions"], effects: ReadonlyArray<string>, ready = true): ReviewedProposal => ({ id: `proposal_${randomUUID()}`, generation, kind, title, ready, changes: policies.map((policy) => policy.change), omissions, effects, createdAt: new Date().toISOString() });
const preparePolicy = (database: DatabaseSync, userId: string, orderId: string): { readonly ready: true; readonly policy: PreparedPolicy } | { readonly ready: false; readonly reason: string } => {
  const selected = rowFor(database, userId, orderId);
  if (selected === undefined) throw fail("order_not_found", "That order is not in this workspace.");
  if (Number(selected.completed) !== 0) throw fail("order_completed", "That order already moved to packing.");
  if (Number(selected.resolved) !== 0) throw fail("already_resolved", "That resolution was already accepted.");
  const facts = resolutionFacts[orderId];
  if (facts === undefined) throw fail("policy_missing", "This order has no resolution policy.");
  const affected = facts.affectedOrderId === undefined ? selected : rowFor(database, userId, facts.affectedOrderId);
  if (affected === undefined) throw fail("order_not_found", "The affected order is not in this workspace.");
  if (Number(affected.completed) !== 0 || Number(affected.resolved) !== 0) throw fail("already_resolved", "That resolution was already accepted.");
  const stock = facts.inventory === undefined ? null : inventoryFor(database, userId, facts.inventory.sku);
  const evaluation = evaluateResolution(selected, facts, Number(affected.version), stock);
  if (!evaluation.ready) return evaluation;
  return { ready: true, policy: { ...evaluation.policy, priorStatus: affected.status, priorIssue: affected.issue, priorCompleted: Number(affected.completed), priorResolved: Number(affected.resolved), priorState: JSON.parse(affected.state_json) as OrderBusinessState, nextCompleted: Number(affected.completed), nextResolved: 1 } };
};

const repositoryLayer = (filename: string) => Layer.effect(WorkspaceRepository, Effect.acquireRelease(
  Effect.sync(() => { const database = new DatabaseSync(filename); migrate(database); return database; }),
  (database) => Effect.sync(() => database.close()),
).pipe(Effect.map((database) => {
  const command = <A>(run: () => A) => Effect.try({ try: run, catch: (error) => error instanceof WorkspaceCommandError ? error : fail("command_failed", String(error)) });
  const snapshot: WorkspaceRepositoryService["snapshot"] = (identity, now) => Effect.try({ try: () => readSnapshot(database, identity, now), catch: (error) => new WorkspaceStoreError({ message: `Could not read the workspace: ${String(error)}` }) });
  const orderIds: WorkspaceRepositoryService["orderIds"] = (identity) => snapshot(identity).pipe(Effect.map((state) => state.orders.map((order) => order.id)));
  const prepareResolution: WorkspaceRepositoryService["prepareResolution"] = (identity, generation, orderId) => command(() => transact(database, () => {
    const user = ensureUser(database, identity); expectGeneration(user.generation, generation);
    const evaluated = preparePolicy(database, user.id, orderId);
    const title = resolutionFacts[orderId]?.before === undefined ? `Review ${orderId}` : resolutionFacts[orderId]!.before.summary.includes("Willow Lane") ? "Check address" : `Review ${orderId}`;
    const policies = evaluated.ready ? [evaluated.policy] : [];
    const publicProposal = makePublic(generation, "resolution", title, policies, evaluated.ready ? [] : [{ orderId, reason: evaluated.reason }], evaluated.ready ? [] : [evaluated.reason], evaluated.ready);
    return storeProposal(database, user.id, { public: publicProposal, policies });
  }));
  const prepareBatch: WorkspaceRepositoryService["prepareBatch"] = (identity, generation) => command(() => transact(database, () => {
    const user = ensureUser(database, identity); expectGeneration(user.generation, generation);
    const rows = database.prepare("SELECT order_id, item, issue, status, family, version, completed, resolved, state_json FROM orders WHERE user_id = ? ORDER BY seed_position").all(user.id) as Array<{ order_id: string; item: string; issue: string; status: OrderStatus; family: WorkspaceSnapshot["orders"][number]["family"]; version: number; completed: number; resolved: number; state_json: string }>;
    const included = rows.filter((row) => row.status === "ready" && Number(row.completed) === 0);
    if (included.length === 0) throw fail("nothing_ready", "No orders currently pass the ready checks.");
    const policies: Array<PreparedPolicy> = [];
    const omissions = rows.filter((row) => row.status !== "ready" && Number(row.completed) === 0).map((row) => ({ orderId: row.order_id, reason: row.issue }));
    for (const row of included) {
      if (Number(row.resolved) !== 0) {
        const current = JSON.parse(row.state_json) as OrderBusinessState;
        policies.push({ change: { orderId: row.order_id, family: row.family, before: `${current.summary} · Ready`, after: `${current.summary} · Packing`, effect: "Release this checked order to packing.", expectedVersion: Number(row.version) }, nextStatus: "ready", nextIssue: "Released to packing after review.", nextState: current, inventory: null, priorStatus: row.status, priorIssue: row.issue, priorCompleted: Number(row.completed), priorResolved: Number(row.resolved), priorState: current, nextCompleted: 1, nextResolved: 1 });
        continue;
      }
      const evaluated = preparePolicy(database, user.id, row.order_id);
      if (!evaluated.ready) { omissions.push({ orderId: row.order_id, reason: evaluated.reason }); continue; }
      policies.push({ ...evaluated.policy, change: { ...evaluated.policy.change, after: `${evaluated.policy.change.after} · Packing` }, nextCompleted: 1 });
    }
    if (policies.length === 0) throw fail("nothing_ready", "No orders currently pass the ready checks.");
    const publicProposal = makePublic(generation, "batch", `Review ${policies.length} changes`, policies, omissions, [`${policies.length} orders will move to packing.`, `${omissions.length} orders are left out.`]);
    return storeProposal(database, user.id, { public: publicProposal, policies });
  }));
  const prepareUndo: WorkspaceRepositoryService["prepareUndo"] = (identity, generation, receiptId) => command(() => transact(database, () => {
    const user = ensureUser(database, identity); expectGeneration(user.generation, generation);
    const receiptRow = database.prepare("SELECT payload_json, undone_by FROM receipts WHERE id = ? AND user_id = ? AND generation = ?").get(receiptId, user.id, generation) as { payload_json: string; undone_by: string | null } | undefined;
    if (receiptRow === undefined) throw fail("receipt_not_found", "That receipt is not available in this workspace.");
    if (receiptRow.undone_by !== null) throw fail("already_undone", "That receipt was already undone.");
    const receipt = JSON.parse(receiptRow.payload_json) as StoredReceipt;
    if (!receipt.public.undoable) throw fail("undo_unavailable", "This receipt cannot be undone.");
    const policies = receipt.applied.map((applied): PreparedPolicy => {
      const current = rowFor(database, user.id, applied.change.orderId);
      if (current === undefined || Number(current.version) !== applied.committedVersion) throw fail("undo_conflict", `${applied.change.orderId} changed after this receipt. Undo cannot overwrite later work.`);
      const inventory = applied.inventory === null ? null : { ...applied.inventory, expectedVersion: inventoryFor(database, user.id, applied.inventory.sku)?.version ?? -1, quantity: -applied.inventory.quantity };
      return { change: { orderId: applied.change.orderId, family: applied.change.family, before: applied.change.after, after: applied.change.before, effect: `Reverse: ${applied.change.effect}`, expectedVersion: applied.committedVersion }, nextStatus: applied.priorStatus, nextIssue: applied.priorIssue, nextState: applied.priorState, inventory, priorStatus: current.status, priorIssue: current.issue, priorCompleted: Number(current.completed), priorResolved: Number(current.resolved), priorState: JSON.parse(current.state_json) as OrderBusinessState, nextCompleted: applied.priorCompleted, nextResolved: applied.priorResolved };
    });
    const publicProposal = makePublic(generation, "undo", `Undo ${receipt.public.title}`, policies, [], ["Restore the listed orders only if none changed after the receipt."]);
    return storeProposal(database, user.id, { public: publicProposal, policies, undoReceiptId: receiptId });
  }));
  const prepareReset: WorkspaceRepositoryService["prepareReset"] = (identity, generation) => command(() => transact(database, () => {
    const user = ensureUser(database, identity); expectGeneration(user.generation, generation);
    const publicProposal = makePublic(generation, "reset", "Reset my demo", [], [], ["Restore all 24 first-login orders and inventory.", "Clear chat, tutorials, scenario progress and pending proposals.", "Keep audit history and add a reset marker."]);
    return storeProposal(database, user.id, { public: publicProposal, policies: [] });
  }));

  const accept: WorkspaceRepositoryService["accept"] = (identity, generation, proposalId, idempotencyKey) => command(() => transact(database, () => {
    if (idempotencyKey.trim().length < 8) throw fail("invalid_idempotency_key", "The acceptance key is invalid.");
    const user = ensureUser(database, identity); expectGeneration(user.generation, generation);
    const proposalRow = database.prepare("SELECT status, payload_json FROM proposals WHERE id = ? AND user_id = ? AND generation = ?").get(proposalId, user.id, generation) as { status: string; payload_json: string } | undefined;
    if (proposalRow === undefined) throw fail("proposal_not_found", "This proposal is unavailable or belongs to an earlier workspace.");
    const stored = JSON.parse(proposalRow.payload_json) as StoredProposal;
    const keyed = database.prepare("SELECT proposal_id, payload_json FROM receipts WHERE user_id = ? AND generation = ? AND idempotency_key = ?").get(user.id, generation, idempotencyKey) as { proposal_id: string; payload_json: string } | undefined;
    if (keyed !== undefined) {
      if (keyed.proposal_id !== proposalId) throw fail("idempotency_conflict", "That acceptance key was already used for another proposal.");
      return { receipt: (JSON.parse(keyed.payload_json) as StoredReceipt).public, snapshot: readSnapshot(database, identity), generationChanged: false };
    }
    const priorReceipt = database.prepare("SELECT payload_json FROM receipts WHERE user_id = ? AND generation = ? AND proposal_id = ? ORDER BY committed_at LIMIT 1").get(user.id, generation, proposalId) as { payload_json: string } | undefined;
    if (proposalRow.status === "accepted") {
      if (priorReceipt === undefined) throw fail("proposal_state_invalid", "The accepted proposal has no receipt.");
      return { receipt: (JSON.parse(priorReceipt.payload_json) as StoredReceipt).public, snapshot: readSnapshot(database, identity), generationChanged: false };
    }
    if (proposalRow.status !== "pending") throw fail("proposal_unavailable", "This proposal is no longer available.");
    if (!stored.public.ready) throw fail("proposal_not_ready", "This proposal is held and cannot be accepted.");
    if (stored.public.kind === "reset") {
      const nextGeneration = generation + 1;
      database.prepare("DELETE FROM order_evidence WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM orders WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM inventory WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM proposals WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM receipts WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM chat_messages WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM tutorial_state WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM scenario_events WHERE user_id = ?").run(user.id);
      database.prepare("UPDATE users SET generation = ? WHERE id = ?").run(nextGeneration, user.id);
      seedUser(database, user.id);
      appendEvent(database, user.id, nextGeneration, "workspace.reset", { fromGeneration: generation });
      const publicReceipt: CommandReceipt = { id: `receipt_${randomUUID()}`, proposalId, generation: nextGeneration, kind: "reset", title: "Demo reset", changes: [], committedAt: new Date().toISOString(), undoable: false };
      const payload: StoredReceipt = { public: publicReceipt, applied: [] };
      database.prepare("INSERT INTO receipts (id, user_id, generation, proposal_id, idempotency_key, payload_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(publicReceipt.id, user.id, nextGeneration, proposalId, idempotencyKey, JSON.stringify(payload), publicReceipt.committedAt);
      database.prepare("INSERT INTO audit_records (id, user_id, generation, kind, body_json, completed_at) VALUES (?, ?, ?, 'reset', ?, ?)").run(`audit_${randomUUID()}`, user.id, nextGeneration, JSON.stringify({ fromGeneration: generation, receiptId: publicReceipt.id }), publicReceipt.committedAt);
      return { receipt: publicReceipt, snapshot: readSnapshot(database, identity), generationChanged: true };
    }
    const inventoryNeeds = new Map<string, { quantity: number; expectedVersion: number }>();
    for (const policy of stored.policies) {
      const current = rowFor(database, user.id, policy.change.orderId);
      if (current === undefined || Number(current.version) !== policy.change.expectedVersion) throw fail("stale_proposal", `${policy.change.orderId} changed after review. Nothing was applied.`);
      if (policy.inventory !== null) {
        const need = inventoryNeeds.get(policy.inventory.sku);
        inventoryNeeds.set(policy.inventory.sku, { quantity: (need?.quantity ?? 0) + policy.inventory.quantity, expectedVersion: policy.inventory.expectedVersion });
      }
    }
    for (const [sku, need] of inventoryNeeds) {
      const stock = inventoryFor(database, user.id, sku);
      if (stock === null || stock.version !== need.expectedVersion || stock.quantity < need.quantity) throw fail("stale_proposal", `Stock for ${sku} changed after review. Nothing was applied.`);
    }
    const applied: Array<AppliedChange> = [];
    for (const policy of stored.policies) {
      database.prepare("UPDATE orders SET status = ?, issue = ?, completed = ?, resolved = ?, state_json = ?, version = version + 1 WHERE user_id = ? AND order_id = ?").run(policy.nextStatus, policy.nextIssue, policy.nextCompleted, policy.nextResolved, JSON.stringify(policy.nextState), user.id, policy.change.orderId);
      if (policy.inventory !== null) database.prepare("UPDATE inventory SET quantity = quantity - ?, version = version + 1 WHERE user_id = ? AND sku = ?").run(policy.inventory.quantity, user.id, policy.inventory.sku);
      applied.push({ ...policy, committedVersion: policy.change.expectedVersion + 1 });
    }
    const sequence = appendEvent(database, user.id, generation, stored.public.kind === "undo" ? "work.undone" : "proposal.accepted", { proposalId });
    const publicReceipt: CommandReceipt = { id: `receipt_${randomUUID()}`, proposalId, generation, kind: stored.public.kind === "undo" ? "undo" : "accept", title: stored.public.kind === "undo" ? stored.public.title : stored.public.kind === "batch" ? `${stored.public.changes.length} orders ready to pack` : `${stored.public.changes.length} ${stored.public.changes.length === 1 ? "change" : "changes"} accepted`, changes: stored.public.changes, committedAt: new Date().toISOString(), undoable: stored.public.kind !== "undo" };
    const receiptPayload: StoredReceipt = { public: publicReceipt, applied };
    database.prepare("INSERT INTO receipts (id, user_id, generation, proposal_id, idempotency_key, payload_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(publicReceipt.id, user.id, generation, proposalId, idempotencyKey, JSON.stringify(receiptPayload), publicReceipt.committedAt);
    database.prepare("UPDATE proposals SET status = 'accepted' WHERE id = ? AND user_id = ?").run(proposalId, user.id);
    if (stored.undoReceiptId !== undefined) database.prepare("UPDATE receipts SET undone_by = ? WHERE id = ? AND user_id = ?").run(publicReceipt.id, stored.undoReceiptId, user.id);
    database.prepare("INSERT INTO audit_records (id, user_id, generation, kind, body_json, completed_at) VALUES (?, ?, ?, 'command', ?, ?)").run(`audit_${randomUUID()}`, user.id, generation, JSON.stringify({ proposalId, receiptId: publicReceipt.id, sequence }), publicReceipt.committedAt);
    return { receipt: publicReceipt, snapshot: readSnapshot(database, identity), generationChanged: false };
  }));

  const advanceScenario: WorkspaceRepositoryService["advanceScenario"] = (identity, generation) => command(() => transact(database, () => {
    const user = ensureUser(database, identity); expectGeneration(user.generation, generation);
    const stock = database.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND sku = 'MUG-SAGE'").get(user.id) as { quantity: number };
    if (Number(stock.quantity) <= 0) throw fail("scenario_complete", "The stock-change scenario has no further step.");
    database.prepare("UPDATE inventory SET quantity = quantity - 1, version = version + 1 WHERE user_id = ? AND sku = 'MUG-SAGE'").run(user.id);
    appendEvent(database, user.id, generation, "scenario.stock_changed", { sku: "MUG-SAGE", quantity: Number(stock.quantity) - 1 });
    return { message: "Scenario advanced: sage mug stock changed.", snapshot: readSnapshot(database, identity) };
  }));
  return WorkspaceRepository.of({ snapshot, orderIds, prepareResolution, prepareBatch, prepareUndo, prepareReset, accept, advanceScenario });
})));

export const workspacePersistenceLayer = (filename: string) => repositoryLayer(filename);
export const runWithWorkspaceRepository = <A, E>(filename: string, effect: Effect.Effect<A, E, WorkspaceRepository>): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(workspacePersistenceLayer(filename)), Effect.scoped));
