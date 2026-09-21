import { Schema } from "effect";

export const OrderStatus = Schema.Literals(["ready", "review", "waiting"]);
export type OrderStatus = typeof OrderStatus.Type;

export const Evidence = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  occurredAt: Schema.String,
  age: Schema.String,
});
export type Evidence = typeof Evidence.Type;

export const OrderSummary = Schema.Struct({
  id: Schema.String,
  item: Schema.String,
  issue: Schema.String,
  status: OrderStatus,
  statusLabel: Schema.String,
  family: Schema.String,
  targetId: Schema.String,
  evidence: Schema.Array(Evidence),
});
export type OrderSummary = typeof OrderSummary.Type;

export const WorkspaceSnapshot = Schema.Struct({
  generation: Schema.Int,
  sequence: Schema.Int,
  orders: Schema.Array(OrderSummary),
});
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type;

export const HelloMessage = Schema.Struct({
  type: Schema.Literal("hello"),
  requestId: Schema.String,
  clientId: Schema.String,
  knownGeneration: Schema.Int,
  knownSequence: Schema.Int,
});

export const SnapshotRequest = Schema.Struct({
  type: Schema.Literal("request_snapshot"),
  requestId: Schema.String,
});

export const PingRequest = Schema.Struct({
  type: Schema.Literal("ping"),
  requestId: Schema.String,
});

export const ClientMessage = Schema.Union([
  HelloMessage,
  SnapshotRequest,
  PingRequest,
]);
export type ClientMessage = typeof ClientMessage.Type;

export type ServerMessage =
  | {
      readonly type: "snapshot";
      readonly requestId: string | null;
      readonly generation: number;
      readonly sequence: number;
      readonly state: WorkspaceSnapshot;
    }
  | {
      readonly type: "event";
      readonly generation: number;
      readonly sequence: number;
      readonly event: string;
      readonly payload: unknown;
    }
  | { readonly type: "pong"; readonly requestId: string }
  | {
      readonly type: "error";
      readonly requestId: string | null;
      readonly code: string;
      readonly message: string;
    };
