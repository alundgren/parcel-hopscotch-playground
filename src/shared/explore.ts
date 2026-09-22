export const exploreScenarioIds = ["overview", "learn", "batch", "consent"] as const;
export type ExploreScenarioId = typeof exploreScenarioIds[number];

export interface ExploreScenario {
  readonly id: ExploreScenarioId;
  readonly title: string;
  readonly prompt: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly tools: ReadonlyArray<string>;
}

export const exploreScenarios: ReadonlyArray<ExploreScenario> = [
  {
    id: "overview",
    title: "Get your bearings",
    prompt: "What needs my attention?",
    description: "Find the ready orders and the exceptions that need a decision.",
    actionLabel: "Try in Work",
    tools: ["listOrders", "groupOrders", "navigate"],
  },
  {
    id: "learn",
    title: "Learn a task",
    prompt: "Teach me how to fix BB-1042.",
    description: "Check an address with a guided overlay, then make the correction yourself.",
    actionLabel: "Try in Work",
    tools: ["getOrder", "navigate", "highlight", "startTutorial", "prepareAddressCorrection"],
  },
  {
    id: "batch",
    title: "Make a batch decision",
    prompt: "Approve all the green ones.",
    description: "Review the included orders, exact changes and exclusions before accepting.",
    actionLabel: "Try in Work",
    tools: ["listOrders", "getOrder", "prepareBatch", "navigate"],
  },
  {
    id: "consent",
    title: "Test a judgement",
    prompt: "Check whether the customer reply on BB-1076 gives consent to a replacement.",
    description: "See how Jev handles a conditional reply and inspect the result in Audit.",
    actionLabel: "View in Audit",
    tools: ["getOrder", "checkConsent", "getAuditTrace"],
  },
];
