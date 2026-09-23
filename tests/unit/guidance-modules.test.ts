import { describe, expect, it } from "vite-plus/test";
import { reviewChangeAvailability, workGuideNote } from "../../src/modules/work/index";
import { createGuidanceContext, workGuidanceTargets } from "../../src/modules/guidance";
import type { WorkspaceSnapshot } from "../../src/shared/contracts";

const order = { id: "BB-1051", item: "Stoneware mug", issue: "Review replacement", status: "ready" as const, statusLabel: "Ready", family: "substitution" as const, version: 2, resolved: false, businessValue: "Blue mug", targetId: "target-order-BB-1051", evidence: [] };
const proposal = (id: string, ready: boolean): NonNullable<WorkspaceSnapshot["currentProposal"]> => ({
  id, generation: 1, kind: "resolution", title: "Review replacement", ready, createdAt: "2026-09-23T00:00:00.000Z",
  changes: [{ orderId: order.id, family: order.family, before: "Blue mug", after: "Sage mug", effect: "Reserve one mug.", expectedVersion: 2 }],
  omissions: [], effects: [],
});
const contextFor = (currentProposal: WorkspaceSnapshot["currentProposal"], visibleTargetIds: ReadonlyArray<string> = [], disabledTargetIds: ReadonlyArray<string> = []) => createGuidanceContext({
  snapshot: { generation: 1, sequence: 3, orders: [order], currentProposal },
  location: { view: "work", focus: { kind: "order", orderId: order.id } },
  problem: { kind: "stale_review", proposalId: "proposal_old", orderId: order.id, reason: "stock_changed", resolved: false },
  observedTargetIds: visibleTargetIds,
  disabledTargetIds,
});
const target = (context: ReturnType<typeof contextFor>, id: string) => context.targetEntries.find((entry) => entry.target.id === id)?.target;

describe("Work guidance facts", () => {
  it("uses the current order state when an older failure disagrees", () => {
    const order = { id: "BB-1051", status: "ready" as const, version: 3, resolved: true };
    expect(reviewChangeAvailability({ connected: true, order, resolved: false })).toEqual({ available: false, reason: "This change was already accepted." });
    expect(reviewChangeAvailability({ connected: true, order: { ...order, resolved: false }, resolved: true })).toEqual({ available: true, reason: null });
    expect(reviewChangeAvailability({ connected: false, order: { ...order, resolved: false } }).available).toBe(false);
    expect(reviewChangeAvailability({ connected: true, order: { ...order, resolved: false }, busy: true })).toEqual({ available: false, reason: "Wait for the current action to finish." });
  });

  it("points the person to current evidence while they perform the action", () => {
    const order = { id: "BB-1051", status: "ready" as const, version: 2, resolved: false, businessValue: "Blue mug", issue: "Review replacement", evidence: [{ label: "Customer", value: "Sage is fine" }] };
    const text = workGuideNote({ stepId: "review", order, problem: null, availability: { available: true, reason: null } });
    expect(text).toContain("Current: Blue mug");
    expect(text).toContain("Customer: Sage is fine");
    expect(text).toContain("Use Review change");
  });

  it("uses the current proposal readiness for its review target", () => {
    const id = workGuidanceTargets.proposalReview(order.id);
    expect(target(contextFor(null), id)?.availability).toEqual({ available: false, reason: "Prepare a fresh review first." });
    expect(target(contextFor(proposal("proposal_old", true)), id)?.availability).toEqual({ available: false, reason: "Prepare a fresh review first." });
    expect(target(contextFor(proposal("proposal_fresh", false)), id)?.availability).toEqual({ available: false, reason: "This proposal is held and cannot be accepted." });
    expect(target(contextFor(proposal("proposal_fresh", true)), id)?.availability).toEqual({ available: true, reason: null });
    expect(contextFor(proposal("proposal_fresh", false)).publicContext.contextRef).not.toBe(contextFor(proposal("proposal_fresh", true)).publicContext.contextRef);
  });

  it("uses registered disabled controls only to reduce availability", () => {
    const id = workGuidanceTargets.reviewChange(order.id);
    const ready = contextFor(proposal("proposal_fresh", true), [id]);
    const disabled = contextFor(proposal("proposal_fresh", true), [id], [id]);
    expect(target(ready, id)?.availability).toEqual({ available: true, reason: null });
    expect(target(disabled, id)?.availability).toEqual({ available: false, reason: "This action is currently disabled." });
    expect(disabled.publicContext.contextRef).not.toBe(ready.publicContext.contextRef);
    expect(contextFor(proposal("proposal_fresh", true), [], [id]).publicContext.contextRef).toBe(contextFor(proposal("proposal_fresh", true)).publicContext.contextRef);
    const heldId = workGuidanceTargets.proposalReview(order.id);
    expect(target(contextFor(proposal("proposal_fresh", false), [heldId], [heldId]), heldId)?.availability.reason).toBe("This proposal is held and cannot be accepted.");
  });
});
