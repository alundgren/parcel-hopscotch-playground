import type { OrderStatus } from "../shared/contracts.js";

export interface SeedOrder {
  readonly id: string;
  readonly item: string;
  readonly issue: string;
  readonly status: OrderStatus;
  readonly family: string;
  readonly evidenceLabel: string;
  readonly evidenceValue: string;
  readonly occurredAt: string;
}

export const seedOrders: ReadonlyArray<SeedOrder> = [
  { id: "BB-1042", item: "Woven basket", issue: "Street number needs checking.", status: "review", family: "address", evidenceLabel: "Customer message", evidenceValue: "The number is 41, not 14. Everything else is right.", occurredAt: "2026-09-21T07:30:00.000Z" },
  { id: "BB-1072", item: "Oak coat hooks", issue: "Town name differs from the checkout address.", status: "review", family: "address", evidenceLabel: "Address note", evidenceValue: "Please use Sjövik rather than North Sjövik.", occurredAt: "2026-09-20T13:15:00.000Z" },
  { id: "BB-1102", item: "Wool cushion", issue: "Flat number was added after checkout.", status: "review", family: "address", evidenceLabel: "Customer message", evidenceValue: "It is Flat 6, 22 Birch Road.", occurredAt: "2026-09-21T06:10:00.000Z" },
  { id: "BB-1114", item: "Beech tray", issue: "Postcode correction is awaiting review.", status: "review", family: "address", evidenceLabel: "Customer message", evidenceValue: "The correct postcode is BA1 4QF.", occurredAt: "2026-09-19T10:20:00.000Z" },
  { id: "BB-1051", item: "Stoneware mug", issue: "Blue unavailable. Sage replacement agreed.", status: "ready", family: "substitution", evidenceLabel: "Customer message", evidenceValue: "Sage is perfect, please swap it.", occurredAt: "2026-09-21T08:05:00.000Z" },
  { id: "BB-1063", item: "Linen throw", issue: "Stock received and reserved.", status: "ready", family: "substitution", evidenceLabel: "Warehouse update", evidenceValue: "One natural linen throw reserved for this order.", occurredAt: "2026-09-21T08:35:00.000Z" },
  { id: "BB-1076", item: "Stoneware mug", issue: "Replacement reply is conditional.", status: "review", family: "substitution", evidenceLabel: "Customer message", evidenceValue: "Sage might work, but can you send a picture first?", occurredAt: "2026-09-21T07:55:00.000Z" },
  { id: "BB-1104", item: "Glass carafe", issue: "Second replacement case is ready for practice.", status: "review", family: "substitution", evidenceLabel: "Customer message", evidenceValue: "The smoke glass version is fine at the same price.", occurredAt: "2026-09-20T16:45:00.000Z" },
  { id: "BB-1068", item: "Breakfast set", issue: "One side plate is missing from the bundle.", status: "review", family: "bundle", evidenceLabel: "Packing scan", evidenceValue: "Bundle scan found 3 of 4 side plates.", occurredAt: "2026-09-21T05:40:00.000Z" },
  { id: "BB-1081", item: "Desk organiser", issue: "Divider insert has not reached packing.", status: "waiting", family: "bundle", evidenceLabel: "Warehouse update", evidenceValue: "Main tray picked. Divider insert is still in replenishment.", occurredAt: "2026-09-20T11:00:00.000Z" },
  { id: "BB-1090", item: "Candle pair", issue: "Both candles are present and matched.", status: "ready", family: "bundle", evidenceLabel: "Packing scan", evidenceValue: "Pair lot codes match and the gift sleeve is present.", occurredAt: "2026-09-21T08:50:00.000Z" },
  { id: "BB-1116", item: "Serving bowl set", issue: "The smallest bowl needs a rescan.", status: "review", family: "bundle", evidenceLabel: "Packing scan", evidenceValue: "Large and medium bowls scanned. Small bowl scan is absent.", occurredAt: "2026-09-20T09:30:00.000Z" },
  { id: "BB-1070", item: "Marble lamp", issue: "Packed weight is above the parcel limit.", status: "review", family: "weight", evidenceLabel: "Scale reading", evidenceValue: "Parcel weighs 15.8 kg. Service limit is 15 kg.", occurredAt: "2026-09-21T07:10:00.000Z" },
  { id: "BB-1084", item: "Cotton bath set", issue: "Parcel weight matches the booking.", status: "ready", family: "weight", evidenceLabel: "Scale reading", evidenceValue: "Parcel weighs 2.4 kg against a 2.5 kg booking.", occurredAt: "2026-09-21T08:42:00.000Z" },
  { id: "BB-1107", item: "Cast iron bookends", issue: "Two parcels may be required.", status: "review", family: "weight", evidenceLabel: "Scale reading", evidenceValue: "Combined parcel weighs 18.2 kg.", occurredAt: "2026-09-20T14:05:00.000Z" },
  { id: "BB-1118", item: "Rattan storage box", issue: "Volumetric weight needs review.", status: "review", family: "weight", evidenceLabel: "Packing measurement", evidenceValue: "Box measures 62 × 48 × 44 cm.", occurredAt: "2026-09-19T15:50:00.000Z" },
  { id: "BB-1088", item: "Reading lamp", issue: "No carrier scan for 48 hours.", status: "waiting", family: "carrier", evidenceLabel: "Carrier update", evidenceValue: "Manifest accepted. No depot arrival scan followed.", occurredAt: "2026-09-19T08:40:00.000Z" },
  { id: "BB-1092", item: "Oak picture ledge", issue: "Collection was rebooked for tomorrow.", status: "waiting", family: "carrier", evidenceLabel: "Warehouse note", evidenceValue: "Carrier missed collection. Rebooked for tomorrow.", occurredAt: "2026-09-21T07:20:00.000Z" },
  { id: "BB-1110", item: "Woven floor mat", issue: "First carrier scan arrived.", status: "ready", family: "carrier", evidenceLabel: "Carrier update", evidenceValue: "Collected at Bath depot at 08:12.", occurredAt: "2026-09-21T08:12:00.000Z" },
  { id: "BB-1120", item: "Ceramic wall hooks", issue: "Label exists but collection is unconfirmed.", status: "waiting", family: "carrier", evidenceLabel: "Carrier update", evidenceValue: "Label created. No collection scan yet.", occurredAt: "2026-09-20T08:00:00.000Z" },
  { id: "BB-1095", item: "Terracotta planter", issue: "Possible duplicate created eight minutes later.", status: "review", family: "duplicate", evidenceLabel: "Order comparison", evidenceValue: "Same item, address and payment reference as BB-1096.", occurredAt: "2026-09-21T06:22:00.000Z" },
  { id: "BB-1096", item: "Terracotta planter", issue: "Possible duplicate of BB-1095.", status: "review", family: "duplicate", evidenceLabel: "Order comparison", evidenceValue: "Placed eight minutes after BB-1095 with matching details.", occurredAt: "2026-09-21T06:30:00.000Z" },
  { id: "BB-1112", item: "Linen napkin set", issue: "Similar order belongs to a different address.", status: "ready", family: "duplicate", evidenceLabel: "Order comparison", evidenceValue: "Payment reference differs and the delivery postcode is distinct.", occurredAt: "2026-09-21T08:28:00.000Z" },
  { id: "BB-1123", item: "Wooden peg rail", issue: "Two checkouts need a duplicate decision.", status: "review", family: "duplicate", evidenceLabel: "Order comparison", evidenceValue: "Matching basket and address, with separate payment references.", occurredAt: "2026-09-20T17:35:00.000Z" },
];
