import type { OrderStatus, ProposalChange, ResolutionFamily } from "../shared/contracts.js";

export interface ResolutionOrder {
  readonly id: string;
  readonly family: ResolutionFamily;
  readonly item: string;
  readonly issue: string;
  readonly status: OrderStatus;
  readonly version: number;
}
export interface InventoryCondition { readonly sku: string; readonly expectedVersion: number; readonly quantity: number }
export interface ResolutionPolicy {
  readonly change: ProposalChange;
  readonly nextStatus: OrderStatus;
  readonly nextIssue: string;
  readonly inventory: InventoryCondition | null;
}

const policyText: Record<ResolutionFamily, Omit<ResolutionPolicy, "change"> & { readonly before: string; readonly after: string; readonly effect: string }> = {
  address: { before: "14 Willow Lane, Bath BA1 2AB", after: "41 Willow Lane, Bath BA1 2AB", effect: "Replace only the street number supplied by the customer.", nextStatus: "ready", nextIssue: "Address checked against the customer message.", inventory: null },
  substitution: { before: "Blue stoneware mug, quantity 1, £24.00", after: "Sage stoneware mug, quantity 1, £24.00", effect: "Reserve 1 sage mug. The price does not change.", nextStatus: "ready", nextIssue: "Sage replacement reserved at no price change.", inventory: { sku: "MUG-SAGE", expectedVersion: 1, quantity: 1 } },
  bundle: { before: "Breakfast set with 3 of 4 side plates", after: "Breakfast set with 4 of 4 side plates", effect: "Reserve 1 replacement side plate and complete the bundle.", nextStatus: "ready", nextIssue: "Replacement side plate reserved for the complete bundle.", inventory: { sku: "SIDE-PLATE", expectedVersion: 1, quantity: 1 } },
  weight: { before: "One parcel at 15.8 kg", after: "Two parcels at 8.0 kg and 7.8 kg", effect: "Split the packed items into two parcels below the 15 kg limit.", nextStatus: "ready", nextIssue: "Two parcels fit the service weight limit.", inventory: null },
  carrier: { before: "Manifest accepted with no depot scan for 48 hours", after: "Warehouse follow-up queued for the delayed scan", effect: "Move the order to the deterministic warehouse follow-up queue.", nextStatus: "review", nextIssue: "Warehouse follow-up is queued for the delayed scan.", inventory: null },
  duplicate: { before: "BB-1095 and BB-1096 both eligible for fulfilment", after: "BB-1096 held as the later potential duplicate", effect: "Hold the later order. Payments and customer contact stay unchanged.", nextStatus: "waiting", nextIssue: "Held as the later potential duplicate of BB-1095.", inventory: null },
};

export const resolutionFor = (order: ResolutionOrder, inventoryVersion?: number): ResolutionPolicy => {
  const text = policyText[order.family];
  const calculated = (() => {
    if (order.family === "substitution") {
      const quantity = 1;
      const originalPence = 2_400;
      const replacementPence = 2_400;
      const difference = (replacementPence - originalPence) * quantity;
      return {
        before: `Blue stoneware mug, quantity ${quantity}, £${(originalPence / 100).toFixed(2)}`,
        after: `Sage stoneware mug, quantity ${quantity}, £${(replacementPence / 100).toFixed(2)}`,
        effect: `Reserve ${quantity} sage mug. ${difference === 0 ? "The price does not change." : `The price changes by £${(difference / 100).toFixed(2)}.`}`,
      };
    }
    if (order.family === "bundle") {
      const expected = 4;
      const scanned = 3;
      const missing = expected - scanned;
      return {
        before: `Breakfast set with ${scanned} of ${expected} side plates`,
        after: `Breakfast set with ${expected} of ${expected} side plates`,
        effect: `Reserve ${missing} replacement side plate and complete the bundle.`,
      };
    }
    if (order.family === "weight") {
      const total = 15.8;
      const first = Math.ceil((total / 2) * 10) / 10;
      const second = Math.round((total - first) * 10) / 10;
      return {
        before: `One parcel at ${total.toFixed(1)} kg`,
        after: `Two parcels at ${first.toFixed(1)} kg and ${second.toFixed(1)} kg`,
        effect: "Split the packed items into two parcels below the 15 kg limit.",
      };
    }
    return text;
  })();
  return {
    change: { orderId: order.id, family: order.family, before: calculated.before, after: calculated.after, effect: calculated.effect, expectedVersion: order.version },
    nextStatus: text.nextStatus,
    nextIssue: text.nextIssue,
    inventory: text.inventory === null ? null : { ...text.inventory, expectedVersion: inventoryVersion ?? text.inventory.expectedVersion },
  };
};
