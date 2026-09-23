import { Schema } from "effect";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const GuidanceProblem = Schema.Struct({
  kind: Schema.Literal("stale_review"),
  proposalId: Id,
  orderId: Id,
  reason: Schema.Literals(["order_changed", "stock_changed"]),
  resolved: Schema.Boolean,
  expectedVersion: Schema.optionalKey(Schema.Int),
  currentVersion: Schema.optionalKey(Schema.Int),
});
export type GuidanceProblem = typeof GuidanceProblem.Type;

export interface GuidanceOrder {
  readonly id: string;
  readonly status: "ready" | "review" | "waiting";
  readonly version: number;
  readonly resolved?: boolean;
}

export interface GuidanceLocation {
  readonly view: "work" | "explore" | "audit";
  readonly focus: { readonly kind: "order" | "proposal" | "receipt" | "audit_request"; readonly id: string } | null;
}

export interface GuidanceInput {
  readonly generation: number;
  readonly sequence: number;
  readonly orders: ReadonlyArray<GuidanceOrder>;
  readonly location: GuidanceLocation;
  readonly problem: GuidanceProblem | null;
  readonly connected: boolean;
}
