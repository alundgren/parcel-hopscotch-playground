export const targets = {
  workQueue: "target-work-queue",
  readyFilter: "target-ready-filter",
  chatComposer: "target-chat-composer",
  batchReview: "target-batch-review",
  proposalReview: "target-proposal-review",
  proposalAccept: "target-proposal-accept",
  receipt: "target-receipt",
  receiptBack: "target-receipt-back",
  receiptLink: "target-receipt-link",
  tutorialCoach: "target-tutorial-coach",
  orderRow: (orderId: string) => `target-order-${orderId}`,
  orderEvidence: (orderId: string) => `target-order-${orderId}-evidence`,
} as const;

export const registeredStaticTargets = [
  targets.workQueue,
  targets.readyFilter,
  targets.chatComposer,
  targets.batchReview,
  targets.proposalReview,
  targets.proposalAccept,
  targets.receipt,
  targets.receiptBack,
  targets.receiptLink,
  targets.tutorialCoach,
] as const;

export const isRegisteredTarget = (
  targetId: string,
  orderIds: ReadonlyArray<string>,
): boolean =>
  registeredStaticTargets.some((target) => target === targetId) ||
  orderIds.some(
    (orderId) =>
      targetId === targets.orderRow(orderId) ||
      targetId === targets.orderEvidence(orderId),
  );

export type RegisteredTarget =
  | typeof targets.workQueue
  | typeof targets.readyFilter
  | typeof targets.chatComposer
  | typeof targets.batchReview
  | typeof targets.proposalReview
  | typeof targets.proposalAccept
  | typeof targets.receipt
  | typeof targets.receiptBack
  | typeof targets.receiptLink
  | typeof targets.tutorialCoach
  | ReturnType<typeof targets.orderRow>
  | ReturnType<typeof targets.orderEvidence>;
