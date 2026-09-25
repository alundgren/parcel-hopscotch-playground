import { Schema } from "effect";
import { tutorialIds } from "./tutorials.js";
import { exploreScenarioIds } from "./explore.js";
import { GuidanceNoteSchema, GuidanceOfferSchema } from "../guidance/contracts.js";

export const OrderStatus = Schema.Literals(["ready", "review", "waiting"]);
export type OrderStatus = typeof OrderStatus.Type;
export const ResolutionFamily = Schema.Literals(["address", "substitution", "bundle", "weight", "carrier", "duplicate"]);
export type ResolutionFamily = typeof ResolutionFamily.Type;

export const Evidence = Schema.Struct({ label: Schema.String, value: Schema.String, occurredAt: Schema.String, age: Schema.String });
export type Evidence = typeof Evidence.Type;
export const OrderSummary = Schema.Struct({
  id: Schema.String, item: Schema.String, issue: Schema.String, status: OrderStatus,
  statusLabel: Schema.String, family: ResolutionFamily, version: Schema.Int,
  resolved: Schema.Boolean,
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

export const StaleProposalDetail = Schema.Struct({
  kind: Schema.Literal("stale_review"),
  proposalId: Schema.String,
  orderId: Schema.String,
  reason: Schema.Literals(["order_changed", "stock_changed"]),
  expectedVersion: Schema.Int,
  currentVersion: Schema.NullOr(Schema.Int),
  resolved: Schema.Boolean,
});
export type StaleProposalDetail = typeof StaleProposalDetail.Type;

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
export const RunExploreScenarioMessage = Schema.Struct({ type: Schema.Literal("run_explore_scenario"), requestId: Schema.String, generation: Schema.Int, turnId: Schema.String, scenario: Schema.Literal("consent") });
export const StopTutorialMessage = Schema.Struct({ type: Schema.Literal("stop_tutorial"), requestId: Schema.String, generation: Schema.Int });
const TutorialActionRevision = { tutorialId: TutorialId, tutorialInstanceId: Schema.String, expectedStep: Schema.Int };
export const TutorialActionMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("tutorial_action"), requestId: Schema.String, generation: Schema.Int, ...TutorialActionRevision, action: Schema.Literal("order_selected"), orderId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tutorial_action"), requestId: Schema.String, generation: Schema.Int, ...TutorialActionRevision, action: Schema.Literal("ready_filter_selected") }),
  Schema.Struct({ type: Schema.Literal("tutorial_action"), requestId: Schema.String, generation: Schema.Int, ...TutorialActionRevision, action: Schema.Literal("receipt_confirmed"), receiptId: Schema.String }),
]);
export type WorkspaceCommand = typeof PrepareResolutionMessage.Type | typeof PrepareBatchMessage.Type | typeof PrepareUndoMessage.Type | typeof PrepareResetMessage.Type | typeof AcceptProposalMessage.Type | typeof AdvanceScenarioMessage.Type | typeof RunExploreScenarioMessage.Type | typeof StopTutorialMessage.Type | typeof TutorialActionMessage.Type;

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
  guidance: Schema.optionalKey(Schema.Struct({
    problem: Schema.optionalKey(Schema.Struct({ kind: Schema.Literal("stale_review"), proposalId: AgentContextId })),
    activeGuideRef: Schema.optionalKey(AgentContextId),
    visibleTargetIds: Schema.optionalKey(Schema.Array(AgentContextId).check(Schema.isMaxLength(24))),
    disabledTargetIds: Schema.optionalKey(Schema.Array(AgentContextId).check(Schema.isMaxLength(24))),
  })),
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
  outcome: Schema.Literals(["applied", "missing", "missing_target", "stale_context"]),
  context: Schema.optionalKey(AgentViewContext),
});
export const AgentCompleteAcknowledgementMessage = Schema.Struct({
  type: Schema.Literal("agent_complete_ack"), requestId: Schema.String,
  generation: Schema.Int, turnId: Schema.String, durationMs: Schema.Number,
});
export const CommandVisibleAcknowledgementMessage = Schema.Struct({
  type: Schema.Literal("command_visible_ack"), requestId: Schema.String,
  generation: Schema.Int, receiptId: Schema.String, durationMs: Schema.Number,
});
export const AuditListRequest = Schema.Struct({
  type: Schema.Literal("request_audit"), requestId: Schema.String,
  query: Schema.String.check(Schema.isMaxLength(160)), cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  markerCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export const AuditDetailRequest = Schema.Struct({
  type: Schema.Literal("request_audit_detail"), requestId: Schema.String,
  attemptId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  applicationCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export const ClientMessage = Schema.Union([
  HelloMessage, SnapshotRequest, PingRequest, PrepareResolutionMessage,
  PrepareBatchMessage, PrepareUndoMessage, PrepareResetMessage,
  AcceptProposalMessage, AdvanceScenarioMessage, RunExploreScenarioMessage, SendAgentTurnMessage,
  StopTutorialMessage, TutorialActionMessage,
  CancelAgentTurnMessage, AgentUiAcknowledgementMessage,
  AgentCompleteAcknowledgementMessage, CommandVisibleAcknowledgementMessage,
  AuditListRequest, AuditDetailRequest,
]);
export type ClientMessage = typeof ClientMessage.Type;

export type CommandResult =
  | { readonly kind: "proposal"; readonly proposal: ReviewedProposal }
  | { readonly kind: "receipt"; readonly receipt: CommandReceipt }
  | { readonly kind: "scenario"; readonly message: string }
  | { readonly kind: "explore"; readonly scenario: "consent"; readonly attemptId: string; readonly turnId: string; readonly outcome: "completed" | "failed"; readonly message: string }
  | { readonly kind: "tutorial"; readonly message: string; readonly advanced: boolean };
export const CommandResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("proposal"), proposal: ReviewedProposal }),
  Schema.Struct({ kind: Schema.Literal("receipt"), receipt: CommandReceipt }),
  Schema.Struct({ kind: Schema.Literal("scenario"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("explore"), scenario: Schema.Literal("consent"), attemptId: Schema.String, turnId: Schema.String, outcome: Schema.Literals(["completed", "failed"]), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tutorial"), message: Schema.String, advanced: Schema.Boolean }),
]);
export const AgentUiOperationSchema = Schema.Union([
  Schema.Struct({ id: Schema.String, turnId: Schema.String, generation: Schema.Int, kind: Schema.Literal("navigate"), view: Schema.Literals(["work", "explore", "audit", "order"]), orderId: Schema.optionalKey(Schema.String), filter: Schema.optionalKey(Schema.Literal("ready")) }),
  Schema.Struct({ id: Schema.String, turnId: Schema.String, generation: Schema.Int, kind: Schema.Literal("highlight"), targetId: Schema.String, proposalId: Schema.optional(Schema.String) }),
  Schema.Struct({ id: Schema.String, turnId: Schema.String, generation: Schema.Int, kind: Schema.Literal("present_proposal"), proposalId: Schema.String }),
  Schema.Struct({ id: Schema.String, turnId: Schema.String, generation: Schema.Int, kind: Schema.Literal("offer_guide"), contextRef: AgentContextId, offer: GuidanceOfferSchema }),
  Schema.Struct({ id: Schema.String, turnId: Schema.String, generation: Schema.Int, kind: Schema.Literal("show_note"), contextRef: AgentContextId, note: GuidanceNoteSchema }),
]);
export type AgentUiOperation = typeof AgentUiOperationSchema.Type;

export const AuditAttemptMode = Schema.Literals(["live", "scripted", "unavailable"]);
export type AuditAttemptMode = typeof AuditAttemptMode.Type;
export const AuditAttemptOutcome = Schema.Literals(["running", "success", "error", "credits_exhausted", "timeout", "cancelled", "interrupted"]);
export type AuditAttemptOutcome = typeof AuditAttemptOutcome.Type;
export const AuditAttemptSummary = Schema.Struct({
  id: Schema.String, generation: Schema.Int, requestId: Schema.String, turnId: Schema.String,
  kind: Schema.Literals(["chat", "decisions"]), mode: AuditAttemptMode,
  provider: Schema.String, requestedModel: Schema.String, actualModel: Schema.NullOr(Schema.String),
  requestLabel: Schema.String, startedAt: Schema.String, completedAt: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Number), inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number), totalTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number), outcome: AuditAttemptOutcome,
  errorCode: Schema.NullOr(Schema.String), retryCount: Schema.Int,
});
export type AuditAttemptSummary = typeof AuditAttemptSummary.Type;
export const AuditApplicationRecord = Schema.Struct({
  id: Schema.String, kind: Schema.Literals(["tool", "ui", "turn", "proposal", "receipt", "reset", "command_visible"]),
  label: Schema.String, outcome: Schema.String, occurredAt: Schema.String,
  requestId: Schema.NullOr(Schema.String), turnId: Schema.NullOr(Schema.String),
  proposalId: Schema.NullOr(Schema.String), receiptId: Schema.NullOr(Schema.String),
  bodyText: Schema.String,
});
export type AuditApplicationRecord = typeof AuditApplicationRecord.Type;
export const AuditRequestSummary = Schema.Struct({
  id: Schema.String, generation: Schema.Int, turnId: Schema.String,
  requestLabel: Schema.String, startedAt: Schema.String, turnCount: Schema.Int,
  outcome: Schema.Literals(["running", "success", "error", "credits_exhausted", "timeout", "cancelled", "interrupted", "unknown"]),
  durationMs: Schema.NullOr(Schema.Number), totalTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number), mode: Schema.Literals(["live", "scripted", "unavailable", "mixed"]),
});
export type AuditRequestSummary = typeof AuditRequestSummary.Type;
export const AuditPage = Schema.Struct({
  requests: Schema.Array(AuditRequestSummary),
  query: Schema.String, attempts: Schema.Array(AuditAttemptSummary), total: Schema.Int,
  nextCursor: Schema.NullOr(Schema.String), markers: Schema.Array(AuditApplicationRecord),
  markerNextCursor: Schema.NullOr(Schema.String),
});
export type AuditPage = typeof AuditPage.Type;
export const AuditAttemptDetail = Schema.Struct({
  attempt: AuditAttemptSummary, providerRequestId: Schema.NullOr(Schema.String), generationId: Schema.NullOr(Schema.String),
  requestBytes: Schema.Int, responseBytes: Schema.NullOr(Schema.Int), errorMessage: Schema.NullOr(Schema.String),
  requestText: Schema.String, responseText: Schema.NullOr(Schema.String),
  requestTruncated: Schema.Boolean, responseTruncated: Schema.Boolean,
  serverTurnDurationMs: Schema.NullOr(Schema.Number),
  serverTurnMeasurement: Schema.NullOr(Schema.Literals(["pending", "complete", "incomplete"])),
  browserDurationMs: Schema.NullOr(Schema.Number),
  browserMeasurement: Schema.NullOr(Schema.Literals(["pending", "complete", "incomplete"])),
  application: Schema.Array(AuditApplicationRecord),
  applicationNextCursor: Schema.NullOr(Schema.String),
});
export type AuditAttemptDetail = typeof AuditAttemptDetail.Type;
export type ServerMessage =
  | { readonly type: "snapshot"; readonly requestId: string | null; readonly generation: number; readonly sequence: number; readonly state: WorkspaceSnapshot }
  | { readonly type: "command_result"; readonly requestId: string; readonly result: CommandResult; readonly state: WorkspaceSnapshot }
  | { readonly type: "event"; readonly generation: number; readonly sequence: number; readonly event: string; readonly payload: unknown }
  | { readonly type: "audit_event"; readonly event: "audit.attempt.completed"; readonly payload: unknown }
  | { readonly type: "audit_page"; readonly requestId: string; readonly page: AuditPage }
  | { readonly type: "audit_detail"; readonly requestId: string; readonly detail: AuditAttemptDetail | null }
  | { readonly type: "tool_catalogue"; readonly entries: ReadonlyArray<ToolCatalogueEntry> }
  | { readonly type: "agent_state"; readonly state: WorkspaceSnapshot }
  | { readonly type: "agent_ui_operation"; readonly operation: AgentUiOperation }
  | { readonly type: "pong"; readonly requestId: string }
  | { readonly type: "error"; readonly requestId: string | null; readonly code: string; readonly message: string; readonly detail?: StaleProposalDetail };
