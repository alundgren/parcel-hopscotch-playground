import { vi } from "vite-plus/test";
import type {
  AuditAttemptDetail,
  AuditAttemptSummary,
  AuditPage,
  CommandReceipt,
  CommandResult,
  ReviewedProposal,
  ToolCatalogueEntry,
  WorkspaceSnapshot,
} from "../../src/shared/contracts";

const now = "2026-09-22T12:34:56.000Z";

export const orders: WorkspaceSnapshot["orders"] = [
  {
    id: "BB-1042",
    item: "Oak bedside table",
    issue: "The customer supplied a corrected flat number before dispatch.",
    status: "review",
    statusLabel: "Review",
    family: "address",
    version: 3,
    businessValue: "14 Market Road, London, W1 4AB",
    targetId: "order-BB-1042",
    evidence: [
      { label: "Customer note", value: "Please use Flat 8, 14 Market Road, London, W1 4AB. The first address missed the flat.", occurredAt: now, age: "12 minutes ago" },
      { label: "Carrier", value: "Label has not been purchased", occurredAt: now, age: "8 minutes ago" },
    ],
  },
  {
    id: "BB-1076",
    item: "Linen shade and walnut lamp base with an intentionally long catalogue name",
    issue: "Customer accepted a replacement if the original finish cannot ship this week.",
    status: "ready",
    statusLabel: "Ready",
    family: "substitution",
    version: 2,
    businessValue: "Natural linen / walnut",
    targetId: "order-BB-1076",
    evidence: [{ label: "Customer reply", value: "The natural shade is fine if the ivory one is delayed.", occurredAt: now, age: "24 minutes ago" }],
  },
  {
    id: "BB-1091",
    item: "Woven storage basket",
    issue: "Waiting for the next carrier scan.",
    status: "waiting",
    statusLabel: "Waiting",
    family: "carrier",
    version: 1,
    businessValue: "Tracking scan pending",
    targetId: "order-BB-1091",
    evidence: [{ label: "Carrier", value: "Manifest received", occurredAt: now, age: "1 hour ago" }],
  },
];

export const proposal: ReviewedProposal = {
  id: "proposal-1",
  generation: 1,
  kind: "batch",
  title: "Review ready orders",
  ready: true,
  changes: [
    { orderId: "BB-1076", family: "substitution", before: "Ivory linen / walnut", after: "Natural linen / walnut", effect: "Reserve the in-stock natural shade and release the delayed ivory shade.", expectedVersion: 2 },
  ],
  omissions: [{ orderId: "BB-1042", reason: "Address evidence still needs review." }],
  effects: [],
  createdAt: now,
};

export const addressProposal: ReviewedProposal = {
  id: "proposal-address",
  generation: 1,
  kind: "resolution",
  title: "Check address",
  ready: true,
  changes: [
    { orderId: "BB-1042", family: "address", before: "14 Market Road, London, W1 4AB", after: "Flat 8, 14 Market Road, London, W1 4AB", effect: "Use the corrected delivery address before dispatch.", expectedVersion: 3 },
  ],
  omissions: [],
  effects: [],
  createdAt: now,
};

export const receipt: CommandReceipt = {
  id: "receipt-1",
  proposalId: proposal.id,
  generation: 1,
  kind: "accept",
  title: "One change saved",
  changes: proposal.changes,
  committedAt: now,
  undoable: true,
};

export const snapshot: WorkspaceSnapshot = {
  generation: 1,
  sequence: 10,
  orders,
  latestReceipt: receipt,
  tutorialReceipt: null,
  currentProposal: null,
  tutorialProposal: null,
  chat: [
    { id: "chat-1", turnId: "turn-1", role: "assistant", content: "I can help you review the recorded evidence and prepare a change for you to approve.", createdAt: now },
    { id: "chat-2", turnId: "turn-2", role: "user", content: "Show me what needs attention.", createdAt: now },
  ],
  activeTurn: null,
  agentMode: "scripted",
  tutorial: null,
};

