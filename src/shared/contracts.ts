import { Schema } from "effect";
import { tutorialIds } from "./tutorials.js";

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

export const TutorialId = Schema.Literals(tutorialIds);
export type TutorialId = typeof TutorialId.Type;
export const TutorialState = Schema.Struct({
  id: TutorialId,
  instanceId: Schema.String,
  title: Schema.String,
  step: Schema.Int,
  totalSteps: Schema.Int,
  phase: Schema.Literals(["teaching", "practice", "complete"]),
  instruction: Schema.String,
  targetId: Schema.String,
});
export type TutorialState = typeof TutorialState.Type;

export const WorkspaceSnapshot = Schema.Struct({
  generation: Schema.Int, sequence: Schema.Int, orders: Schema.Array(OrderSummary),
  latestReceipt: Schema.NullOr(CommandReceipt),
  tutorialReceipt: Schema.NullOr(CommandReceipt),
  currentProposal: Schema.NullOr(ReviewedProposal),
  tutorialProposal: Schema.NullOr(ReviewedProposal),
  chat: Schema.Array(Schema.Struct({
    id: Schema.String,
    turnId: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
    content: Schema.String,
    createdAt: Schema.String,
  })),
  activeTurn: Schema.NullOr(Schema.Struct({
    id: Schema.String,
    generation: Schema.Int,
    status: Schema.Literals(["running", "waiting_for_ui", "complete", "cancelled", "failed", "interrupted"]),
    phase: Schema.String,
    error: Schema.NullOr(Schema.String),
    startedAt: Schema.String,
    finishedAt: Schema.NullOr(Schema.String),
    completeDurationMs: Schema.NullOr(Schema.Number),
    measurement: Schema.Literals(["pending", "complete", "incomplete"]),
  })),
  agentMode: Schema.Literals(["live", "scripted", "unavailable"]),
  tutorial: Schema.NullOr(TutorialState),
});
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type;

export const PrepareResolutionMessage = Schema.Struct({ type: Schema.Literal("prepare_resolution"), requestId: Schema.String, generation: Schema.Int, orderId: Schema.String });
export const PrepareBatchMessage = Schema.Struct({ type: Schema.Literal("prepare_batch"), requestId: Schema.String, generation: Schema.Int });
export const PrepareUndoMessage = Schema.Struct({ type: Schema.Literal("prepare_undo"), requestId: Schema.String, generation: Schema.Int, receiptId: Schema.String });
export const PrepareResetMessage = Schema.Struct({ type: Schema.Literal("prepare_reset"), requestId: Schema.String, generation: Schema.Int });
export const AcceptProposalMessage = Schema.Struct({ type: Schema.Literal("accept_proposal"), requestId: Schema.String, generation: Schema.Int, proposalId: Schema.String, idempotencyKey: Schema.String });
export const AdvanceScenarioMessage = Schema.Struct({ type: Schema.Literal("advance_scenario"), requestId: Schema.String, generation: Schema.Int, scenario: Schema.Literal("stock_change") });
export const StopTutorialMessage = Schema.Struct({ type: Schema.Literal("stop_tutorial"), requestId: Schema.String, generation: Schema.Int });
const TutorialActionRevision = { tutorialId: TutorialId, tutorialInstanceId: Schema.String, expectedStep: Schema.Int };
export const TutorialActionMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("tutorial_action"), requestId: Schema.String, generation: Schema.Int, ...TutorialActionRevision, action: Schema.Literal("order_selected"), orderId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tutorial_action"), requestId: Schema.String, generation: Schema.Int, ...TutorialActionRevision, action: Schema.Literal("ready_filter_selected") }),
  Schema.Struct({ type: Schema.Literal("tutorial_action"), requestId: Schema.String, generation: Schema.Int, ...TutorialActionRevision, action: Schema.Literal("receipt_confirmed"), receiptId: Schema.String }),
]);
export type WorkspaceCommand = typeof PrepareResolutionMessage.Type | typeof PrepareBatchMessage.Type | typeof PrepareUndoMessage.Type | typeof PrepareResetMessage.Type | typeof AcceptProposalMessage.Type | typeof AdvanceScenarioMessage.Type | typeof StopTutorialMessage.Type | typeof TutorialActionMessage.Type;

