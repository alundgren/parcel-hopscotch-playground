import type { GuidanceModule, GuidanceTargetDefinition, GuidanceGuideDefinition } from "../../guidance/catalog.js";
import type { GuidanceInput, GuidanceOrder, GuidanceProblem } from "../input.js";
import type { OrderStatus, ReviewedProposal, TutorialState } from "../../shared/contracts.js";

export const workOperatorGuide = `Start in Work. Open an order to inspect its recorded issue, current details, and customer messages or order updates.

Review change opens a proposal. Compare the before/after values, consequences, and excluded orders, then choose Accept or Cancel. A proposal is only a preview. Only your acceptance saves a business change.

Resolving an exception can move an order into the Ready queue. Those orders still await release to packing. Outside tutorials, Review ready orders previews all currently eligible Ready orders together. Tutorials use their assigned practice groups. Accepting a packing batch releases its included orders to packing. There is no arbitrary single-order or selected-order packing control.

An accepted change has a receipt. Undo, when available, prepares a checked reversal of the whole receipt, including every order in an accepted batch. Review and accept that reversal too. A later change can make Undo unavailable.`;

export const describeOrderProgress = (order: { readonly status: OrderStatus; readonly completed: boolean; readonly resolved: boolean }) => ({
  resolution: order.resolved ? "A reviewed action was accepted for this order. Check its current issue for any remaining work." : "No reviewed action is currently applied to this order.",
  packing: order.completed
    ? "Released to packing. This does not establish that physical packing or shipping has finished."
    : order.status === "ready"
      ? "Awaiting release to packing through a separate review of all currently eligible Ready orders."
      : "Not released to packing. Review the order issue and its customer message or update.",
});

export const describeOpenedOrder = (record: OrderProgressForOpenedOrder): string => {
  const label = (record.order.evidence.at(-1)?.label ?? "Order details").replace(/^./, (first) => first.toLowerCase());
  const next = record.resolved
    ? "A change was already accepted for this order. Check its current details before taking another action."
    : "Use Review change to prepare a correction. Check the proposed change before accepting it.";
  return `${record.order.id} is open. The ${label} is visible with the current ${record.order.family === "address" ? "address" : "order details"}. ${next}`;
};

