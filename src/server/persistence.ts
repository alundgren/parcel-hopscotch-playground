import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import type { AgentViewContext, CommandReceipt, OrderStatus, ReviewedProposal, WorkspaceSnapshot } from "../shared/contracts.js";
import type { ChatMessage } from "./providers/contracts.js";
import { targets } from "../shared/targets.js";
import { evaluateResolution, initialStateFor, materializeResolution, resolutionBlockReason, resolutionFacts, type InventoryCondition, type OrderBusinessState, type ResolutionPolicy } from "./fulfilment.js";
import type { RequestIdentity } from "./identity.js";
import { seedOrders } from "./seeds.js";
import type { ProviderAttemptFinish, ProviderAttemptRecord, ProviderAttemptRepository, ProviderAttemptStart, ProviderAttemptSummary } from "./providers/audit.js";
import { redactProviderAudit, redactProviderString } from "./providers/redaction.js";

export class WorkspaceStoreError extends Schema.TaggedError<WorkspaceStoreError>()("WorkspaceStoreError", { message: Schema.String }) {}
export class WorkspaceCommandError extends Schema.TaggedError<WorkspaceCommandError>()("WorkspaceCommandError", { code: Schema.String, message: Schema.String }) {}

interface PreparedPolicy extends ResolutionPolicy { readonly priorStatus: OrderStatus; readonly priorIssue: string; readonly priorCompleted: number; readonly priorResolved: number; readonly priorState: OrderBusinessState; readonly nextCompleted: number; readonly nextResolved: number }
interface StoredProposal { readonly public: ReviewedProposal; readonly policies: ReadonlyArray<PreparedPolicy>; readonly undoReceiptId?: string }
interface AppliedChange extends PreparedPolicy { readonly committedVersion: number }
interface StoredReceipt { readonly public: CommandReceipt; readonly applied: ReadonlyArray<AppliedChange> }

export interface CommandCommit { readonly receipt: CommandReceipt; readonly snapshot: WorkspaceSnapshot; readonly generationChanged: boolean }
export interface ScenarioCommit { readonly message: string; readonly snapshot: WorkspaceSnapshot }
export interface AgentTurnRecord {
  readonly id: string;
  readonly generation: number;
  readonly requestId: string;
  readonly connectionId: string;
  readonly status: NonNullable<WorkspaceSnapshot["activeTurn"]>["status"];
  readonly phase: string;
  readonly history: ReadonlyArray<ChatMessage>;
  readonly error: string | null;
  readonly proposalId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly completeDurationMs: number | null;
  readonly measurement: NonNullable<WorkspaceSnapshot["activeTurn"]>["measurement"];
}
export interface AgentTurnUpdate {
  readonly status: AgentTurnRecord["status"];
  readonly phase: string;
  readonly history: ReadonlyArray<ChatMessage>;
  readonly error?: string | null;
  readonly proposalId?: string | null;
  readonly finishedAt?: string | null;
  readonly measurement?: AgentTurnRecord["measurement"];
}
export type ResolvedAgentViewContext =
  | { readonly view: "work" | "explore" | "audit"; readonly focus: null }
  | { readonly view: "work"; readonly focus: { readonly kind: "order"; readonly order: { readonly id: string; readonly item: string; readonly issue: string; readonly status: OrderStatus; readonly businessValue: string; readonly evidence: ReadonlyArray<{ readonly label: string; readonly value: string }> } } }
  | { readonly view: "work"; readonly focus: { readonly kind: "proposal"; readonly proposal: Pick<ReviewedProposal, "id" | "kind" | "title" | "ready" | "changes" | "omissions" | "effects"> } }
  | { readonly view: "work"; readonly focus: { readonly kind: "receipt"; readonly receipt: Pick<CommandReceipt, "id" | "kind" | "title" | "changes" | "undoable"> } };
