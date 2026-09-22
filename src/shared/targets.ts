export const targets = {
  workQueue: "target-work-queue",
  readyFilter: "target-ready-filter",
  chatComposer: "target-chat-composer",
  orderRow: (orderId: string) => `target-order-${orderId}`,
  orderEvidence: (orderId: string) => `target-order-${orderId}-evidence`,
} as const;

export const registeredStaticTargets = [
  targets.workQueue,
  targets.readyFilter,
  targets.chatComposer,
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
  | ReturnType<typeof targets.orderRow>
  | ReturnType<typeof targets.orderEvidence>;
