import type { OrderStatus, ProposalChange, ResolutionFamily } from "../shared/contracts.js";

export interface OrderBusinessState { readonly summary: string; readonly [key: string]: string | number | boolean }
export interface ResolutionFacts {
  readonly before: OrderBusinessState;
  readonly after: OrderBusinessState;
  readonly effect: string;
  readonly nextStatus: OrderStatus;
  readonly nextIssue: string;
  readonly affectedOrderId?: string;
  readonly inventory?: { readonly sku: string; readonly quantity: number };
  readonly heldReason?: string;
}
export interface ResolutionOrder { readonly id: string; readonly family: ResolutionFamily; readonly item: string; readonly issue: string; readonly status: OrderStatus; readonly version: number }
export interface InventorySnapshot { readonly sku: string; readonly quantity: number; readonly version: number }
export interface InventoryCondition { readonly sku: string; readonly expectedVersion: number; readonly quantity: number }
export interface ResolutionPolicy {
  readonly change: ProposalChange;
  readonly nextStatus: OrderStatus;
  readonly nextIssue: string;
  readonly nextState: OrderBusinessState;
  readonly inventory: InventoryCondition | null;
}
export type PolicyEvaluation = { readonly ready: true; readonly policy: ResolutionPolicy } | { readonly ready: false; readonly reason: string };

