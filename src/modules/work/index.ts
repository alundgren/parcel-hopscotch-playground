import type { GuidanceModule, GuidanceTargetDefinition, GuidanceGuideDefinition } from "../../guidance/catalog.js";
import type { GuidanceInput, GuidanceOrder, GuidanceProblem } from "../input.js";

export const workGuidanceTargets = {
  queue: "work.queue",
  orderRow: (id: string) => `work.order.row:${id}` as const,
  orderEvidence: (id: string) => `work.order.evidence:${id}` as const,
  reviewChange: (id: string) => `work.order.review:${id}` as const,
  proposalReview: (id: string) => `work.proposal.review:${id}` as const,
} as const;
export type WorkGuidanceTargetId = typeof workGuidanceTargets.queue | ReturnType<typeof workGuidanceTargets.orderRow> | ReturnType<typeof workGuidanceTargets.orderEvidence> | ReturnType<typeof workGuidanceTargets.reviewChange> | ReturnType<typeof workGuidanceTargets.proposalReview>;

export const workGuides = {
  staleReview: "work.stale-review",
} as const;
export type WorkGuideId = (typeof workGuides)[keyof typeof workGuides];
export const workGuideVersion = 1;

export type ReviewChangeAvailability =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: "Reconnect to review this item." | "This item is no longer available." | "This change was already accepted." | "Wait for the current action to finish." };

export const reviewChangeAvailability = (input: {
  readonly connected: boolean;
  readonly order: GuidanceOrder | null;
  readonly resolved?: boolean;
  readonly busy?: boolean;
}): ReviewChangeAvailability => {
  if (input.order === null) return { available: false, reason: "This item is no longer available." };
  if (input.order.resolved ?? input.resolved ?? false) return { available: false, reason: "This change was already accepted." };
  if (!input.connected) return { available: false, reason: "Reconnect to review this item." };
  if (input.busy) return { available: false, reason: "Wait for the current action to finish." };
  return { available: true, reason: null };
};

export const workGuideNote = (input: {
  readonly stepId: string;
  readonly order: (GuidanceOrder & { readonly businessValue: string; readonly issue: string; readonly evidence: ReadonlyArray<{ readonly label: string; readonly value: string }> }) | null;
  readonly problem: GuidanceProblem | null;
  readonly availability: ReviewChangeAvailability;
}): string | null => {
  if (input.stepId === "review" && !input.availability.available) return input.availability.reason;
  if (input.order === null) return null;
  const resolved = input.order.resolved ?? input.problem?.resolved ?? false;
  if (input.stepId !== "inspect" && input.stepId !== "review" && !(input.stepId === "return" && resolved)) return null;
  const evidence = input.order.evidence.at(-1);
  const prefix = resolved ? "The change was already accepted." : "The earlier review is out of date.";
  const next = input.stepId === "review" ? " Use Review change to check a fresh proposal." : input.stepId === "return" ? " Return to Work for a fresh review." : "";
  const detail = evidence?.value ?? input.order.issue;
  return `${prefix} Current: ${input.order.businessValue}. ${evidence?.label ?? "Evidence"}: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${next}`;
};

const affectedOrder = (input: GuidanceInput): GuidanceOrder | null => {
  const id = input.problem?.orderId ?? (input.location.focus?.kind === "order" ? input.location.focus.id : null);
  return id === null ? null : input.orders.find((order) => order.id === id) ?? null;
};

const workTargets = (input: GuidanceInput): ReadonlyArray<GuidanceTargetDefinition> => {
  const order = affectedOrder(input);
  const entityId = order?.id ?? input.problem?.orderId ?? null;
  const review = reviewChangeAvailability({ connected: input.connected, order, resolved: input.problem?.resolved });
  const exists = { available: order !== null, reason: order === null ? "This item is no longer available." : null };
  const queue = { available: true, reason: null };
  const proposal = input.currentProposal;
  const proposalReview = proposal === null || proposal.id === input.problem?.proposalId
    ? { available: false, reason: "Prepare a fresh review first." }
    : !proposal.changes.some((change) => change.orderId === entityId)
      ? { available: false, reason: "This proposal is for another item." }
      : !proposal.ready
        ? { available: false, reason: "This proposal is held and cannot be accepted." }
        : !input.connected
          ? { available: false, reason: "Reconnect to accept this proposal." }
          : { available: true, reason: null };
  return [
    { id: workGuidanceTargets.queue, label: "Work queue", destination: "work", entityId: null, availability: queue },
    { id: workGuidanceTargets.orderRow(entityId ?? "missing"), label: "Affected item in Work", destination: "work", entityId, availability: exists },
    { id: workGuidanceTargets.orderEvidence(entityId ?? "missing"), label: "Current item evidence", destination: "order", entityId, availability: exists },
    { id: workGuidanceTargets.reviewChange(entityId ?? "missing"), label: "Review change", destination: "order", entityId, availability: review },
    { id: workGuidanceTargets.proposalReview(entityId ?? "missing"), label: "Fresh proposal review", destination: "work", entityId, availability: proposalReview },
  ];
};

const workGuideDefinitions = (input: GuidanceInput): ReadonlyArray<GuidanceGuideDefinition> => {
  const problem = input.problem;
  if (problem === null) return [];
  const order = affectedOrder(input);
  if (order === null) return [];
  const common = [
    { id: "inspect", destination: "order" as const, targetId: workGuidanceTargets.orderEvidence(order.id), entityId: order.id, instruction: "Open the affected item and read its current evidence.", eventKind: "destination_ready", completion: "target" as const },
  ];
  const remaining = problem.resolved ? [
    { id: "return", destination: "work" as const, targetId: workGuidanceTargets.queue, entityId: order.id, instruction: "This change was already accepted. Return to Work and request a fresh batch when you are ready.", eventKind: "returned", completion: "target" as const },
  ] : [
    { id: "review", destination: "order" as const, targetId: workGuidanceTargets.reviewChange(order.id), entityId: order.id, instruction: "Use Review change to prepare a fresh proposal from the current evidence.", eventKind: "proposal_prepared", completion: "result" as const },
    { id: "accept", destination: "work" as const, targetId: workGuidanceTargets.proposalReview(order.id), entityId: order.id, instruction: "Check the fresh proposal, then accept it if it matches the evidence.", eventKind: "proposal_accepted", completion: "bound_result" as const },
    { id: "return", destination: "work" as const, targetId: workGuidanceTargets.queue, entityId: order.id, instruction: "Return to Work. Request a fresh batch if you still need one.", eventKind: "returned", completion: "target" as const },
  ];
  return [{
    id: workGuides.staleReview,
    version: workGuideVersion,
    title: "Review an affected item",
    summary: problem.resolved ? "See the current item and return after an earlier change was accepted." : "Inspect current evidence and review a fresh change after a stale proposal.",
    offerText: problem.resolved
      ? "That change was already accepted. I can show you the current item and help you return to Work."
      : "Nothing was applied because this review is out of date. I can show you the affected item and the next action.",
    entityId: order.id,
    primaryTargetId: workGuidanceTargets.orderRow(order.id),
    steps: [...common, ...remaining],
  }];
};

export const workGuidanceModule: GuidanceModule<GuidanceInput> = {
  id: "work",
  version: 1,
  facts: (input) => input.problem === null ? [] : [
    input.problem.resolved ? "The earlier change was already accepted." : "The earlier proposal is stale. Nothing was applied.",
    input.problem.reason === "stock_changed" ? "Stock changed since the review." : "The item changed since the review.",
  ],
  targets: workTargets,
  guides: workGuideDefinitions,
};