export const describeOrderWalkthrough = (record: OrderProgressForWalkthrough): string => {
  const order = record.order;
  const note = order.evidence.at(-1);
  const plain = (value: string) => value.replace(/[\\`*_[\]<>#]/g, "\\$&");
  const details = note === undefined ? "" : ` ${plain(note.label)}: "${plain(note.value)}"${/[.!?]$/.test(note.value) ? "" : "."}`;
  const next = record.resolved
    ? "A change was already accepted. Open the order to check its current details."
    : "Use Review change to preview the correction. Check the proposed change, then accept it if it is right.";
  return `${plain(order.id)}: ${plain(order.issue)} Current ${order.family === "address" ? "address" : "details"}: ${plain(order.businessValue)}.${details} ${next} Would you like me to open ${plain(order.id)} for you?`;
};

type OrderProgressForOpenedOrder = {
  readonly order: { readonly id: string; readonly family: string; readonly evidence: ReadonlyArray<{ readonly label: string }> };
  readonly resolved: boolean;
};

type OrderProgressForWalkthrough = {
  readonly order: {
    readonly id: string;
    readonly family: string;
    readonly issue: string;
    readonly businessValue: string;
    readonly evidence: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  };
  readonly resolved: boolean;
};

export const workPolicyReplies = {
  job_guide: workOperatorGuide,
  ready_help: "Use Review ready orders to open a preview of all currently eligible Ready orders. Check which orders are included or left out, then accept the preview in the app if it is correct. Nothing changes until you accept it. During a tutorial, the review is limited to its practice group.",
  current_preview_help: "Check the proposed changes and any orders left out before using that control. Only your click applies the preview; this help does not accept it for you.",
  packing_subset: "Packing individual or selected orders is not supported. Outside tutorials, Review ready orders previews all currently eligible Ready orders. Tutorials use assigned practice groups. Would you like to review the full eligible batch? Nothing changes until you accept the preview in the app.",
  undo_subset: "Undo reverses the whole accepted receipt, including every order in a batch. A partial reversal of a batch is not supported. Would you like a preview of reversing the whole receipt? Nothing changes until you review and accept it in the app; later changes can make Undo unavailable.",
  undo_earlier_correction: "The latest accepted receipt for this order is a packing batch. This record does not identify the earlier correction receipt. Undo cannot overwrite later accepted changes. No Undo preview was prepared.",
  acceptance_only: "Only you can accept a reviewed change in the app. Inspect the preview, then use its acceptance control if it is correct. Chat approval does not save changes. I can help read customer messages and order updates or prepare a preview when you request one.",
} as const;

export const proposalAcceptanceLabel = (proposal: Pick<ReviewedProposal, "kind" | "changes">): string => proposal.kind === "reset"
  ? "Reset my demo"
  : `Accept ${proposal.changes.length} ${proposal.changes.length === 1 ? "change" : "changes"}`;

export const tutorialPackingReply = "This tutorial can prepare only its assigned practice group. It cannot select arbitrary orders or prepare the full Work queue. Finish or dismiss the tutorial before requesting a review of the full eligible batch. No new preview was prepared.";

export const describeTutorialState = (tutorial: Pick<TutorialState, "title" | "instruction"> | null): string => tutorial === null
  ? "The tutorial is dismissed. Accepted work is unchanged."
  : `The ${tutorial.title} tutorial is active. ${tutorial.instruction} Follow the tutorial in the app; your verified actions advance it, and you can dismiss it at any time.`;

export const describeOrderAnswer = (record: {
  readonly order: { readonly id: string; readonly businessValue: string; readonly issue: string; readonly status: OrderStatus; readonly statusLabel: string; readonly evidence: ReadonlyArray<{ readonly label: string; readonly value: string }> };
  readonly completed: boolean;
  readonly resolved: boolean;
  readonly latestReceipt: { readonly title: string; readonly totalChanges: number; readonly change: { readonly before: string; readonly after: string } } | null;
}): string => {
  const progress = describeOrderProgress({ status: record.order.status, completed: record.completed, resolved: record.resolved });
  const receipt = record.latestReceipt;
  const plain = (value: string) => value.replace(/[\\`*_[\]<>#]/g, "\\$&");
  const evidence = record.order.evidence.map((item) => `${plain(item.label)}: ${plain(item.value)}`).join("\n\n");
  return `${plain(record.order.id)}: ${plain(record.order.businessValue)}\n\nRecorded status: ${plain(record.order.statusLabel)}. Recorded issue: ${plain(record.order.issue)}\n\n${evidence}\n\n${progress.resolution} ${progress.packing}\n\n${receipt === null ? "No accepted change receipt is recorded for this order." : `Latest receipt: ${plain(receipt.title)}. This order's change: ${plain(receipt.change.before)} → ${plain(receipt.change.after)}. The receipt contains ${receipt.totalChanges} ${receipt.totalChanges === 1 ? "change" : "changes"}. If Undo is available, it reverses the whole receipt.`}`;
};

export const describeQueueAnswer = (orders: ReadonlyArray<{ readonly status: OrderStatus }>): string =>
  `Work has ${orders.length} orders.\nReady: ${orders.filter((order) => order.status === "ready").length}\nReview: ${orders.filter((order) => order.status === "review").length}\nWaiting: ${orders.filter((order) => order.status === "waiting").length}\n\nOpen an order to read its issue and customer message or update. Ready orders can enter a packing review if current checks pass; Ready alone does not establish an accepted correction or physical packing.`;

export const describeProposalReview = (proposal: Pick<ReviewedProposal, "kind" | "ready" | "changes">): string => {
  if (!proposal.ready) return "The preview is held and cannot be accepted. Review the reasons shown. No business changes were saved.";
  const count = proposal.changes.length;
  const changes = `${count} ${count === 1 ? "change" : "changes"}`;
  switch (proposal.kind) {
    case "resolution": return "The correction preview is ready for your review. Nothing changes until you accept it in the app. Accepting this correction does not release the order to packing. When ready to release eligible orders, use Review ready orders to review and accept a separate packing batch.";
    case "batch": return `The packing preview contains ${changes}. Check the included orders and exclusions. Nothing changes until you accept it in the app. Accepting releases the included orders to packing; it does not confirm that packing or shipping has finished.`;
    case "undo": return `The Undo preview reverses ${changes} from the whole accepted receipt. Check every reversal before accepting. Nothing changes until you accept it in the app.`;
    case "reset": return "The reset preview is ready for your review. Accepting restores the example workspace and keeps Audit history. Nothing changes until you accept it in the app.";
  }
};

export const workGuidanceTargets = {
  queue: "work.queue",
  batchReview: "work.queue.batch-review",
  orderRow: (id: string) => `work.order.row:${id}` as const,
  orderEvidence: (id: string) => `work.order.evidence:${id}` as const,
  reviewChange: (id: string) => `work.order.review:${id}` as const,
  proposalReview: (id: string) => `work.proposal.review:${id}` as const,
  proposalAccept: (id: string) => `work.proposal.accept:${id}` as const,
} as const;
export type WorkGuidanceTargetId = typeof workGuidanceTargets.queue | typeof workGuidanceTargets.batchReview | ReturnType<typeof workGuidanceTargets.orderRow> | ReturnType<typeof workGuidanceTargets.orderEvidence> | ReturnType<typeof workGuidanceTargets.reviewChange> | ReturnType<typeof workGuidanceTargets.proposalReview> | ReturnType<typeof workGuidanceTargets.proposalAccept>;

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

export const readyReviewAvailability = (connected: boolean, orders: ReadonlyArray<{ readonly status: OrderStatus }>) => {
  if (!connected) return { available: false, reason: "Reconnect to review Ready orders." };
  if (!orders.some((order) => order.status === "ready")) return { available: false, reason: "No Ready orders are available." };
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
  return `${prefix} Current: ${input.order.businessValue}. ${evidence?.label ?? "Order issue"}: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${next}`;
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
  const batchReview = readyReviewAvailability(input.connected, input.orders);
  const proposal = input.presentedProposal;
  const proposalReview = proposal === null || proposal.id === input.problem?.proposalId
    ? { available: false, reason: "Prepare a fresh review first." }
    : !proposal.ready
      ? { available: false, reason: "This proposal is held and cannot be accepted." }
      : !proposal.changes.some((change) => change.orderId === entityId)
        ? { available: false, reason: "This proposal is for another item." }
        : !input.connected
          ? { available: false, reason: "Reconnect to accept this proposal." }
          : { available: true, reason: null };
  return [
    { id: workGuidanceTargets.queue, label: "Work queue", destination: "work", entityId: null, availability: queue },
    { id: workGuidanceTargets.batchReview, label: "Review ready orders", destination: "work", entityId: null, availability: batchReview },
    { id: workGuidanceTargets.orderRow(entityId ?? "missing"), label: "Affected item in Work", destination: "work", entityId, availability: exists },
    { id: workGuidanceTargets.orderEvidence(entityId ?? "missing"), label: "Customer message or order update", destination: "order", entityId, availability: exists },
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
    { id: "inspect", destination: "order" as const, targetId: workGuidanceTargets.orderEvidence(order.id), entityId: order.id, instruction: "Open the affected order and read its customer message or order update.", eventKind: "destination_ready", completion: "target" as const },
  ];
  const remaining = problem.resolved ? [
    { id: "return", destination: "work" as const, targetId: workGuidanceTargets.queue, entityId: order.id, instruction: "This change was already accepted. Return to Work and request a fresh batch when you are ready.", eventKind: "returned", completion: "target" as const },
  ] : [
    { id: "review", destination: "order" as const, targetId: workGuidanceTargets.reviewChange(order.id), entityId: order.id, instruction: "Use Review change to check a new proposal against the customer message or order update.", eventKind: "proposal_prepared", completion: "result" as const },
    { id: "accept", destination: "work" as const, targetId: workGuidanceTargets.proposalReview(order.id), entityId: order.id, instruction: "Check the new proposal, then accept it if the details are right.", eventKind: "proposal_accepted", completion: "bound_result" as const },
    { id: "return", destination: "work" as const, targetId: workGuidanceTargets.queue, entityId: order.id, instruction: "Return to Work. Request a fresh batch if you still need one.", eventKind: "returned", completion: "target" as const },
  ];
  return [{
    id: workGuides.staleReview,
    version: workGuideVersion,
    title: "Review an affected item",
    summary: problem.resolved ? "See the current order and return after an earlier change was accepted." : "Read the current order details and review a new change after an outdated proposal.",
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