export const tools: ReadonlyArray<ToolCatalogueEntry> = [
  { id: "listOrders", purpose: "List orders", category: "Read", description: "Read the current order queue using explicit status and family filters.", allowedEffects: ["read_workspace"], example: { arguments: { status: "ready" }, result: { orders: ["BB-1076"] } }, inputSchema: {}, outputSchema: {} },
  { id: "navigate", purpose: "Open a view", category: "Guide", description: "Navigate to a registered view or recorded order.", allowedEffects: ["navigate_registered_view"], example: { arguments: { view: "work", orderId: "BB-1042" }, result: { opened: true } }, inputSchema: {}, outputSchema: {} },
  { id: "prepareBatch", purpose: "Prepare batch", category: "Prepare", description: "Prepare eligible changes for the person to inspect and accept.", allowedEffects: ["create_reviewed_proposal"], example: { arguments: { status: "ready" }, result: { proposalId: "proposal-1" } }, inputSchema: {}, outputSchema: {} },
  { id: "checkConsent", purpose: "Check consent", category: "Classify", description: "Classify a bounded customer reply and preserve the result in Audit.", allowedEffects: ["provider_classification", "read_only"], example: { arguments: { orderId: "BB-1076" }, result: { consent: "conditional", needsReview: true } }, inputSchema: {}, outputSchema: {} },
];

export const completedAttempt: AuditAttemptSummary = {
  id: "attempt-success",
  generation: 1,
  requestId: "request-success",
  turnId: "turn-success",
  kind: "chat",
  mode: "live",
  provider: "openrouter",
  requestedModel: "mistralai/ministral-3b-2512",
  actualModel: "mistralai/ministral-3b-2512",
  requestLabel: "Summarise the ready orders and explain why BB-1076 qualifies",
  startedAt: now,
  completedAt: now,
  durationMs: 1284,
  inputTokens: 864,
  outputTokens: 176,
  totalTokens: 1040,
  costUsd: 0.0000312,
  outcome: "success",
  errorCode: null,
  retryCount: 0,
};

export const failedAttempt: AuditAttemptSummary = {
  ...completedAttempt,
  id: "attempt-error",
  requestId: "request-error",
  turnId: "turn-error",
  requestLabel: "Check the customer reply for replacement consent",
  actualModel: null,
  requestedModel: "typesafe/jev-1.13",
  durationMs: 820,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
  outcome: "error",
  errorCode: "provider_unavailable",
  retryCount: 1,
};

export const auditPage: AuditPage = {
  query: "",
  requests: [completedAttempt, failedAttempt].map((attempt) => ({
    id: attempt.id, generation: attempt.generation, turnId: attempt.turnId,
    requestLabel: attempt.requestLabel, startedAt: attempt.startedAt, turnCount: 1,
    outcome: attempt.outcome, durationMs: attempt.id === completedAttempt.id ? 1810 : null,
    totalTokens: attempt.totalTokens, costUsd: attempt.costUsd, mode: attempt.mode,
  })),
  attempts: [completedAttempt, failedAttempt],
  total: 2,
  nextCursor: null,
  markers: [],
  markerNextCursor: null,
};

export const auditDetail: AuditAttemptDetail = {
  attempt: completedAttempt,
  providerRequestId: "provider-request-1",
  generationId: "generation-1",
  requestBytes: 1432,
  responseBytes: 892,
  errorMessage: null,
  requestText: JSON.stringify({ messages: [{ role: "user", content: "Summarise the ready orders and explain why BB-1076 qualifies" }], tools: ["listOrders", "getOrder"] }, null, 2),
  responseText: JSON.stringify({ answer: "BB-1076 is ready because its replacement is in stock and its evidence is current.", repeatedContext: "A long response value verifies that preformatted content wraps within the review panel instead of extending past the viewport.".repeat(5) }, null, 2),
  requestTruncated: false,
  responseTruncated: false,
  serverTurnDurationMs: 1640,
  serverTurnMeasurement: "complete",
  browserDurationMs: 1812,
  browserMeasurement: "complete",
  application: [{ id: "application-1", kind: "tool", label: "listOrders", outcome: "success", occurredAt: now, requestId: "request-success", turnId: "turn-success", proposalId: null, receiptId: null, bodyText: JSON.stringify({ result: { ok: true, orders: ["BB-1076"] } }, null, 2) }],
  applicationNextCursor: null,
};

