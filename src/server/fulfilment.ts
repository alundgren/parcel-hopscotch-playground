import type { OrderStatus, ProposalChange, ResolutionFamily } from "../shared/contracts.js";

export interface OrderBusinessState { readonly summary: string; readonly [key: string]: string | number | boolean }
export type ResolutionCalculation =
  | { readonly kind: "substitution"; readonly originalLabel: string; readonly originalSku: string; readonly replacementLabel: string; readonly replacementSku: string; readonly inventoryLabel: string; readonly quantity: number; readonly originalUnitPricePence: number; readonly replacementUnitPricePence: number }
  | { readonly kind: "reservation"; readonly label: string; readonly sku: string; readonly quantity: number }
  | { readonly kind: "bundle_component"; readonly bundleLabel: string; readonly componentSingular: string; readonly componentPlural: string; readonly sku: string; readonly expected: number; readonly scanned: number }
  | { readonly kind: "parcel_split"; readonly totalKg: number; readonly maxParcelKg: number }
  | { readonly kind: "weight_confirmation"; readonly actualKg: number; readonly bookedKg: number };
export interface ResolutionFacts {
  readonly initialState?: OrderBusinessState;
  readonly after?: OrderBusinessState;
  readonly effect?: string;
  readonly calculation?: ResolutionCalculation;
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
export interface ResolutionMaterial { readonly before: OrderBusinessState; readonly after: OrderBusinessState; readonly effect: string; readonly inventory?: { readonly sku: string; readonly quantity: number }; readonly heldReason?: string }

const state = (summary: string, values: Omit<OrderBusinessState, "summary"> = {}): OrderBusinessState => ({ summary, ...values });
const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const countWord = (value: number, capital = false) => {
  const words = ["zero", "one", "two", "three", "four", "five", "six"];
  const word = words[value] ?? String(value);
  return capital ? word[0]!.toUpperCase() + word.slice(1) : word;
};
const weight = (tenths: number) => (tenths / 10).toFixed(1);

export const calculateResolution = (calculation: ResolutionCalculation): ResolutionMaterial => {
  if (calculation.kind === "substitution") {
    const totalDelta = (calculation.replacementUnitPricePence - calculation.originalUnitPricePence) * calculation.quantity;
    const priceEffect = totalDelta === 0
      ? "The price does not change."
      : `The total price ${totalDelta > 0 ? "increases" : "decreases"} by ${money(Math.abs(totalDelta))}.`;
    return {
      before: state(`${calculation.originalLabel}, quantity ${calculation.quantity}, ${money(calculation.originalUnitPricePence)}`, { sku: calculation.originalSku, quantity: calculation.quantity, unitPricePence: calculation.originalUnitPricePence }),
      after: state(`${calculation.replacementLabel}, quantity ${calculation.quantity}, ${money(calculation.replacementUnitPricePence)}`, { sku: calculation.replacementSku, quantity: calculation.quantity, unitPricePence: calculation.replacementUnitPricePence }),
      effect: `Reserve ${calculation.quantity} ${calculation.inventoryLabel}. ${priceEffect}`,
      inventory: { sku: calculation.replacementSku, quantity: calculation.quantity },
      ...(calculation.quantity > 0 ? {} : { heldReason: "The replacement quantity must be greater than zero." }),
    };
  }
  if (calculation.kind === "reservation") return {
    before: state(`${calculation.label}, not reserved`, { sku: calculation.sku, quantity: calculation.quantity, reserved: false }),
    after: state(`${calculation.label}, quantity ${calculation.quantity} reserved`, { sku: calculation.sku, quantity: calculation.quantity, reserved: true }),
    effect: `Reserve the received ${calculation.label.toLowerCase()} for this order.`,
    inventory: { sku: calculation.sku, quantity: calculation.quantity },
    ...(calculation.quantity > 0 ? {} : { heldReason: "The reservation quantity must be greater than zero." }),
  };
  if (calculation.kind === "bundle_component") {
    const missing = Math.max(0, calculation.expected - calculation.scanned);
    return {
      before: state(`${calculation.bundleLabel} with ${calculation.scanned} of ${calculation.expected} ${calculation.componentPlural}`, { expected: calculation.expected, scanned: calculation.scanned }),
      after: state(`${calculation.bundleLabel} with ${calculation.expected} of ${calculation.expected} ${calculation.componentPlural}`, { expected: calculation.expected, scanned: calculation.expected }),
      effect: `Reserve ${missing} ${missing === 1 ? calculation.componentSingular : calculation.componentPlural} and complete the bundle.`,
      inventory: { sku: calculation.sku, quantity: missing },
      ...(missing > 0 ? {} : { heldReason: "The bundle has no missing component to reserve." }),
    };
  }
  if (calculation.kind === "parcel_split") {
    const totalTenths = Math.round(calculation.totalKg * 10);
    const limitTenths = Math.round(calculation.maxParcelKg * 10);
    const parcelCount = Math.max(1, Math.ceil(totalTenths / limitTenths));
    const base = Math.floor(totalTenths / parcelCount);
    const remainder = totalTenths % parcelCount;
    const allocations = Array.from({ length: parcelCount }, (_, index) => base + (index < remainder ? 1 : 0));
    const allocationText = allocations.every((value) => value === allocations[0])
      ? `${weight(allocations[0]!)} kg each`
      : allocations.map((value) => `${weight(value)} kg`).join(", ");
    return {
      before: state(`One parcel at ${calculation.totalKg.toFixed(1)} kg`, { totalKg: calculation.totalKg, parcelCount: 1, maxParcelKg: calculation.maxParcelKg }),
      after: state(`${countWord(parcelCount, true)} ${parcelCount === 1 ? "parcel" : "parcels"} at ${allocationText}`, { totalKg: calculation.totalKg, parcelCount, parcelWeightsKg: allocations.map(weight).join(","), maxParcelKg: calculation.maxParcelKg }),
      effect: `Split the packed items into ${parcelCount} ${parcelCount === 1 ? "parcel" : "parcels"} at or below ${calculation.maxParcelKg} kg.`,
      ...(parcelCount > 1 ? {} : { heldReason: "The parcel already fits the service weight limit." }),
    };
  }
  const fitsBooking = calculation.actualKg <= calculation.bookedKg;
  return {
    before: state(`One parcel at ${calculation.actualKg.toFixed(1)} kg against a ${calculation.bookedKg.toFixed(1)} kg booking`, { actualKg: calculation.actualKg, bookedKg: calculation.bookedKg }),
    after: state(`Booked parcel confirmed at ${calculation.actualKg.toFixed(1)} kg`, { actualKg: calculation.actualKg, bookedKg: calculation.bookedKg, confirmed: true }),
    effect: "Confirm the parcel against its booked weight.",
    ...(fitsBooking ? {} : { heldReason: `The ${calculation.actualKg.toFixed(1)} kg parcel exceeds its ${calculation.bookedKg.toFixed(1)} kg booking.` }),
  };
};

const fixed = (before: OrderBusinessState, after: OrderBusinessState, effect: string): Pick<ResolutionFacts, "initialState" | "after" | "effect"> => ({ initialState: before, after, effect });
export const resolutionFacts: Readonly<Record<string, ResolutionFacts>> = {
  "BB-1042": { ...fixed(state("14 Willow Lane, Bath BA1 2AB", { address: "14 Willow Lane, Bath BA1 2AB" }), state("41 Willow Lane, Bath BA1 2AB", { address: "41 Willow Lane, Bath BA1 2AB" }), "Replace only the street number supplied by the customer."), nextStatus: "ready", nextIssue: "Address checked against the customer message." },
  "BB-1072": { ...fixed(state("North Sjövik", { town: "North Sjövik" }), state("Sjövik", { town: "Sjövik" }), "Use the town name supplied in the address note."), nextStatus: "ready", nextIssue: "Town checked against the address note." },
  "BB-1102": { ...fixed(state("22 Birch Road", { address: "22 Birch Road" }), state("Flat 6, 22 Birch Road", { address: "Flat 6, 22 Birch Road" }), "Add the flat number supplied by the customer."), nextStatus: "ready", nextIssue: "Flat number added from the customer message." },
  "BB-1114": { ...fixed(state("Bath BA1 4OF", { postcode: "BA1 4OF" }), state("Bath BA1 4QF", { postcode: "BA1 4QF" }), "Replace only the postcode supplied by the customer."), nextStatus: "ready", nextIssue: "Postcode checked against the customer message." },
  "BB-1051": { calculation: { kind: "substitution", originalLabel: "Blue stoneware mug", originalSku: "MUG-BLUE", replacementLabel: "Sage stoneware mug", replacementSku: "MUG-SAGE", inventoryLabel: "sage mug", quantity: 1, originalUnitPricePence: 2400, replacementUnitPricePence: 2400 }, nextStatus: "ready", nextIssue: "Sage replacement reserved at no price change." },
  "BB-1063": { calculation: { kind: "reservation", label: "Natural linen throw", sku: "THROW-NATURAL", quantity: 1 }, nextStatus: "ready", nextIssue: "Natural linen throw reserved." },
  "BB-1076": { ...fixed(state("Blue stoneware mug", { sku: "MUG-BLUE", consent: "conditional" }), state("Sage stoneware mug", { sku: "MUG-SAGE", consent: "confirmed" }), "Reserve a sage mug only after explicit customer agreement."), nextStatus: "review", nextIssue: "Replacement still needs explicit agreement.", heldReason: "The customer asked for a picture first, so the replacement is not agreed." },
  "BB-1104": { calculation: { kind: "substitution", originalLabel: "Clear glass carafe", originalSku: "CARAFE-CLEAR", replacementLabel: "Smoke glass carafe", replacementSku: "CARAFE-SMOKE", inventoryLabel: "smoke glass carafe", quantity: 1, originalUnitPricePence: 3800, replacementUnitPricePence: 3800 }, nextStatus: "ready", nextIssue: "Smoke glass replacement reserved at no price change." },
  "BB-1068": { calculation: { kind: "bundle_component", bundleLabel: "Breakfast set", componentSingular: "replacement side plate", componentPlural: "side plates", sku: "SIDE-PLATE", expected: 4, scanned: 3 }, nextStatus: "ready", nextIssue: "Replacement side plate reserved for the complete bundle." },
  "BB-1081": { ...fixed(state("Desk organiser without divider insert", { insertPresent: false }), state("Desk organiser with divider insert", { insertPresent: true }), "Reserve the divider insert when replenishment arrives."), nextStatus: "waiting", nextIssue: "Divider insert is still in replenishment.", heldReason: "The divider insert has not reached packing." },
  "BB-1090": { ...fixed(state("Matched candle pair with gift sleeve", { pairMatched: true, sleevePresent: true }), state("Matched candle pair confirmed", { pairMatched: true, sleevePresent: true, confirmed: true }), "Confirm the complete matched bundle."), nextStatus: "ready", nextIssue: "Matched candle pair confirmed complete." },
  "BB-1116": { ...fixed(state("Serving bowl set without small-bowl scan", { smallBowlScanned: false }), state("Serving bowl set with all scans", { smallBowlScanned: true }), "Confirm the set after the small bowl is rescanned."), nextStatus: "review", nextIssue: "Small bowl still needs a rescan.", heldReason: "The small bowl scan is still absent." },
  "BB-1070": { calculation: { kind: "parcel_split", totalKg: 15.8, maxParcelKg: 15 }, nextStatus: "ready", nextIssue: "Two parcels fit the service weight limit." },
  "BB-1084": { calculation: { kind: "weight_confirmation", actualKg: 2.4, bookedKg: 2.5 }, nextStatus: "ready", nextIssue: "Parcel weight confirmed against the booking." },
  "BB-1107": { calculation: { kind: "parcel_split", totalKg: 18.2, maxParcelKg: 15 }, nextStatus: "ready", nextIssue: "Two parcels fit the service weight limit." },
  "BB-1118": { ...fixed(state("Rattan box 62 × 48 × 44 cm", { lengthCm: 62, widthCm: 48, heightCm: 44 }), state("Volumetric service selected", { serviceSelected: true }), "Select a service after the volumetric weight is reviewed."), nextStatus: "review", nextIssue: "Volumetric weight still needs review.", heldReason: "The service cannot be selected until volumetric weight is reviewed." },
  "BB-1088": { ...fixed(state("No depot scan for 48 hours", { delayHours: 48, followUpQueued: false }), state("Warehouse follow-up queued for the delayed scan", { delayHours: 48, followUpQueued: true }), "Move the order to the deterministic warehouse follow-up queue."), nextStatus: "review", nextIssue: "Warehouse follow-up is queued for the delayed scan." },
  "BB-1092": { ...fixed(state("Missed collection", { collection: "missed" }), state("Collection rebooked for tomorrow", { collection: "rebooked" }), "Confirm the recorded rebooking for tomorrow."), nextStatus: "ready", nextIssue: "Tomorrow's collection is confirmed." },
  "BB-1110": { ...fixed(state("Carrier scan received at 08:12", { firstScan: true }), state("Carrier handoff confirmed", { firstScan: true, confirmed: true }), "Confirm the order entered the carrier network."), nextStatus: "ready", nextIssue: "Carrier handoff confirmed from the first scan." },
  "BB-1120": { ...fixed(state("Label created without collection scan", { labelCreated: true, collected: false }), state("Collection confirmed", { labelCreated: true, collected: true }), "Confirm collection after the first carrier scan."), nextStatus: "waiting", nextIssue: "Collection remains unconfirmed.", heldReason: "No collection scan has arrived." },
  "BB-1095": { ...fixed(state("BB-1096 eligible for fulfilment", { relatedOrderId: "BB-1096", held: false }), state("Held as the later potential duplicate", { relatedOrderId: "BB-1095", held: true }), "Hold the later order. Payments and customer contact stay unchanged."), nextStatus: "waiting", nextIssue: "Held as the later potential duplicate of BB-1095.", affectedOrderId: "BB-1096" },
  "BB-1096": { ...fixed(state("Potential duplicate of BB-1095", { relatedOrderId: "BB-1095", held: false }), state("Held as the later potential duplicate", { relatedOrderId: "BB-1095", held: true }), "Hold this later order. Payments and customer contact stay unchanged."), nextStatus: "waiting", nextIssue: "Held as the later potential duplicate of BB-1095." },
  "BB-1112": { ...fixed(state("Similar order awaiting comparison", { distinctAddress: true, distinctPayment: true }), state("Order confirmed distinct", { distinctAddress: true, distinctPayment: true, confirmed: true }), "Keep the order because both address and payment reference differ."), nextStatus: "ready", nextIssue: "Confirmed distinct from the similar order." },
  "BB-1123": { ...fixed(state("Two similar checkouts", { separatePayments: true }), state("Duplicate decision recorded", { decided: true }), "Hold or release after the two payment references are reviewed."), nextStatus: "review", nextIssue: "Duplicate decision still needs review.", heldReason: "Separate payment references make this case ambiguous." },
};

export const materializeResolution = (facts: ResolutionFacts): ResolutionMaterial => {
  if (facts.calculation !== undefined) return calculateResolution(facts.calculation);
  if (facts.initialState === undefined || facts.after === undefined || facts.effect === undefined) throw new Error("Resolution facts are incomplete.");
  return { before: facts.initialState, after: facts.after, effect: facts.effect, ...(facts.inventory === undefined ? {} : { inventory: facts.inventory }), ...(facts.heldReason === undefined ? {} : { heldReason: facts.heldReason }) };
};
export const initialStateFor = (orderId: string): OrderBusinessState => materializeResolution(resolutionFacts[orderId]!).before;
export const resolutionBlockReason = (facts: ResolutionFacts, inventory: InventorySnapshot | null): string | null => {
  const material = materializeResolution(facts);
  const heldReason = facts.heldReason ?? material.heldReason;
  if (heldReason !== undefined) return heldReason;
  if (material.inventory === undefined) return null;
  if (inventory === null || inventory.sku !== material.inventory.sku) return `Stock for ${material.inventory.sku} is unavailable.`;
  return inventory.quantity < material.inventory.quantity ? `${material.inventory.sku} does not have enough stock.` : null;
};

export const evaluateResolution = (order: ResolutionOrder, currentState: OrderBusinessState, facts: ResolutionFacts, affectedVersion: number, inventory: InventorySnapshot | null): PolicyEvaluation => {
  const material = materializeResolution(facts);
  const blocked = resolutionBlockReason(facts, inventory);
  if (blocked !== null) return { ready: false, reason: blocked };
  return {
    ready: true,
    policy: {
      change: { orderId: facts.affectedOrderId ?? order.id, family: order.family, before: currentState.summary, after: material.after.summary, effect: material.effect, expectedVersion: affectedVersion },
      nextStatus: facts.nextStatus,
      nextIssue: facts.nextIssue,
      nextState: material.after,
      inventory: material.inventory === undefined || inventory === null ? null : { sku: material.inventory.sku, quantity: material.inventory.quantity, expectedVersion: inventory.version },
    },
  };
};