const state = (summary: string, values: Omit<OrderBusinessState, "summary"> = {}): OrderBusinessState => ({ summary, ...values });
export const resolutionFacts: Readonly<Record<string, ResolutionFacts>> = {
  "BB-1042": { before: state("14 Willow Lane, Bath BA1 2AB", { address: "14 Willow Lane, Bath BA1 2AB" }), after: state("41 Willow Lane, Bath BA1 2AB", { address: "41 Willow Lane, Bath BA1 2AB" }), effect: "Replace only the street number supplied by the customer.", nextStatus: "ready", nextIssue: "Address checked against the customer message." },
  "BB-1072": { before: state("North Sjövik", { town: "North Sjövik" }), after: state("Sjövik", { town: "Sjövik" }), effect: "Use the town name supplied in the address note.", nextStatus: "ready", nextIssue: "Town checked against the address note." },
  "BB-1102": { before: state("22 Birch Road", { address: "22 Birch Road" }), after: state("Flat 6, 22 Birch Road", { address: "Flat 6, 22 Birch Road" }), effect: "Add the flat number supplied by the customer.", nextStatus: "ready", nextIssue: "Flat number added from the customer message." },
  "BB-1114": { before: state("Bath BA1 4OF", { postcode: "BA1 4OF" }), after: state("Bath BA1 4QF", { postcode: "BA1 4QF" }), effect: "Replace only the postcode supplied by the customer.", nextStatus: "ready", nextIssue: "Postcode checked against the customer message." },
  "BB-1051": { before: state("Blue stoneware mug, quantity 1, £24.00", { sku: "MUG-BLUE", quantity: 1, unitPricePence: 2400 }), after: state("Sage stoneware mug, quantity 1, £24.00", { sku: "MUG-SAGE", quantity: 1, unitPricePence: 2400 }), effect: "Reserve 1 sage mug. The price does not change.", nextStatus: "ready", nextIssue: "Sage replacement reserved at no price change.", inventory: { sku: "MUG-SAGE", quantity: 1 } },
  "BB-1063": { before: state("Natural linen throw, not reserved", { sku: "THROW-NATURAL", quantity: 1, reserved: false }), after: state("Natural linen throw, quantity 1 reserved", { sku: "THROW-NATURAL", quantity: 1, reserved: true }), effect: "Reserve the received linen throw for this order.", nextStatus: "ready", nextIssue: "Natural linen throw reserved.", inventory: { sku: "THROW-NATURAL", quantity: 1 } },
  "BB-1076": { before: state("Blue stoneware mug", { sku: "MUG-BLUE", consent: "conditional" }), after: state("Sage stoneware mug", { sku: "MUG-SAGE", consent: "confirmed" }), effect: "Reserve a sage mug only after explicit customer agreement.", nextStatus: "review", nextIssue: "Replacement still needs explicit agreement.", heldReason: "The customer asked for a picture first, so the replacement is not agreed." },
  "BB-1104": { before: state("Clear glass carafe, quantity 1, £38.00", { sku: "CARAFE-CLEAR", quantity: 1, unitPricePence: 3800 }), after: state("Smoke glass carafe, quantity 1, £38.00", { sku: "CARAFE-SMOKE", quantity: 1, unitPricePence: 3800 }), effect: "Reserve 1 smoke glass carafe. The price does not change.", nextStatus: "ready", nextIssue: "Smoke glass replacement reserved at no price change.", inventory: { sku: "CARAFE-SMOKE", quantity: 1 } },
  "BB-1068": { before: state("Breakfast set with 3 of 4 side plates", { expected: 4, scanned: 3 }), after: state("Breakfast set with 4 of 4 side plates", { expected: 4, scanned: 4 }), effect: "Reserve 1 replacement side plate and complete the bundle.", nextStatus: "ready", nextIssue: "Replacement side plate reserved for the complete bundle.", inventory: { sku: "SIDE-PLATE", quantity: 1 } },
  "BB-1081": { before: state("Desk organiser without divider insert", { insertPresent: false }), after: state("Desk organiser with divider insert", { insertPresent: true }), effect: "Reserve the divider insert when replenishment arrives.", nextStatus: "waiting", nextIssue: "Divider insert is still in replenishment.", heldReason: "The divider insert has not reached packing." },
  "BB-1090": { before: state("Matched candle pair with gift sleeve", { pairMatched: true, sleevePresent: true }), after: state("Matched candle pair confirmed", { pairMatched: true, sleevePresent: true, confirmed: true }), effect: "Confirm the complete matched bundle.", nextStatus: "ready", nextIssue: "Matched candle pair confirmed complete." },
  "BB-1116": { before: state("Serving bowl set without small-bowl scan", { smallBowlScanned: false }), after: state("Serving bowl set with all scans", { smallBowlScanned: true }), effect: "Confirm the set after the small bowl is rescanned.", nextStatus: "review", nextIssue: "Small bowl still needs a rescan.", heldReason: "The small bowl scan is still absent." },
  "BB-1070": { before: state("One parcel at 15.8 kg", { totalKg: 15.8, parcels: 1 }), after: state("Two parcels at 8.0 kg and 7.8 kg", { totalKg: 15.8, parcels: 2 }), effect: "Split the packed items into two parcels below the 15 kg limit.", nextStatus: "ready", nextIssue: "Two parcels fit the service weight limit." },
  "BB-1084": { before: state("One parcel at 2.4 kg against a 2.5 kg booking", { actualKg: 2.4, bookedKg: 2.5 }), after: state("Booked parcel confirmed at 2.4 kg", { actualKg: 2.4, bookedKg: 2.5, confirmed: true }), effect: "Confirm the parcel against its booked weight.", nextStatus: "ready", nextIssue: "Parcel weight confirmed against the booking." },
  "BB-1107": { before: state("One parcel at 18.2 kg", { totalKg: 18.2, parcels: 1 }), after: state("Two parcels at 9.1 kg each", { totalKg: 18.2, parcels: 2 }), effect: "Split the packed items into two parcels below the 15 kg limit.", nextStatus: "ready", nextIssue: "Two parcels fit the service weight limit." },
  "BB-1118": { before: state("Rattan box 62 × 48 × 44 cm", { lengthCm: 62, widthCm: 48, heightCm: 44 }), after: state("Volumetric service selected", { serviceSelected: true }), effect: "Select a service after the volumetric weight is reviewed.", nextStatus: "review", nextIssue: "Volumetric weight still needs review.", heldReason: "The service cannot be selected until volumetric weight is reviewed." },
  "BB-1088": { before: state("No depot scan for 48 hours", { delayHours: 48, followUpQueued: false }), after: state("Warehouse follow-up queued for the delayed scan", { delayHours: 48, followUpQueued: true }), effect: "Move the order to the deterministic warehouse follow-up queue.", nextStatus: "review", nextIssue: "Warehouse follow-up is queued for the delayed scan." },
  "BB-1092": { before: state("Missed collection", { collection: "missed" }), after: state("Collection rebooked for tomorrow", { collection: "rebooked" }), effect: "Confirm the recorded rebooking for tomorrow.", nextStatus: "ready", nextIssue: "Tomorrow's collection is confirmed." },
  "BB-1110": { before: state("Carrier scan received at 08:12", { firstScan: true }), after: state("Carrier handoff confirmed", { firstScan: true, confirmed: true }), effect: "Confirm the order entered the carrier network.", nextStatus: "ready", nextIssue: "Carrier handoff confirmed from the first scan." },
  "BB-1120": { before: state("Label created without collection scan", { labelCreated: true, collected: false }), after: state("Collection confirmed", { labelCreated: true, collected: true }), effect: "Confirm collection after the first carrier scan.", nextStatus: "waiting", nextIssue: "Collection remains unconfirmed.", heldReason: "No collection scan has arrived." },
  "BB-1095": { before: state("BB-1096 eligible for fulfilment", { relatedOrderId: "BB-1096", held: false }), after: state("BB-1096 held as the later potential duplicate", { relatedOrderId: "BB-1096", held: true }), effect: "Hold the later order. Payments and customer contact stay unchanged.", nextStatus: "waiting", nextIssue: "Held as the later potential duplicate of BB-1095.", affectedOrderId: "BB-1096" },
  "BB-1096": { before: state("Potential duplicate of BB-1095", { relatedOrderId: "BB-1095", held: false }), after: state("Held as the later potential duplicate", { relatedOrderId: "BB-1095", held: true }), effect: "Hold this later order. Payments and customer contact stay unchanged.", nextStatus: "waiting", nextIssue: "Held as the later potential duplicate of BB-1095." },
  "BB-1112": { before: state("Similar order awaiting comparison", { distinctAddress: true, distinctPayment: true }), after: state("Order confirmed distinct", { distinctAddress: true, distinctPayment: true, confirmed: true }), effect: "Keep the order because both address and payment reference differ.", nextStatus: "ready", nextIssue: "Confirmed distinct from the similar order." },
  "BB-1123": { before: state("Two similar checkouts", { separatePayments: true }), after: state("Duplicate decision recorded", { decided: true }), effect: "Hold or release after the two payment references are reviewed.", nextStatus: "review", nextIssue: "Duplicate decision still needs review.", heldReason: "Separate payment references make this case ambiguous." },
};

export const evaluateResolution = (order: ResolutionOrder, facts: ResolutionFacts, affectedVersion: number, inventory: InventorySnapshot | null): PolicyEvaluation => {
  if (facts.heldReason !== undefined) return { ready: false, reason: facts.heldReason };
  if (facts.inventory !== undefined) {
    if (inventory === null || inventory.sku !== facts.inventory.sku) return { ready: false, reason: `Stock for ${facts.inventory.sku} is unavailable.` };
    if (inventory.quantity < facts.inventory.quantity) return { ready: false, reason: `${facts.inventory.sku} does not have enough stock.` };
  }
  return {
    ready: true,
    policy: {
      change: { orderId: facts.affectedOrderId ?? order.id, family: order.family, before: facts.before.summary, after: facts.after.summary, effect: facts.effect, expectedVersion: affectedVersion },
      nextStatus: facts.nextStatus,
      nextIssue: facts.nextIssue,
      nextState: facts.after,
      inventory: facts.inventory === undefined || inventory === null ? null : { sku: facts.inventory.sku, quantity: facts.inventory.quantity, expectedVersion: inventory.version },
    },
  };
};