type WorkspaceOverrides = Partial<{
  snapshot: WorkspaceSnapshot | null;
  status: "connecting" | "connected" | "reconnecting" | "offline" | "retired";
  auditPage: AuditPage | null;
  auditDetails: Readonly<Record<string, AuditAttemptDetail>>;
  auditLoading: boolean;
  auditError: string | null;
  toolCatalogue: ReadonlyArray<ToolCatalogueEntry>;
  runCommand: (input: { readonly type: string }) => Promise<CommandResult>;
}>;

export const createWorkspace = (overrides: WorkspaceOverrides = {}) => ({
  snapshot,
  status: "connected" as const,
  toolCatalogue: tools,
  runCommand: vi.fn(async (input: { readonly type: string }): Promise<CommandResult> => {
    if (input.type === "prepare_batch" || input.type === "prepare_resolution") return { kind: "proposal", proposal };
    if (input.type === "accept_proposal") return { kind: "receipt", receipt };
    if (input.type === "prepare_undo") return { kind: "proposal", proposal: { ...proposal, id: "undo-1", kind: "undo", title: "Review undo" } };
    return { kind: "scenario", message: "Scenario advanced." };
  }),
  runExploreScenario: vi.fn(async () => ({ kind: "explore" as const, scenario: "consent" as const, attemptId: completedAttempt.id, turnId: completedAttempt.turnId, outcome: "completed" as const, message: "Consent classified." })),
  sendAgentMessage: vi.fn(() => "turn-new"),
  cancelAgentTurn: vi.fn(),
  agentOperation: null,
  acknowledgeAgentOperation: vi.fn(),
  acknowledgeAgentComplete: vi.fn(),
  acknowledgeCommandVisible: vi.fn(),
  agentError: null,
  auditPage,
  auditDetails: { [completedAttempt.id]: auditDetail },
  auditLoading: false,
  auditError: null,
  auditRevision: 0,
  requestAudit: vi.fn(),
  requestAuditDetail: vi.fn(),
  ...overrides,
});

export const groupedAuditPage: AuditPage = {
  query: "", total: 2, nextCursor: null, markers: [], markerNextCursor: null,
  requests: [
    { id: "mug-1", generation: 1, turnId: "mug", requestLabel: "teach me how to fix the stone mug problem", startedAt: "2026-09-23T06:25:40Z", turnCount: 2, outcome: "success", durationMs: 1120, totalTokens: 5661, costUsd: 0.000299, mode: "live" },
    { id: "candle-1", generation: 1, turnId: "candle", requestLabel: "open the matched candle review for me", startedAt: "2026-09-23T06:24:21Z", turnCount: 3, outcome: "success", durationMs: 1430, totalTokens: 10558, costUsd: 0.000410, mode: "live" },
  ],
  attempts: [
    { ...completedAttempt, id: "mug-1", turnId: "mug", requestLabel: "teach me how to fix the stone mug problem", startedAt: "2026-09-23T06:25:40Z", durationMs: 554, totalTokens: 2757, costUsd: 0.000253 },
    { ...completedAttempt, id: "mug-2", turnId: "mug", requestLabel: "teach me how to fix the stone mug problem", startedAt: "2026-09-23T06:25:41Z", durationMs: 362, totalTokens: 2904, costUsd: 0.000046 },
    { ...completedAttempt, id: "candle-1", turnId: "candle", requestLabel: "open the matched candle review for me", startedAt: "2026-09-23T06:24:21Z", durationMs: 543, totalTokens: 3473, costUsd: 0.000322 },
    { ...completedAttempt, id: "candle-2", turnId: "candle", requestLabel: "open the matched candle review for me", startedAt: "2026-09-23T06:24:21Z", durationMs: 316, totalTokens: 3518, costUsd: 0.000043 },
    { ...completedAttempt, id: "candle-3", turnId: "candle", requestLabel: "open the matched candle review for me", startedAt: "2026-09-23T06:24:22Z", durationMs: 336, totalTokens: 3567, costUsd: 0.000045 },
  ],
};
