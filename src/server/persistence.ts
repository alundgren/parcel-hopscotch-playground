import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { WorkspaceSnapshot } from "../shared/contracts.js";
import { targets } from "../shared/targets.js";
import type { RequestIdentity } from "./identity.js";
import { seedOrders } from "./seeds.js";

export class WorkspaceStoreError extends Schema.TaggedError<WorkspaceStoreError>()(
  "WorkspaceStoreError",
  { message: Schema.String },
) {}

export interface WorkspaceRepositoryService {
  readonly snapshot: (
    identity: RequestIdentity,
    now?: number,
  ) => Effect.Effect<WorkspaceSnapshot, WorkspaceStoreError>;
  readonly orderIds: (
    identity: RequestIdentity,
  ) => Effect.Effect<ReadonlyArray<string>, WorkspaceStoreError>;
}

export class WorkspaceRepository extends Context.Service<
  WorkspaceRepository,
  WorkspaceRepositoryService
>()("parcel-hopscotch/WorkspaceRepository") {}

interface UserRow {
  readonly id: string;
  readonly generation: number;
}

interface OrderRow {
  readonly order_id: string;
  readonly item: string;
  readonly issue: string;
  readonly status: "ready" | "review" | "waiting";
  readonly family: string;
}

interface EvidenceRow {
  readonly order_id: string;
  readonly label: string;
  readonly value: string;
  readonly occurred_at: string;
}

interface SequenceRow {
  readonly sequence: number;
}

const migrations = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_workspace": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          identity_digest TEXT NOT NULL UNIQUE,
          generation INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS orders (
          user_id TEXT NOT NULL,
          order_id TEXT NOT NULL,
          item TEXT NOT NULL,
          issue TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('ready', 'review', 'waiting')),
          family TEXT NOT NULL,
          seed_position INTEGER NOT NULL,
          PRIMARY KEY (user_id, order_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS order_evidence (
          user_id TEXT NOT NULL,
          order_id TEXT NOT NULL,
          label TEXT NOT NULL,
          value TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          PRIMARY KEY (user_id, order_id, label),
          FOREIGN KEY (user_id, order_id) REFERENCES orders(user_id, order_id) ON DELETE CASCADE
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS scenario_events (
          user_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          PRIMARY KEY (user_id, generation, sequence),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS proposals (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          role TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS audit_records (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          kind TEXT NOT NULL,
          body_json TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `;
    }),
  }),
});

const ageLabel = (occurredAt: string, now: number): string => {
  const elapsedMinutes = Math.max(
    0,
    Math.floor((now - Date.parse(occurredAt)) / 60_000),
  );
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
};

const statusLabels = {
  ready: "Ready",
  review: "Review",
  waiting: "Waiting",
} as const;

const ensureUser = (
  sql: SqlClient.SqlClient,
  identity: RequestIdentity,
): Effect.Effect<UserRow, unknown> =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO users (id, identity_digest, generation, created_at)
        VALUES (${identity.id}, ${identity.digest}, 1, ${new Date().toISOString()})
        ON CONFLICT(identity_digest) DO NOTHING
      `;
      const users = yield* sql<UserRow>`
        SELECT id, generation
        FROM users
        WHERE identity_digest = ${identity.digest}
      `;
      const user = users[0];
      if (user === undefined) {
        return yield* Effect.fail(new Error("Identity row was not created."));
      }

      const counts = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orders WHERE user_id = ${user.id}
      `;
      if (Number(counts[0]?.count ?? 0) === 0) {
        for (const [position, order] of seedOrders.entries()) {
          yield* sql`
            INSERT INTO orders (
              user_id, order_id, item, issue, status, family, seed_position
            ) VALUES (
              ${user.id}, ${order.id}, ${order.item}, ${order.issue},
              ${order.status}, ${order.family}, ${position}
            )
          `;
          yield* sql`
            INSERT INTO order_evidence (
              user_id, order_id, label, value, occurred_at
            ) VALUES (
              ${user.id}, ${order.id}, ${order.evidenceLabel},
              ${order.evidenceValue}, ${order.occurredAt}
            )
          `;
        }
      }
      return user;
    }),
  );

const repositoryLayer = Layer.effect(
  WorkspaceRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const snapshot: WorkspaceRepositoryService["snapshot"] = (identity, now = Date.now()) =>
      Effect.gen(function* () {
        const user = yield* ensureUser(sql, identity);
        const orders = yield* sql<OrderRow>`
          SELECT order_id, item, issue, status, family
          FROM orders
          WHERE user_id = ${user.id}
          ORDER BY
            CASE order_id
              WHEN 'BB-1051' THEN 0
              WHEN 'BB-1063' THEN 1
              WHEN 'BB-1042' THEN 2
              WHEN 'BB-1088' THEN 3
              ELSE 4
            END,
            seed_position ASC
        `;
        const evidence = yield* sql<EvidenceRow>`
          SELECT order_id, label, value, occurred_at
          FROM order_evidence
          WHERE user_id = ${user.id}
          ORDER BY order_id, occurred_at ASC
        `;
        const sequenceRows = yield* sql<SequenceRow>`
          SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM scenario_events
          WHERE user_id = ${user.id} AND generation = ${user.generation}
        `;
        return {
          generation: Number(user.generation),
          sequence: Number(sequenceRows[0]?.sequence ?? 0),
          orders: orders.map((order) => ({
            id: order.order_id,
            item: order.item,
            issue: order.issue,
            status: order.status,
            statusLabel: statusLabels[order.status],
            family: order.family,
            targetId: targets.orderRow(order.order_id),
            evidence: evidence
              .filter((item) => item.order_id === order.order_id)
              .map((item) => ({
                label: item.label,
                value: item.value,
                occurredAt: item.occurred_at,
                age: ageLabel(item.occurred_at, now),
              })),
          })),
        } satisfies WorkspaceSnapshot;
      }).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceStoreError({
              message: `Could not read the workspace: ${String(error)}`,
            }),
        ),
      );

    const orderIds: WorkspaceRepositoryService["orderIds"] = (identity) =>
      Effect.gen(function* () {
        const user = yield* ensureUser(sql, identity);
        const rows = yield* sql<{ order_id: string }>`
          SELECT order_id FROM orders WHERE user_id = ${user.id} ORDER BY seed_position
        `;
        return rows.map((row) => row.order_id);
      }).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceStoreError({
              message: `Could not read order IDs: ${String(error)}`,
            }),
        ),
      );

    return WorkspaceRepository.of({ snapshot, orderIds });
  }),
);

export const workspacePersistenceLayer = (filename: string) => {
  const sqlLayer = SqliteClient.layer({ filename, busyTimeout: "5 seconds" });
  const migratedSql = migrations.pipe(Layer.provideMerge(sqlLayer));
  return repositoryLayer.pipe(Layer.provideMerge(migratedSql));
};

export const runWithWorkspaceRepository = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, WorkspaceRepository>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(workspacePersistenceLayer(filename)),
      Effect.scoped,
    ),
  );
