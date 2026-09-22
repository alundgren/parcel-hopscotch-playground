import { targets } from "./targets.js";

export const tutorialIds = ["address-correction", "substitution-review", "batch-approval"] as const;
export type TutorialId = (typeof tutorialIds)[number];
export type TutorialPhase = "teaching" | "practice" | "complete";

export type TutorialProgressEvent =
  | { readonly kind: "order_selected"; readonly orderId: string }
  | { readonly kind: "ready_filter_selected" }
  | { readonly kind: "proposal_prepared"; readonly proposalKind: "resolution" | "batch"; readonly orderIds: ReadonlyArray<string> }
  | { readonly kind: "proposal_accepted"; readonly proposalKind: "resolution" | "batch"; readonly orderIds: ReadonlyArray<string> }
  | { readonly kind: "receipt_confirmed"; readonly receiptKind: "accept"; readonly orderIds: ReadonlyArray<string> };

interface TutorialStepDefinition {
  readonly phase: Exclude<TutorialPhase, "complete">;
  readonly instruction: string;
  readonly targetId: string;
  readonly matches: (event: TutorialProgressEvent) => boolean;
}

interface TutorialDefinition {
  readonly title: string;
  readonly completion: string;
  readonly steps: ReadonlyArray<TutorialStepDefinition>;
}

const exactOrders = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  actual.length === expected.length && expected.every((orderId) => actual.includes(orderId));

const individualSteps = (
  familyName: string,
  teachingOrderId: string,
  practiceOrderId: string,
): ReadonlyArray<TutorialStepDefinition> => [
  {
    phase: "teaching",
    instruction: `Open ${teachingOrderId} and compare the saved ${familyName} with the evidence.`,
    targetId: targets.orderRow(teachingOrderId),
    matches: (event) => event.kind === "order_selected" && event.orderId === teachingOrderId,
  },
  {
    phase: "teaching",
    instruction: "Read the evidence first, then review the exact proposed change.",
    targetId: targets.orderEvidence(teachingOrderId),
    matches: (event) => event.kind === "proposal_prepared" && event.proposalKind === "resolution" && exactOrders(event.orderIds, [teachingOrderId]),
  },
  {
    phase: "teaching",
    instruction: "Compare the before and after values. Accept only when the proposal matches the evidence.",
    targetId: targets.proposalReview,
    matches: (event) => event.kind === "proposal_accepted" && event.proposalKind === "resolution" && exactOrders(event.orderIds, [teachingOrderId]),
  },
  {
    phase: "teaching",
    instruction: `Check that the receipt names ${teachingOrderId}, then return to the queue.`,
    targetId: targets.receipt,
    matches: (event) => event.kind === "receipt_confirmed" && exactOrders(event.orderIds, [teachingOrderId]),
  },
  {
    phase: "practice",
    instruction: `Independent practice: complete ${practiceOrderId} from evidence to receipt.`,
    targetId: targets.orderRow(practiceOrderId),
    matches: (event) => event.kind === "order_selected" && event.orderId === practiceOrderId,
  },
  {
    phase: "practice",
    instruction: `Independent practice: complete ${practiceOrderId} from evidence to receipt.`,
    targetId: targets.orderEvidence(practiceOrderId),
    matches: (event) => event.kind === "proposal_prepared" && event.proposalKind === "resolution" && exactOrders(event.orderIds, [practiceOrderId]),
  },
  {
    phase: "practice",
    instruction: `Independent practice: complete ${practiceOrderId} from evidence to receipt.`,
    targetId: targets.proposalReview,
    matches: (event) => event.kind === "proposal_accepted" && event.proposalKind === "resolution" && exactOrders(event.orderIds, [practiceOrderId]),
  },
  {
    phase: "practice",
    instruction: `Independent practice: complete ${practiceOrderId} from evidence to receipt.`,
    targetId: targets.receipt,
    matches: (event) => event.kind === "receipt_confirmed" && exactOrders(event.orderIds, [practiceOrderId]),
  },
];

export const batchTutorialOrders = {
  teaching: ["BB-1051", "BB-1063", "BB-1090"],
  practice: ["BB-1084", "BB-1110", "BB-1112"],
} as const;

export const tutorialRequiredOrderIds: Record<TutorialId, ReadonlyArray<string>> = {
  "address-correction": ["BB-1042", "BB-1072"],
  "substitution-review": ["BB-1051", "BB-1104"],
  "batch-approval": [...batchTutorialOrders.teaching, ...batchTutorialOrders.practice],
};

