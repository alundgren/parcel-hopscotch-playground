import { describe, expect, it } from "vite-plus/test";
import { reviewChangeAvailability, workGuideNote } from "../../src/modules/work/index";

describe("Work guidance facts", () => {
  it("uses the current order state when an older failure disagrees", () => {
    const order = { id: "BB-1051", status: "ready" as const, version: 3, resolved: true };
    expect(reviewChangeAvailability({ connected: true, order, resolved: false })).toEqual({ available: false, reason: "This change was already accepted." });
    expect(reviewChangeAvailability({ connected: true, order: { ...order, resolved: false }, resolved: true })).toEqual({ available: true, reason: null });
    expect(reviewChangeAvailability({ connected: false, order: { ...order, resolved: false } }).available).toBe(false);
  });

  it("points the person to current evidence while they perform the action", () => {
    const order = { id: "BB-1051", status: "ready" as const, version: 2, resolved: false, businessValue: "Blue mug", issue: "Review replacement", evidence: [{ label: "Customer", value: "Sage is fine" }] };
    const text = workGuideNote({ stepId: "review", order, problem: null, availability: { available: true, reason: null } });
    expect(text).toContain("Current: Blue mug");
    expect(text).toContain("Customer: Sage is fine");
    expect(text).toContain("Use Review change");
  });
});
