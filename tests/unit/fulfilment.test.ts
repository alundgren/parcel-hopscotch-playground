import { describe, expect, it } from "vitest";
import { calculateResolution } from "../../src/server/fulfilment";

describe("fulfilment arithmetic", () => {
  it("computes replacement quantity and total price difference", () => {
    const result = calculateResolution({
      kind: "substitution",
      originalLabel: "Blue cup",
      originalSku: "CUP-BLUE",
      replacementLabel: "Green cup",
      replacementSku: "CUP-GREEN",
      inventoryLabel: "green cups",
      quantity: 3,
      originalUnitPricePence: 1000,
      replacementUnitPricePence: 1250,
    });
    expect(result.before.summary).toBe("Blue cup, quantity 3, £10.00");
    expect(result.after.summary).toBe("Green cup, quantity 3, £12.50");
    expect(result.effect).toBe("Reserve 3 green cups. The total price increases by £7.50.");
    expect(result.inventory).toEqual({ sku: "CUP-GREEN", quantity: 3 });
  });

  it("computes the missing bundle quantity", () => {
    const result = calculateResolution({ kind: "bundle_component", bundleLabel: "Dinner set", componentSingular: "replacement plate", componentPlural: "plates", sku: "PLATE", expected: 6, scanned: 2 });
    expect(result.before.summary).toBe("Dinner set with 2 of 6 plates");
    expect(result.after.summary).toBe("Dinner set with 6 of 6 plates");
    expect(result.effect).toBe("Reserve 4 plates and complete the bundle.");
    expect(result.inventory).toEqual({ sku: "PLATE", quantity: 4 });
  });

  it("computes bounded parcel allocations that retain the total weight", () => {
    const result = calculateResolution({ kind: "parcel_split", totalKg: 31, maxParcelKg: 10 });
    const allocations = String(result.after.parcelWeightsKg).split(",").map(Number);
    expect(result.after.summary).toBe("Four parcels at 7.8 kg, 7.8 kg, 7.7 kg, 7.7 kg");
    expect(allocations.reduce((sum, value) => sum + value, 0)).toBe(31);
    expect(Math.max(...allocations)).toBeLessThanOrEqual(10);
  });

  it("holds a parcel that exceeds its booked weight", () => {
    const result = calculateResolution({ kind: "weight_confirmation", actualKg: 3.1, bookedKg: 2.5 });
    expect(result.heldReason).toBe("The 3.1 kg parcel exceeds its 2.5 kg booking.");
  });
});