const batchSteps: ReadonlyArray<TutorialStepDefinition> = [
  {
    phase: "teaching",
    instruction: "Open Ready and compare which orders passed their checks.",
    targetId: targets.readyFilter,
    matches: (event) => event.kind === "ready_filter_selected",
  },
  {
    phase: "teaching",
    instruction: "Review the first three ready orders, including every exact change and exclusion.",
    targetId: targets.batchReview,
    matches: (event) => event.kind === "proposal_prepared" && event.proposalKind === "batch" && exactOrders(event.orderIds, batchTutorialOrders.teaching),
  },
  {
    phase: "teaching",
    instruction: "Check the included changes and exclusions. Accept only this reviewed group.",
    targetId: targets.proposalReview,
    matches: (event) => event.kind === "proposal_accepted" && event.proposalKind === "batch" && exactOrders(event.orderIds, batchTutorialOrders.teaching),
  },
  {
    phase: "teaching",
    instruction: "Check the three-order receipt, then return to the queue.",
    targetId: targets.receipt,
    matches: (event) => event.kind === "receipt_confirmed" && exactOrders(event.orderIds, batchTutorialOrders.teaching),
  },
  {
    phase: "practice",
    instruction: "Independent practice: review and approve the remaining ready group.",
    targetId: targets.readyFilter,
    matches: (event) => event.kind === "ready_filter_selected",
  },
  {
    phase: "practice",
    instruction: "Independent practice: review and approve the remaining ready group.",
    targetId: targets.batchReview,
    matches: (event) => event.kind === "proposal_prepared" && event.proposalKind === "batch" && exactOrders(event.orderIds, batchTutorialOrders.practice),
  },
  {
    phase: "practice",
    instruction: "Independent practice: review and approve the remaining ready group.",
    targetId: targets.proposalReview,
    matches: (event) => event.kind === "proposal_accepted" && event.proposalKind === "batch" && exactOrders(event.orderIds, batchTutorialOrders.practice),
  },
  {
    phase: "practice",
    instruction: "Independent practice: review and approve the remaining ready group.",
    targetId: targets.receipt,
    matches: (event) => event.kind === "receipt_confirmed" && exactOrders(event.orderIds, batchTutorialOrders.practice),
  },
];

const definitions: Record<TutorialId, TutorialDefinition> = {
  "address-correction": {
    title: "Address correction",
    completion: "Practice complete. You corrected a second address from evidence to receipt.",
    steps: individualSteps("address", "BB-1042", "BB-1072"),
  },
  "substitution-review": {
    title: "Substitution review",
    completion: "Practice complete. You reviewed and accepted a second substitution.",
    steps: individualSteps("substitution", "BB-1051", "BB-1104"),
  },
  "batch-approval": {
    title: "Batch approval",
    completion: "Practice complete. You reviewed and approved a separate ready group.",
    steps: batchSteps,
  },
};

export const tutorialDefinition = (tutorialId: TutorialId) => definitions[tutorialId];

export const tutorialStepMatches = (tutorialId: TutorialId, step: number, event: TutorialProgressEvent) =>
  definitions[tutorialId].steps[step]?.matches(event) ?? false;

export const tutorialBatchOrderIds = (tutorialId: TutorialId, step: number): ReadonlyArray<string> | null => {
  if (tutorialId !== "batch-approval") return null;
  if (step >= 0 && step <= 3) return batchTutorialOrders.teaching;
  if (step >= 4 && step <= 7) return batchTutorialOrders.practice;
  return null;
};

export const tutorialPublicState = (tutorialId: TutorialId, step: number, instanceId: string): {
  readonly id: TutorialId;
  readonly instanceId: string;
  readonly title: string;
  readonly step: number;
  readonly totalSteps: number;
  readonly phase: TutorialPhase;
  readonly instruction: string;
  readonly targetId: string;
} => {
  const definition = definitions[tutorialId];
  const totalSteps = definition.steps.length;
  const boundedStep = Math.max(0, Math.min(step, totalSteps));
  const current = definition.steps[boundedStep];
  return {
    id: tutorialId,
    instanceId,
    title: definition.title,
    step: boundedStep,
    totalSteps,
    phase: current?.phase ?? "complete",
    instruction: current?.instruction ?? definition.completion,
    targetId: current?.targetId ?? targets.receipt,
  };
};
