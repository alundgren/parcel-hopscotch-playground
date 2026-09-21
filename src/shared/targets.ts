export const targets = {
  workQueue: "target-work-queue",
  readyFilter: "target-ready-filter",
  chatComposer: "target-chat-composer",
  orderRow: (orderId: string) => `target-order-${orderId}`,
  orderEvidence: (orderId: string) => `target-order-${orderId}-evidence`,
} as const;

export type RegisteredTarget =
  | typeof targets.workQueue
  | typeof targets.readyFilter
  | typeof targets.chatComposer
  | ReturnType<typeof targets.orderRow>
  | ReturnType<typeof targets.orderEvidence>;