export const ServerMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), requestId: Schema.NullOr(Schema.String), generation: Schema.Int, sequence: Schema.Int, state: WorkspaceSnapshot }),
  Schema.Struct({ type: Schema.Literal("command_result"), requestId: Schema.String, result: CommandResultSchema, state: WorkspaceSnapshot }),
  Schema.Struct({ type: Schema.Literal("event"), generation: Schema.Int, sequence: Schema.Int, event: Schema.String, payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("audit_event"), event: Schema.Literal("audit.attempt.completed"), payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("audit_page"), requestId: Schema.String, page: AuditPage }),
  Schema.Struct({ type: Schema.Literal("audit_detail"), requestId: Schema.String, detail: Schema.NullOr(AuditAttemptDetail) }),
  Schema.Struct({ type: Schema.Literal("tool_catalogue"), entries: Schema.Array(Schema.Struct({
    id: Schema.String,
    purpose: Schema.String,
    category: Schema.Literals(["Read", "Guide", "Prepare", "Classify"]),
    description: Schema.String,
    allowedEffects: Schema.Array(Schema.String),
    example: Schema.Struct({ arguments: Schema.Unknown, result: Schema.Unknown }),
    inputSchema: Schema.Record(Schema.String, Schema.Unknown),
    outputSchema: Schema.Record(Schema.String, Schema.Unknown),
  })) }),
  Schema.Struct({ type: Schema.Literal("agent_state"), state: WorkspaceSnapshot }),
  Schema.Struct({ type: Schema.Literal("agent_ui_operation"), operation: AgentUiOperationSchema }),
  Schema.Struct({ type: Schema.Literal("pong"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), requestId: Schema.NullOr(Schema.String), code: Schema.String, message: Schema.String, detail: Schema.optionalKey(StaleProposalDetail) }),
]);

export type ToolCategory = "Read" | "Guide" | "Prepare" | "Classify";
export interface ToolCatalogueEntry {
  readonly id: string;
  readonly purpose: string;
  readonly category: ToolCategory;
  readonly description: string;
  readonly allowedEffects: ReadonlyArray<string>;
  readonly example: { readonly arguments: unknown; readonly result: unknown };
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}
export const ExploreScenarioId = Schema.Literals(exploreScenarioIds);
export type ExploreScenarioId = typeof ExploreScenarioId.Type;