export interface WorkspaceRepositoryService extends ProviderAttemptRepository {
  readonly snapshot: (identity: RequestIdentity, now?: number) => Effect.Effect<WorkspaceSnapshot, WorkspaceStoreError>;
  readonly orderIds: (identity: RequestIdentity) => Effect.Effect<ReadonlyArray<string>, WorkspaceStoreError>;
  readonly prepareResolution: (identity: RequestIdentity, generation: number, orderId: string) => Effect.Effect<ReviewedProposal, WorkspaceCommandError>;
  readonly prepareBatch: (identity: RequestIdentity, generation: number) => Effect.Effect<ReviewedProposal, WorkspaceCommandError>;
  readonly prepareUndo: (identity: RequestIdentity, generation: number, receiptId: string) => Effect.Effect<ReviewedProposal, WorkspaceCommandError>;
  readonly prepareReset: (identity: RequestIdentity, generation: number) => Effect.Effect<ReviewedProposal, WorkspaceCommandError>;
  readonly accept: (identity: RequestIdentity, generation: number, proposalId: string, idempotencyKey: string) => Effect.Effect<CommandCommit, WorkspaceCommandError | WorkspaceStoreError>;
  readonly advanceScenario: (identity: RequestIdentity, generation: number) => Effect.Effect<ScenarioCommit, WorkspaceCommandError | WorkspaceStoreError>;
  readonly createAgentTurn: (identity: RequestIdentity, generation: number, turnId: string, requestId: string, connectionId: string, message: string) => Effect.Effect<{ readonly created: boolean; readonly turn: AgentTurnRecord }, WorkspaceCommandError>;
  readonly updateAgentTurn: (identity: RequestIdentity, generation: number, turnId: string, update: AgentTurnUpdate) => Effect.Effect<AgentTurnRecord, WorkspaceCommandError>;
  readonly agentTurn: (identity: RequestIdentity, generation: number, turnId: string) => Effect.Effect<AgentTurnRecord | null, WorkspaceCommandError>;
  readonly agentHistories: (identity: RequestIdentity, generation: number, excludeTurnId: string, limit?: number) => Effect.Effect<ReadonlyArray<ReadonlyArray<ChatMessage>>, WorkspaceCommandError>;
  readonly resolveAgentViewContext: (identity: RequestIdentity, generation: number, context: AgentViewContext) => Effect.Effect<ResolvedAgentViewContext, WorkspaceCommandError>;
  readonly completeAgentMeasurement: (identity: RequestIdentity, generation: number, turnId: string, durationMs: number) => Effect.Effect<void, WorkspaceCommandError>;
  readonly recordCommandMeasurement: (identity: RequestIdentity, generation: number, receiptId: string, durationMs: number) => Effect.Effect<void, WorkspaceCommandError>;
  readonly markAgentConnectionIncomplete: (identity: RequestIdentity, connectionId: string) => Effect.Effect<void>;
  readonly recoverAgentTurns: () => Effect.Effect<number>;
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
    CREATE TABLE IF NOT EXISTS agent_turns (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      history_json TEXT NOT NULL,
      error_message TEXT,
      proposal_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      complete_duration_ms REAL,
      measurement TEXT NOT NULL,
      PRIMARY KEY (user_id, generation, id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agent_turns_user_started ON agent_turns (user_id, generation, started_at DESC);
    CREATE TABLE IF NOT EXISTS tutorial_state (user_id TEXT NOT NULL, generation INTEGER NOT NULL, tutorial_id TEXT NOT NULL, step INTEGER NOT NULL, PRIMARY KEY (user_id, generation, tutorial_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS audit_records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL, body_json TEXT NOT NULL, completed_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS provider_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      actual_model TEXT,
      provider_request_id TEXT,
      generation_id TEXT,
      request_json TEXT NOT NULL,
      response_json TEXT,
      request_bytes INTEGER NOT NULL,
      response_bytes INTEGER,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      cost_usd REAL,
      outcome TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, generation, request_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS provider_attempts_user_completed ON provider_attempts (user_id, completed_at DESC, started_at DESC);
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
    seedOrders.forEach((item, position) => { order.run(userId, item.id, item.item, item.issue, item.status, item.family, position, JSON.stringify(initialStateFor(item.id))); evidence.run(userId, item.id, item.evidenceLabel, item.evidenceValue, item.occurredAt); });
  }
  const hydrate = database.prepare("UPDATE orders SET state_json = ? WHERE user_id = ? AND order_id = ? AND state_json = '{}'");
  seedOrders.forEach((item) => hydrate.run(JSON.stringify(initialStateFor(item.id)), userId, item.id));
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

type AttemptRow = {
  id: string; user_id: string; generation: number; request_id: string; turn_id: string;
  kind: ProviderAttemptRecord["kind"]; provider: string; requested_model: string;
  actual_model: string | null; provider_request_id: string | null; generation_id: string | null;
  request_json: string; response_json: string | null; request_bytes: number; response_bytes: number | null;
  started_at: string; completed_at: string | null; duration_ms: number | null;
  input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  cost_usd: number | null; outcome: ProviderAttemptRecord["outcome"];
  error_code: string | null; error_message: string | null; retry_count: number;
};

const attemptRecord = (row: AttemptRow): ProviderAttemptRecord => ({
  id: row.id,
  userId: row.user_id,
  generation: Number(row.generation),
  requestId: row.request_id,
  turnId: row.turn_id,
  kind: row.kind,
  provider: row.provider,
  requestedModel: row.requested_model,
  actualModel: row.actual_model,
  providerRequestId: row.provider_request_id,
  generationId: row.generation_id,
  request: JSON.parse(row.request_json),
  response: row.response_json === null ? null : JSON.parse(row.response_json),
  requestBytes: Number(row.request_bytes),
  responseBytes: row.response_bytes === null ? null : Number(row.response_bytes),
  startedAt: row.started_at,
  completedAt: row.completed_at,
  durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
  outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
  totalTokens: row.total_tokens === null ? null : Number(row.total_tokens),
  costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
  outcome: row.outcome,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  retryCount: Number(row.retry_count),
});

const attemptSummary = (row: Omit<AttemptRow, "request_json" | "response_json">): ProviderAttemptSummary => ({
  id: row.id,
  userId: row.user_id,
  generation: Number(row.generation),
  requestId: row.request_id,
  turnId: row.turn_id,
  kind: row.kind,
  provider: row.provider,
  requestedModel: row.requested_model,
  actualModel: row.actual_model,
  providerRequestId: row.provider_request_id,
  generationId: row.generation_id,
  requestBytes: Number(row.request_bytes),
  responseBytes: row.response_bytes === null ? null : Number(row.response_bytes),
  startedAt: row.started_at,
  completedAt: row.completed_at,
  durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
  outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
  totalTokens: row.total_tokens === null ? null : Number(row.total_tokens),
  costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
  outcome: row.outcome,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  retryCount: Number(row.retry_count),
});

type AgentTurnRow = {
  id: string; generation: number; request_id: string; connection_id: string;
  status: AgentTurnRecord["status"]; phase: string; history_json: string;
  error_message: string | null; proposal_id: string | null; started_at: string;
  finished_at: string | null; complete_duration_ms: number | null;
  measurement: AgentTurnRecord["measurement"];
};
const agentTurnRecord = (row: AgentTurnRow): AgentTurnRecord => ({
  id: row.id,
  generation: Number(row.generation),
  requestId: row.request_id,
  connectionId: row.connection_id,
  status: row.status,
  phase: row.phase,
  history: JSON.parse(row.history_json) as ReadonlyArray<ChatMessage>,
  error: row.error_message,
  proposalId: row.proposal_id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  completeDurationMs: row.complete_duration_ms === null ? null : Number(row.complete_duration_ms),
  measurement: row.measurement,
});

const maximumStoredHistoryBytes = 28 * 1024;
const maximumStoredToolResultBytes = 2 * 1024;
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const compactStoredToolResult = (message: ChatMessage): ChatMessage => {
  if (message.role !== "tool" || new TextEncoder().encode(message.content).byteLength <= maximumStoredToolResultBytes) return message;
  let outcome = "completed";
  try {
    const parsed = JSON.parse(message.content) as { ok?: unknown };
    outcome = parsed.ok === false ? "failed" : parsed.ok === true ? "completed" : "returned a result";
  } catch {
    outcome = "returned a result";
  }
  return {
    ...message,
    content: JSON.stringify({ ok: outcome === "completed", truncated: true, summary: `The tool ${outcome}; its full result exceeded the stored context limit.` }),
  };
};
const groupHistory = (history: ReadonlyArray<ChatMessage>): Array<Array<ChatMessage>> => {
  const groups: Array<Array<ChatMessage>> = [];
  for (const message of history) {
    const previous = groups.at(-1);
    if (message.role === "tool" && previous?.[0]?.role === "assistant" && previous[0].toolCalls !== undefined) previous.push(message);
    else groups.push([message]);
  }
  return groups;
};
const boundStoredHistory = (history: ReadonlyArray<ChatMessage>): ReadonlyArray<ChatMessage> => {
  const compacted = history.map(compactStoredToolResult);
  if (encodedBytes(compacted) <= maximumStoredHistoryBytes) return compacted;
  const groups = groupHistory(compacted);
  const first = groups[0]?.[0]?.role === "user" ? groups[0]! : [];
  const candidates = first.length === 0 ? groups : groups.slice(1);
  const selected: Array<Array<ChatMessage>> = [];
  const omitted: Array<Array<ChatMessage>> = [];
  const summary: ChatMessage = { role: "assistant", content: "Earlier completed tool outcomes were omitted from stored context because this turn reached its history limit." };
  let bytes = encodedBytes([...first, summary]);
  for (const group of [...candidates].reverse()) {
    const groupBytes = encodedBytes(group);
    if (bytes + groupBytes > maximumStoredHistoryBytes) omitted.unshift(group);
    else { selected.unshift(group); bytes += groupBytes; }
  }
  return omitted.length === 0 ? [...first, ...selected.flat()] : [...first, summary, ...selected.flat()];
};

const readSnapshot = (database: DatabaseSync, identity: RequestIdentity, agentMode: WorkspaceSnapshot["agentMode"], now = Date.now()): WorkspaceSnapshot => {
  const user = ensureUser(database, identity);
  const orders = database.prepare(`SELECT order_id, item, issue, status, family, version, resolved, state_json FROM orders WHERE user_id = ? AND completed = 0 ORDER BY CASE order_id WHEN 'BB-1051' THEN 0 WHEN 'BB-1063' THEN 1 WHEN 'BB-1042' THEN 2 WHEN 'BB-1088' THEN 3 ELSE 4 END, seed_position`).all(user.id) as Array<{ order_id: string; item: string; issue: string; status: OrderStatus; family: WorkspaceSnapshot["orders"][number]["family"]; version: number; resolved: number; state_json: string }>;
  const evidence = database.prepare("SELECT order_id, label, value, occurred_at FROM order_evidence WHERE user_id = ? ORDER BY order_id, occurred_at").all(user.id) as Array<{ order_id: string; label: string; value: string; occurred_at: string }>;
  const receipt = database.prepare("SELECT payload_json FROM receipts WHERE user_id = ? AND generation = ? ORDER BY committed_at DESC, rowid DESC LIMIT 1").get(user.id, user.generation) as { payload_json: string } | undefined;
  const messages = database.prepare("SELECT id, role, body, created_at FROM chat_messages WHERE user_id = ? AND generation = ? ORDER BY created_at DESC, rowid DESC LIMIT 60").all(user.id, user.generation) as Array<{ id: string; role: "user" | "assistant"; body: string; created_at: string }>;
  const messageGroups = new Map<string, Array<(typeof messages)[number]>>();
  for (const message of messages.reverse()) {
    const separator = message.id.lastIndexOf(":");
    const turnId = separator === -1 ? message.id : message.id.slice(0, separator);
    messageGroups.set(turnId, [...(messageGroups.get(turnId) ?? []), message]);
  }
  const selectedMessages: Array<(typeof messages)[number]> = [];
  let selectedMessageBytes = 0;
  for (const group of [...messageGroups.values()].reverse()) {
    const bytes = new TextEncoder().encode(JSON.stringify(group)).byteLength;
    if (selectedMessageBytes + bytes > 64 * 1024) break;
    selectedMessages.unshift(...group);
    selectedMessageBytes += bytes;
  }
  const active = database.prepare("SELECT * FROM agent_turns WHERE user_id = ? AND generation = ? AND status IN ('running', 'waiting_for_ui') ORDER BY started_at DESC LIMIT 1").get(user.id, user.generation) as AgentTurnRow | undefined;
  const pendingProposal = database.prepare("SELECT payload_json FROM proposals WHERE user_id = ? AND generation = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(user.id, user.generation) as { payload_json: string } | undefined;
  return {
    generation: user.generation,
    sequence: sequenceFor(database, user.id, user.generation),
    orders: orders.map((item) => {
      const currentState = JSON.parse(item.state_json) as OrderBusinessState;
      const facts = resolutionFacts[item.order_id];
      const material = facts === undefined ? null : materializeResolution(facts);
      const stock = material?.inventory === undefined ? null : inventoryFor(database, user.id, material.inventory.sku);
      const status = Number(item.resolved) === 0 && item.status === "ready" && facts !== undefined && resolutionBlockReason(facts, stock) !== null ? "review" : item.status;
      return { id: item.order_id, item: item.item, issue: item.issue, status, statusLabel: statusLabels[status], family: item.family, version: Number(item.version), businessValue: currentState.summary, targetId: targets.orderRow(item.order_id), evidence: evidence.filter((entry) => entry.order_id === item.order_id).map((entry) => ({ label: entry.label, value: entry.value, occurredAt: entry.occurred_at, age: ageLabel(entry.occurred_at, now) })) };
    }),
    latestReceipt: receipt === undefined ? null : (JSON.parse(receipt.payload_json) as StoredReceipt).public,
    currentProposal: pendingProposal === undefined ? null : (JSON.parse(pendingProposal.payload_json) as StoredProposal).public,
    chat: selectedMessages.map((message) => ({
      id: message.id,
      turnId: message.id.includes(":") ? message.id.slice(0, message.id.lastIndexOf(":")) : message.id,
      role: message.role,
      content: message.body,
      createdAt: message.created_at,
    })),
    activeTurn: active === undefined ? null : (() => {
      const turn = agentTurnRecord(active);
      return { id: turn.id, generation: turn.generation, status: turn.status, phase: turn.phase, error: turn.error, startedAt: turn.startedAt, finishedAt: turn.finishedAt, completeDurationMs: turn.completeDurationMs, measurement: turn.measurement };
    })(),
    agentMode,
  };
};

const expectGeneration = (actual: number, expected: number) => { if (actual !== expected) throw fail("generation_changed", "This workspace was reset. Refresh before continuing."); };
const rowFor = (database: DatabaseSync, userId: string, orderId: string) => database.prepare("SELECT order_id AS id, item, issue, status, family, version, completed, resolved, state_json FROM orders WHERE user_id = ? AND order_id = ?").get(userId, orderId) as ({ id: string; item: string; issue: string; status: OrderStatus; family: WorkspaceSnapshot["orders"][number]["family"]; version: number; completed: number; resolved: number; state_json: string } | undefined);
function inventoryFor(database: DatabaseSync, userId: string, sku: string) {
  const row = database.prepare("SELECT quantity, version FROM inventory WHERE user_id = ? AND sku = ?").get(userId, sku) as { quantity: number; version: number } | undefined;
  return row === undefined ? null : { sku, quantity: Number(row.quantity), version: Number(row.version) };
}
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
  const material = materializeResolution(facts);
  const stock = material.inventory === undefined ? null : inventoryFor(database, userId, material.inventory.sku);
  const currentState = JSON.parse(affected.state_json) as OrderBusinessState;
  const evaluation = evaluateResolution(selected, currentState, facts, Number(affected.version), stock);
  if (!evaluation.ready) return evaluation;
  return { ready: true, policy: { ...evaluation.policy, priorStatus: affected.status, priorIssue: affected.issue, priorCompleted: Number(affected.completed), priorResolved: Number(affected.resolved), priorState: JSON.parse(affected.state_json) as OrderBusinessState, nextCompleted: Number(affected.completed), nextResolved: 1 } };
};

const repositoryLayer = (filename: string, agentMode: WorkspaceSnapshot["agentMode"]) => Layer.effect(WorkspaceRepository, Effect.acquireRelease(
  Effect.sync(() => { const database = new DatabaseSync(filename); migrate(database); return database; }),
  (database) => Effect.sync(() => database.close()),
).pipe(Effect.map((database) => {
  const command = <A>(run: () => A) => Effect.try({ try: run, catch: (error) => error instanceof WorkspaceCommandError ? error : fail("command_failed", String(error)) });
  const snapshot: WorkspaceRepositoryService["snapshot"] = (identity, now) => Effect.try({ try: () => readSnapshot(database, identity, agentMode, now), catch: (error) => new WorkspaceStoreError({ message: `Could not read the workspace: ${String(error)}` }) });
  const orderIds: WorkspaceRepositoryService["orderIds"] = (identity) => snapshot(identity).pipe(Effect.map((state) => state.orders.map((order) => order.id)));
  const prepareResolution: WorkspaceRepositoryService["prepareResolution"] = (identity, generation, orderId) => command(() => transact(database, () => {
    const user = ensureUser(database, identity); expectGeneration(user.generation, generation);
    const evaluated = preparePolicy(database, user.id, orderId);
    const title = seedOrders.find((item) => item.id === orderId)?.family === "address" ? "Check address" : `Review ${orderId}`;
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
      return { receipt: (JSON.parse(keyed.payload_json) as StoredReceipt).public, snapshot: readSnapshot(database, identity, agentMode), generationChanged: false };
    }
    const priorReceipt = database.prepare("SELECT payload_json FROM receipts WHERE user_id = ? AND generation = ? AND proposal_id = ? ORDER BY committed_at LIMIT 1").get(user.id, generation, proposalId) as { payload_json: string } | undefined;
    if (proposalRow.status === "accepted") {
      if (priorReceipt === undefined) throw fail("proposal_state_invalid", "The accepted proposal has no receipt.");
      return { receipt: (JSON.parse(priorReceipt.payload_json) as StoredReceipt).public, snapshot: readSnapshot(database, identity, agentMode), generationChanged: false };
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
      database.prepare("DELETE FROM agent_turns WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM tutorial_state WHERE user_id = ?").run(user.id);
      database.prepare("DELETE FROM scenario_events WHERE user_id = ?").run(user.id);
      database.prepare("UPDATE users SET generation = ? WHERE id = ?").run(nextGeneration, user.id);
      seedUser(database, user.id);
      appendEvent(database, user.id, nextGeneration, "workspace.reset", { fromGeneration: generation });
      const publicReceipt: CommandReceipt = { id: `receipt_${randomUUID()}`, proposalId, generation: nextGeneration, kind: "reset", title: "Demo reset", changes: [], committedAt: new Date().toISOString(), undoable: false };
      const payload: StoredReceipt = { public: publicReceipt, applied: [] };
      database.prepare("INSERT INTO receipts (id, user_id, generation, proposal_id, idempotency_key, payload_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(publicReceipt.id, user.id, nextGeneration, proposalId, idempotencyKey, JSON.stringify(payload), publicReceipt.committedAt);
      database.prepare("INSERT INTO audit_records (id, user_id, generation, kind, body_json, completed_at) VALUES (?, ?, ?, 'reset', ?, ?)").run(`audit_${randomUUID()}`, user.id, nextGeneration, JSON.stringify({ fromGeneration: generation, receiptId: publicReceipt.id }), publicReceipt.committedAt);
      return { receipt: publicReceipt, snapshot: readSnapshot(database, identity, agentMode), generationChanged: true };
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
    return { receipt: publicReceipt, snapshot: readSnapshot(database, identity, agentMode), generationChanged: false };
  }));

  const advanceScenario: WorkspaceRepositoryService["advanceScenario"] = (identity, generation) => command(() => transact(database, () => {
    const user = ensureUser(database, identity); expectGeneration(user.generation, generation);
    const stock = database.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND sku = 'MUG-SAGE'").get(user.id) as { quantity: number };
    if (Number(stock.quantity) <= 0) throw fail("scenario_complete", "The stock-change scenario has no further step.");
    database.prepare("UPDATE inventory SET quantity = quantity - 1, version = version + 1 WHERE user_id = ? AND sku = 'MUG-SAGE'").run(user.id);
    appendEvent(database, user.id, generation, "scenario.stock_changed", { sku: "MUG-SAGE", quantity: Number(stock.quantity) - 1 });
    return { message: "Scenario advanced: sage mug stock changed.", snapshot: readSnapshot(database, identity, agentMode) };
  }));
  const startProviderAttempt: WorkspaceRepositoryService["startProviderAttempt"] = (input: ProviderAttemptStart) => Effect.sync(() => transact(database, () => {
    if (input.requestId.length < 1 || input.requestId.length > 128 || input.turnId.length < 1 || input.turnId.length > 128) throw new Error("Provider request and turn identifiers must be between 1 and 128 characters.");
    if (input.requestBytes < 0 || input.requestBytes > 32 * 1024) throw new Error("The provider request exceeded the audit byte limit.");
    const user = ensureUser(database, input.identity);
    expectGeneration(user.generation, input.generation);
    const id = `attempt_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    database.prepare(`INSERT INTO provider_attempts (
      id, user_id, generation, request_id, turn_id, kind, provider, requested_model,
      request_json, request_bytes, started_at, outcome, retry_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0)`).run(
      id,
      user.id,
      input.generation,
      redactProviderString(input.requestId, 128),
      redactProviderString(input.turnId, 128),
      input.kind,
      redactProviderString(input.provider, 128),
      redactProviderString(input.model, 256),
      JSON.stringify(redactProviderAudit(input.request)),
      input.requestBytes,
      startedAt,
    );
    return attemptRecord(database.prepare("SELECT * FROM provider_attempts WHERE id = ?").get(id) as AttemptRow);
  }));
  const finishProviderAttempt: WorkspaceRepositoryService["finishProviderAttempt"] = (identity: RequestIdentity, attemptId: string, finish: ProviderAttemptFinish) => Effect.sync(() => transact(database, () => {
    const owner = database.prepare("SELECT id FROM users WHERE id = ? AND identity_digest = ?").get(identity.id, identity.digest) as { id: string } | undefined;
    if (owner === undefined) throw new Error("The provider attempt owner is unavailable.");
    const row = database.prepare("SELECT * FROM provider_attempts WHERE id = ? AND user_id = ?").get(attemptId, owner.id) as AttemptRow | undefined;
    if (row === undefined) throw new Error("The provider attempt is unavailable.");
    if (row.outcome !== "running" && !(row.outcome === "interrupted" && row.error_code === "server_restart")) return attemptRecord(row);
    const completedAt = new Date().toISOString();
    const durationMs = finish.durationMs === null || !Number.isFinite(finish.durationMs)
      ? null
      : Math.max(0, Math.round(finish.durationMs));
    const responseJson = finish.response === null ? null : JSON.stringify(redactProviderAudit(finish.response));
    if (responseJson !== null && new TextEncoder().encode(responseJson).byteLength > 256 * 1024) throw new Error("The provider response exceeded the audit byte limit.");
    database.prepare(`UPDATE provider_attempts SET
      provider = COALESCE(?, provider), actual_model = ?, provider_request_id = ?, generation_id = ?,
      response_json = ?, response_bytes = ?, completed_at = ?, duration_ms = ?,
      input_tokens = ?, output_tokens = ?, total_tokens = ?, cost_usd = ?, outcome = ?,
      error_code = ?, error_message = ?, retry_count = ?
      WHERE id = ? AND user_id = ? AND (outcome = 'running' OR (outcome = 'interrupted' AND error_code = 'server_restart'))`).run(
      finish.provider === null ? null : redactProviderString(finish.provider, 128),
      finish.actualModel === null ? null : redactProviderString(finish.actualModel, 256),
      finish.providerRequestId === null ? null : redactProviderString(finish.providerRequestId, 256),
      finish.generationId === null ? null : redactProviderString(finish.generationId, 256),
      responseJson,
      finish.responseBytes,
      completedAt,
      durationMs,
      finish.inputTokens,
      finish.outputTokens,
      finish.totalTokens,
      finish.costUsd,
      finish.outcome,
      finish.errorCode === null ? null : redactProviderString(finish.errorCode, 128),
      finish.errorMessage === null ? null : redactProviderString(finish.errorMessage, 512),
      finish.retryCount,
      attemptId,
      owner.id,
    );
    const completed = database.prepare("SELECT * FROM provider_attempts WHERE id = ? AND user_id = ?").get(attemptId, owner.id) as AttemptRow;
    const summary = attemptRecord(completed);
    database.prepare("INSERT INTO audit_records (id, user_id, generation, kind, body_json, completed_at) VALUES (?, ?, ?, 'provider', ?, ?)").run(
      `audit_${randomUUID()}`,
      owner.id,
      row.generation,
      JSON.stringify({
        attemptId: summary.id,
        requestId: summary.requestId,
        turnId: summary.turnId,
        kind: summary.kind,
        provider: summary.provider,
        requestedModel: summary.requestedModel,
        actualModel: summary.actualModel,
        outcome: summary.outcome,
        durationMs: summary.durationMs,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        costUsd: summary.costUsd,
      }),
      completedAt,
    );
    return summary;
  }));
  const providerAttempts: WorkspaceRepositoryService["providerAttempts"] = (identity, requestedLimit = 50) => Effect.sync(() => {
    const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));
    const owner = database.prepare("SELECT id FROM users WHERE id = ? AND identity_digest = ?").get(identity.id, identity.digest) as { id: string } | undefined;
    if (owner === undefined) return [];
    return (database.prepare(`SELECT
      id, user_id, generation, request_id, turn_id, kind, provider, requested_model,
      actual_model, provider_request_id, generation_id, request_bytes, response_bytes,
      started_at, completed_at, duration_ms, input_tokens, output_tokens, total_tokens,
      cost_usd, outcome, error_code, error_message, retry_count
      FROM provider_attempts WHERE user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(owner.id, limit) as Array<Omit<AttemptRow, "request_json" | "response_json">>).map(attemptSummary);
  });
  const providerAttempt: WorkspaceRepositoryService["providerAttempt"] = (identity, attemptId) => Effect.sync(() => {
    const row = database.prepare("SELECT pa.* FROM provider_attempts pa JOIN users u ON u.id = pa.user_id WHERE pa.id = ? AND u.id = ? AND u.identity_digest = ?").get(attemptId, identity.id, identity.digest) as AttemptRow | undefined;
    return row === undefined ? null : attemptRecord(row);
  });
  const recoverProviderAttempts: WorkspaceRepositoryService["recoverProviderAttempts"] = () => Effect.sync(() => {
    const recoveredAt = new Date().toISOString();
    const result = database.prepare("UPDATE provider_attempts SET outcome = 'interrupted', completed_at = ?, duration_ms = NULL, error_code = 'server_restart', error_message = 'The server restarted before this provider attempt completed.' WHERE outcome = 'running'").run(recoveredAt);
    return Number(result.changes);
  });
  const turnRow = (userId: string, generation: number, turnId: string) =>
    database.prepare("SELECT * FROM agent_turns WHERE user_id = ? AND generation = ? AND id = ?").get(userId, generation, turnId) as AgentTurnRow | undefined;
  const createAgentTurn: WorkspaceRepositoryService["createAgentTurn"] = (identity, generation, turnId, requestId, connectionId, message) => command(() => transact(database, () => {
    if (!/^turn_[A-Za-z0-9-]{8,100}$/.test(turnId)) throw fail("invalid_turn_id", "The turn ID is invalid.");
    if (message.trim().length < 1 || message.length > 2_000) throw fail("invalid_message", "Messages must contain between 1 and 2,000 characters.");
    const user = ensureUser(database, identity);
    expectGeneration(user.generation, generation);
    const existing = turnRow(user.id, generation, turnId);
    if (existing !== undefined) return { created: false, turn: agentTurnRecord(existing) };
    const startedAt = new Date().toISOString();
    const history: ReadonlyArray<ChatMessage> = [{ role: "user", content: message.trim() }];
    database.prepare(`INSERT INTO agent_turns (
      id, user_id, generation, request_id, connection_id, status, phase,
      history_json, started_at, measurement
    ) VALUES (?, ?, ?, ?, ?, 'running', 'Thinking', ?, ?, 'pending')`).run(
      turnId, user.id, generation, requestId, connectionId, JSON.stringify(history), startedAt,
    );
    database.prepare("INSERT INTO chat_messages (id, user_id, generation, role, body, created_at) VALUES (?, ?, ?, 'user', ?, ?)").run(
      `${turnId}:user`, user.id, generation, message.trim(), startedAt,
    );
    return { created: true, turn: agentTurnRecord(turnRow(user.id, generation, turnId)!) };
  }));
  const updateAgentTurn: WorkspaceRepositoryService["updateAgentTurn"] = (identity, generation, turnId, update) => command(() => transact(database, () => {
    const user = ensureUser(database, identity);
    expectGeneration(user.generation, generation);
    const current = turnRow(user.id, generation, turnId);
    if (current === undefined) throw fail("turn_not_found", "That agent turn is unavailable.");
    const boundedHistory = boundStoredHistory(update.history);
    const historyJson = JSON.stringify(boundedHistory);
    if (new TextEncoder().encode(historyJson).byteLength > 32 * 1024) throw fail("history_too_large", "The conversation history exceeded its limit.");
    const measurement = current.measurement === "incomplete" ? "incomplete" : (update.measurement ?? current.measurement);
    database.prepare(`UPDATE agent_turns SET status = ?, phase = ?, history_json = ?,
      error_message = ?, proposal_id = COALESCE(?, proposal_id), finished_at = ?, measurement = ?
      WHERE user_id = ? AND generation = ? AND id = ?`).run(
      update.status,
      update.phase.slice(0, 128),
      historyJson,
      update.error === undefined ? current.error_message : update.error,
      update.proposalId ?? null,
      update.finishedAt === undefined ? current.finished_at : update.finishedAt,
      measurement,
      user.id,
      generation,
      turnId,
    );
    const terminalVisible = update.status === "complete" || update.status === "cancelled" || update.status === "failed" || update.status === "interrupted" || (update.status === "waiting_for_ui" && update.phase === "Rendering answer");
    if (terminalVisible) {
      const assistant = [...boundedHistory].reverse().find((entry) => entry.role === "assistant" && entry.content !== null && entry.content.trim().length > 0);
      if (assistant?.role === "assistant" && assistant.content !== null) {
        database.prepare(`INSERT INTO chat_messages (id, user_id, generation, role, body, created_at)
          VALUES (?, ?, ?, 'assistant', ?, ?)
          ON CONFLICT(id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`).run(
          `${turnId}:assistant`, user.id, generation, assistant.content.slice(0, 8_000), new Date().toISOString(),
        );
      }
    }
    return agentTurnRecord(turnRow(user.id, generation, turnId)!);
  }));
  const agentTurn: WorkspaceRepositoryService["agentTurn"] = (identity, generation, turnId) => command(() => {
    const user = ensureUser(database, identity);
    expectGeneration(user.generation, generation);
    const row = turnRow(user.id, generation, turnId);
    return row === undefined ? null : agentTurnRecord(row);
  });
  const agentHistories: WorkspaceRepositoryService["agentHistories"] = (identity, generation, excludeTurnId, requestedLimit = 6) => command(() => {
    const user = ensureUser(database, identity);
    expectGeneration(user.generation, generation);
    const limit = Math.max(1, Math.min(8, Math.floor(requestedLimit)));
    const rows = database.prepare("SELECT history_json FROM agent_turns WHERE user_id = ? AND generation = ? AND id <> ? AND status = 'complete' ORDER BY started_at DESC LIMIT ?").all(user.id, generation, excludeTurnId, limit) as Array<{ history_json: string }>;
    return rows.reverse().map((row) => JSON.parse(row.history_json) as ReadonlyArray<ChatMessage>);
  });
  const resolveAgentViewContext: WorkspaceRepositoryService["resolveAgentViewContext"] = (identity, generation, context) => command(() => {
    const user = ensureUser(database, identity);
    expectGeneration(user.generation, generation);
    if (context.view !== "work" && context.focus !== null) throw fail("invalid_view_context", "Only the Work view can identify selected work.");
    if (context.focus === null) return { view: context.view, focus: null };
    if (context.focus.kind === "order") {
      const orderId = context.focus.orderId;
      const order = readSnapshot(database, identity, agentMode).orders.find((candidate) => candidate.id === orderId);
      if (order === undefined) throw fail("invalid_view_context", "The selected order is not available in this workspace.");
      return { view: "work", focus: { kind: "order", order: { id: order.id, item: order.item, issue: order.issue, status: order.status, businessValue: order.businessValue, evidence: order.evidence.map(({ label, value }) => ({ label, value })) } } };
    }
    if (context.focus.kind === "proposal") {
      const row = database.prepare("SELECT payload_json FROM proposals WHERE id = ? AND user_id = ? AND generation = ? AND status = 'pending'").get(context.focus.proposalId, user.id, generation) as { payload_json: string } | undefined;
      if (row === undefined) throw fail("invalid_view_context", "The selected proposal is not available in this workspace.");
      const proposal = (JSON.parse(row.payload_json) as StoredProposal).public;
      return { view: "work", focus: { kind: "proposal", proposal: { id: proposal.id, kind: proposal.kind, title: proposal.title, ready: proposal.ready, changes: proposal.changes, omissions: proposal.omissions, effects: proposal.effects } } };
    }
    const row = database.prepare("SELECT payload_json FROM receipts WHERE id = ? AND user_id = ? AND generation = ?").get(context.focus.receiptId, user.id, generation) as { payload_json: string } | undefined;
    if (row === undefined) throw fail("invalid_view_context", "The selected receipt is not available in this workspace.");
    const receipt = (JSON.parse(row.payload_json) as StoredReceipt).public;
    return { view: "work", focus: { kind: "receipt", receipt: { id: receipt.id, kind: receipt.kind, title: receipt.title, changes: receipt.changes, undoable: receipt.undoable } } };
  });
  const completeAgentMeasurement: WorkspaceRepositoryService["completeAgentMeasurement"] = (identity, generation, turnId, durationMs) => command(() => transact(database, () => {
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10 * 60_000) throw fail("invalid_duration", "The completed-turn duration is invalid.");
    const user = ensureUser(database, identity);
    expectGeneration(user.generation, generation);
    const current = turnRow(user.id, generation, turnId);
    if (current === undefined) throw fail("turn_not_found", "That agent turn is unavailable.");
    if (current.status !== "waiting_for_ui" && current.status !== "complete") throw fail("turn_not_ready", "That turn has not delivered its final response.");
    if (current.measurement === "incomplete") return;
    database.prepare("UPDATE agent_turns SET status = 'complete', phase = 'Complete', complete_duration_ms = ?, measurement = 'complete', finished_at = COALESCE(finished_at, ?) WHERE user_id = ? AND generation = ? AND id = ?").run(
      durationMs, new Date().toISOString(), user.id, generation, turnId,
    );
  }));
  const recordCommandMeasurement: WorkspaceRepositoryService["recordCommandMeasurement"] = (identity, generation, receiptId, durationMs) => command(() => transact(database, () => {
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10 * 60_000) throw fail("invalid_duration", "The committed-command duration is invalid.");
    const user = ensureUser(database, identity);
    expectGeneration(user.generation, generation);
    const receipt = database.prepare("SELECT id FROM receipts WHERE id = ? AND user_id = ? AND generation = ?").get(receiptId, user.id, generation) as { id: string } | undefined;
    if (receipt === undefined) throw fail("receipt_not_found", "That receipt is not available in this workspace.");
    database.prepare("INSERT INTO audit_records (id, user_id, generation, kind, body_json, completed_at) VALUES (?, ?, ?, 'command_visible', ?, ?)").run(
      `audit_${randomUUID()}`, user.id, generation, JSON.stringify({ receiptId, durationMs, clock: "browser_monotonic" }), new Date().toISOString(),
    );
  }));
  const markAgentConnectionIncomplete: WorkspaceRepositoryService["markAgentConnectionIncomplete"] = (identity, connectionId) => Effect.sync(() => {
    database.prepare("UPDATE agent_turns SET measurement = 'incomplete', status = CASE WHEN phase = 'Rendering answer' THEN 'complete' ELSE status END WHERE user_id = ? AND connection_id = ? AND status IN ('running', 'waiting_for_ui')").run(identity.id, connectionId);
  });
  const recoverAgentTurns: WorkspaceRepositoryService["recoverAgentTurns"] = () => Effect.sync(() => {
    const finishedAt = new Date().toISOString();
    const rows = database.prepare("SELECT user_id, generation, id, history_json FROM agent_turns WHERE status IN ('running', 'waiting_for_ui')").all() as Array<{ user_id: string; generation: number; id: string; history_json: string }>;
    for (const row of rows) {
      const terminal = "The server restarted before this turn completed. You can send the request again.";
      const history = boundStoredHistory([...(JSON.parse(row.history_json) as Array<ChatMessage>), { role: "assistant", content: terminal }]);
      database.prepare("UPDATE agent_turns SET status = 'interrupted', phase = 'Interrupted', history_json = ?, error_message = 'The server restarted before this turn completed.', finished_at = ?, measurement = 'incomplete' WHERE user_id = ? AND generation = ? AND id = ?").run(
        JSON.stringify(history), finishedAt, row.user_id, row.generation, row.id,
      );
      database.prepare(`INSERT INTO chat_messages (id, user_id, generation, role, body, created_at)
        VALUES (?, ?, ?, 'assistant', ?, ?)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`).run(
        `${row.id}:assistant`, row.user_id, row.generation, terminal, finishedAt,
      );
    }
    return rows.length;
  });
  return WorkspaceRepository.of({ snapshot, orderIds, prepareResolution, prepareBatch, prepareUndo, prepareReset, accept, advanceScenario, createAgentTurn, updateAgentTurn, agentTurn, agentHistories, resolveAgentViewContext, completeAgentMeasurement, recordCommandMeasurement, markAgentConnectionIncomplete, recoverAgentTurns, startProviderAttempt, finishProviderAttempt, providerAttempts, providerAttempt, recoverProviderAttempts });
})));

export const workspacePersistenceLayer = (filename: string, agentMode: WorkspaceSnapshot["agentMode"] = "unavailable") => repositoryLayer(filename, agentMode);
export const runWithWorkspaceRepository = <A, E>(filename: string, effect: Effect.Effect<A, E, WorkspaceRepository>): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(workspacePersistenceLayer(filename)), Effect.scoped));
