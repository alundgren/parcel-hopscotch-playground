import { Schema } from "effect";

export const OrderStatus = Schema.Literals(["ready", "review", "waiting"]);
export type OrderStatus = typeof OrderStatus.Type;
export const ResolutionFamily = Schema.Literals(["address", "substitution", "bundle", "weight", "carrier", "duplicate"]);
export type ResolutionFamily = typeof ResolutionFamily.Type;

export const Evidence = Schema.Struct({ label: Schema.String, value: Schema.String, occurredAt: Schema.String, age: Schema.String });
export type Evidence = typeof Evidence.Type;
export const OrderSummary = Schema.Struct({
  id: Schema.String, item: Schema.String, issue: Schema.String, status: OrderStatus,
  statusLabel: Schema.String, family: ResolutionFamily, version: Schema.Int,
  businessValue: Schema.String,
  targetId: Schema.String, evidence: Schema.Array(Evidence),
});
export type OrderSummary = typeof OrderSummary.Type;

export const ProposalChange = Schema.Struct({
  orderId: Schema.String, family: ResolutionFamily, before: Schema.String,
  after: Schema.String, effect: Schema.String, expectedVersion: Schema.Int,
});
export type ProposalChange = typeof ProposalChange.Type;
export const ProposalOmission = Schema.Struct({ orderId: Schema.String, reason: Schema.String });
export type ProposalOmission = typeof ProposalOmission.Type;
export const ReviewedProposal = Schema.Struct({
  id: Schema.String, generation: Schema.Int,
  kind: Schema.Literals(["resolution", "batch", "undo", "reset"]),
  title: Schema.String, ready: Schema.Boolean, changes: Schema.Array(ProposalChange),
  omissions: Schema.Array(ProposalOmission), effects: Schema.Array(Schema.String),
  createdAt: Schema.String,
});
export type ReviewedProposal = typeof ReviewedProposal.Type;
export const CommandReceipt = Schema.Struct({
  id: Schema.String, proposalId: Schema.String, generation: Schema.Int,
  kind: Schema.Literals(["accept", "undo", "reset"]), title: Schema.String,
  changes: Schema.Array(ProposalChange), committedAt: Schema.String, undoable: Schema.Boolean,
});
export type CommandReceipt = typeof CommandReceipt.Type;

export const WorkspaceSnapshot = Schema.Struct({
  generation: Schema.Int, sequence: Schema.Int, orders: Schema.Array(OrderSummary),
  latestReceipt: Schema.NullOr(CommandReceipt),
});
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type;

export const PrepareResolutionMessage = Schema.Struct({ type: Schema.Literal("prepare_resolution"), requestId: Schema.String, generation: Schema.Int, orderId: Schema.String });
export const PrepareBatchMessage = Schema.Struct({ type: Schema.Literal("prepare_batch"), requestId: Schema.String, generation: Schema.Int });
export const PrepareUndoMessage = Schema.Struct({ type: Schema.Literal("prepare_undo"), requestId: Schema.String, generation: Schema.Int, receiptId: Schema.String });
export const PrepareResetMessage = Schema.Struct({ type: Schema.Literal("prepare_reset"), requestId: Schema.String, generation: Schema.Int });
export const AcceptProposalMessage = Schema.Struct({ type: Schema.Literal("accept_proposal"), requestId: Schema.String, generation: Schema.Int, proposalId: Schema.String, idempotencyKey: Schema.String });
export const AdvanceScenarioMessage = Schema.Struct({ type: Schema.Literal("advance_scenario"), requestId: Schema.String, generation: Schema.Int, scenario: Schema.Literal("stock_change") });
export type WorkspaceCommand = typeof PrepareResolutionMessage.Type | typeof PrepareBatchMessage.Type | typeof PrepareUndoMessage.Type | typeof PrepareResetMessage.Type | typeof AcceptProposalMessage.Type | typeof AdvanceScenarioMessage.Type;

export const HelloMessage = Schema.Struct({ type: Schema.Literal("hello"), requestId: Schema.String, clientId: Schema.String, knownGeneration: Schema.Int, knownSequence: Schema.Int });
export const SnapshotRequest = Schema.Struct({ type: Schema.Literal("request_snapshot"), requestId: Schema.String });
export const PingRequest = Schema.Struct({ type: Schema.Literal("ping"), requestId: Schema.String });
export const ClientMessage = Schema.Union([HelloMessage, SnapshotRequest, PingRequest, PrepareResolutionMessage, PrepareBatchMessage, PrepareUndoMessage, PrepareResetMessage, AcceptProposalMessage, AdvanceScenarioMessage]);
export type ClientMessage = typeof ClientMessage.Type;

export type CommandResult =
  | { readonly kind: "proposal"; readonly proposal: ReviewedProposal }
  | { readonly kind: "receipt"; readonly receipt: CommandReceipt }
  | { readonly kind: "scenario"; readonly message: string };
export type ServerMessage =
  | { readonly type: "snapshot"; readonly requestId: string | null; readonly generation: number; readonly sequence: number; readonly state: WorkspaceSnapshot }
  | { readonly type: "command_result"; readonly requestId: string; readonly result: CommandResult; readonly state: WorkspaceSnapshot }
  | { readonly type: "event"; readonly generation: number; readonly sequence: number; readonly event: string; readonly payload: unknown }
  | { readonly type: "pong"; readonly requestId: string }
  | { readonly type: "error"; readonly requestId: string | null; readonly code: string; readonly message: string };