export const HelloMessage = Schema.Struct({ type: Schema.Literal("hello"), requestId: Schema.String, clientId: Schema.String, knownGeneration: Schema.Int, knownSequence: Schema.Int });
export const SnapshotRequest = Schema.Struct({ type: Schema.Literal("request_snapshot"), requestId: Schema.String });
export const PingRequest = Schema.Struct({ type: Schema.Literal("ping"), requestId: Schema.String });
const AgentContextId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const AgentViewFocus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("order"), orderId: AgentContextId }),
  Schema.Struct({ kind: Schema.Literal("proposal"), proposalId: AgentContextId }),
  Schema.Struct({ kind: Schema.Literal("receipt"), receiptId: AgentContextId }),
]);
export type AgentViewFocus = typeof AgentViewFocus.Type;
export const AgentViewContext = Schema.Struct({
  view: Schema.Literals(["work", "explore", "audit"]),
  focus: Schema.NullOr(AgentViewFocus),
});
export type AgentViewContext = typeof AgentViewContext.Type;
export const SendAgentTurnMessage = Schema.Struct({
  type: Schema.Literal("send_agent_turn"), requestId: Schema.String,
  generation: Schema.Int, turnId: Schema.String, message: Schema.String,
  context: AgentViewContext,
});
export const CancelAgentTurnMessage = Schema.Struct({
  type: Schema.Literal("cancel_agent_turn"), requestId: Schema.String,
  generation: Schema.Int, turnId: Schema.String,
});
export const AgentUiAcknowledgementMessage = Schema.Struct({
  type: Schema.Literal("agent_ui_ack"), requestId: Schema.String,
  generation: Schema.Int, turnId: Schema.String, operationId: Schema.String,
  outcome: Schema.Literals(["applied", "missing"]),
});
export const AgentCompleteAcknowledgementMessage = Schema.Struct({
  type: Schema.Literal("agent_complete_ack"), requestId: Schema.String,
  generation: Schema.Int, turnId: Schema.String, durationMs: Schema.Number,
});
export const CommandVisibleAcknowledgementMessage = Schema.Struct({
  type: Schema.Literal("command_visible_ack"), requestId: Schema.String,
  generation: Schema.Int, receiptId: Schema.String, durationMs: Schema.Number,
});
export const ClientMessage = Schema.Union([
  HelloMessage, SnapshotRequest, PingRequest, PrepareResolutionMessage,
  PrepareBatchMessage, PrepareUndoMessage, PrepareResetMessage,
  AcceptProposalMessage, AdvanceScenarioMessage, SendAgentTurnMessage,
  StopTutorialMessage, TutorialActionMessage,
  CancelAgentTurnMessage, AgentUiAcknowledgementMessage,
  AgentCompleteAcknowledgementMessage, CommandVisibleAcknowledgementMessage,
]);
export type ClientMessage = typeof ClientMessage.Type;

export type CommandResult =
  | { readonly kind: "proposal"; readonly proposal: ReviewedProposal }
  | { readonly kind: "receipt"; readonly receipt: CommandReceipt }
  | { readonly kind: "scenario"; readonly message: string }
  | { readonly kind: "tutorial"; readonly message: string };
export const CommandResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("proposal"), proposal: ReviewedProposal }),
  Schema.Struct({ kind: Schema.Literal("receipt"), receipt: CommandReceipt }),
  Schema.Struct({ kind: Schema.Literal("scenario"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tutorial"), message: Schema.String }),
]);
export const AgentUiOperationSchema = Schema.Union([
  Schema.Struct({ id: Schema.String, turnId: Schema.String, generation: Schema.Int, kind: Schema.Literal("navigate"), view: Schema.Literals(["work", "explore", "audit", "order"]), orderId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ id: Schema.String, turnId: Schema.String, generation: Schema.Int, kind: Schema.Literal("highlight"), targetId: Schema.String }),
  Schema.Struct({ id: Schema.String, turnId: Schema.String, generation: Schema.Int, kind: Schema.Literal("present_proposal"), proposalId: Schema.String }),
]);
export type AgentUiOperation = typeof AgentUiOperationSchema.Type;
export type ServerMessage =
  | { readonly type: "snapshot"; readonly requestId: string | null; readonly generation: number; readonly sequence: number; readonly state: WorkspaceSnapshot }
  | { readonly type: "command_result"; readonly requestId: string; readonly result: CommandResult; readonly state: WorkspaceSnapshot }
  | { readonly type: "event"; readonly generation: number; readonly sequence: number; readonly event: string; readonly payload: unknown }
  | { readonly type: "audit_event"; readonly event: "audit.attempt.completed"; readonly payload: unknown }
  | { readonly type: "agent_state"; readonly state: WorkspaceSnapshot }
  | { readonly type: "agent_ui_operation"; readonly operation: AgentUiOperation }
  | { readonly type: "pong"; readonly requestId: string }
  | { readonly type: "error"; readonly requestId: string | null; readonly code: string; readonly message: string };
export const ServerMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), requestId: Schema.NullOr(Schema.String), generation: Schema.Int, sequence: Schema.Int, state: WorkspaceSnapshot }),
  Schema.Struct({ type: Schema.Literal("command_result"), requestId: Schema.String, result: CommandResultSchema, state: WorkspaceSnapshot }),
  Schema.Struct({ type: Schema.Literal("event"), generation: Schema.Int, sequence: Schema.Int, event: Schema.String, payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("audit_event"), event: Schema.Literal("audit.attempt.completed"), payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("agent_state"), state: WorkspaceSnapshot }),
  Schema.Struct({ type: Schema.Literal("agent_ui_operation"), operation: AgentUiOperationSchema }),
  Schema.Struct({ type: Schema.Literal("pong"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), requestId: Schema.NullOr(Schema.String), code: Schema.String, message: Schema.String }),
]);
