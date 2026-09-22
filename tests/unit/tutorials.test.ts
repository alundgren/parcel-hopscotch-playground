import { describe, expect, it } from "vitest";
import { batchTutorialOrders, tutorialBatchOrderIds, tutorialPublicState, tutorialStepMatches } from "../../src/shared/tutorials";

describe("bounded tutorial definitions", () => {
  it("accepts only the expected address actions in order", () => {
    expect(tutorialStepMatches("address-correction", 0, { kind: "order_selected", orderId: "BB-1042" })).toBe(true);
    expect(tutorialStepMatches("address-correction", 0, { kind: "order_selected", orderId: "BB-1072" })).toBe(false);
    expect(tutorialStepMatches("address-correction", 1, { kind: "proposal_prepared", proposalKind: "resolution", orderIds: ["BB-1042"] })).toBe(true);
    expect(tutorialStepMatches("address-correction", 1, { kind: "proposal_accepted", proposalKind: "resolution", orderIds: ["BB-1042"] })).toBe(false);
    expect(tutorialStepMatches("address-correction", 4, { kind: "order_selected", orderId: "BB-1072" })).toBe(true);
  });

  it("keeps batch teaching and practice groups separate", () => {
    expect(tutorialBatchOrderIds("batch-approval", 1)).toEqual(batchTutorialOrders.teaching);
    expect(tutorialBatchOrderIds("batch-approval", 5)).toEqual(batchTutorialOrders.practice);
    expect(tutorialStepMatches("batch-approval", 1, { kind: "proposal_prepared", proposalKind: "batch", orderIds: [...batchTutorialOrders.practice] })).toBe(false);
    expect(tutorialStepMatches("batch-approval", 1, { kind: "proposal_prepared", proposalKind: "batch", orderIds: [...batchTutorialOrders.teaching].reverse() })).toBe(true);
  });

  it("exposes a bounded completed state", () => {
    expect(tutorialPublicState("substitution-review", 99, "tutorial-test")).toMatchObject({ instanceId: "tutorial-test", step: 8, totalSteps: 8, phase: "complete" });
  });
});
