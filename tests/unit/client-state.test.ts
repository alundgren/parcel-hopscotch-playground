import { describe, expect, it } from "vitest";
import type { OrderSummary, WorkspaceSnapshot } from "../../src/shared/contracts";
import { resolveSelectedOrder } from "../../src/client/App";
import {
  decideWorkspaceEvent,
  isCurrentSocket,
} from "../../src/client/use-workspace";
import { rejectsOutgoingWrite } from "../../src/server/realtime";

const order = (issue: string): OrderSummary => ({
  id: "BB-1042",
  item: "Woven basket",
  issue,
  status: "review",
  statusLabel: "Review",
  family: "address",
  version: 1,
  targetId: "target-order-BB-1042",
  evidence: [],
});

const snapshot = (sequence: number, generation = 1): WorkspaceSnapshot => ({
  generation,
  sequence,
  orders: [order("Street number needs checking.")],
  latestReceipt: null,
});

const event = (sequence: number, generation = 1) => ({
  type: "event" as const,
  generation,
  sequence,
  event: "workspace.changed",
  payload: { orderId: "BB-1042" },
});

describe("client realtime state", () => {
  it("advances consecutive events and ignores duplicates", () => {
    const first = decideWorkspaceEvent(snapshot(0), event(1));
    expect(first).toMatchObject({ kind: "refresh", optimistic: { sequence: 1 } });
    if (first.kind !== "refresh") return;
    const second = decideWorkspaceEvent(first.optimistic, event(2));
    expect(second).toMatchObject({ kind: "refresh", optimistic: { sequence: 2 } });
    if (second.kind !== "refresh") return;
    expect(decideWorkspaceEvent(second.optimistic, event(2))).toEqual({ kind: "ignore" });
  });

  it("requests authoritative state without advancing across a gap or generation change", () => {
    expect(decideWorkspaceEvent(snapshot(2), event(4))).toMatchObject({
      kind: "refresh",
      optimistic: { generation: 1, sequence: 2 },
    });
    expect(decideWorkspaceEvent(snapshot(2), event(1, 2))).toMatchObject({
      kind: "refresh",
      optimistic: { generation: 1, sequence: 2 },
    });
  });

  it("resolves an open detail from each authoritative snapshot", () => {
    const refreshed = order("The current snapshot changed this evidence.");
    expect(resolveSelectedOrder([refreshed], "BB-1042")).toBe(refreshed);
    expect(resolveSelectedOrder([], "BB-1042")).toBeNull();
  });

  it("ignores every callback from disposed or replaced sockets", () => {
    const current = { id: "current" };
    const replaced = { id: "replaced" };
    expect(isCurrentSocket(false, current, current)).toBe(true);
    expect(isCurrentSocket(false, current, replaced)).toBe(false);
    expect(isCurrentSocket(true, current, current)).toBe(false);
    expect(isCurrentSocket(false, null, current)).toBe(false);
  });
});

describe("outgoing realtime buffer", () => {
  it("allows small writes and rejects writes beyond the checked Node buffer limit", () => {
    expect(rejectsOutgoingWrite({ bufferedBytes: 32_000, needsDrain: false }, 8_000)).toBe(false);
    expect(rejectsOutgoingWrite({ bufferedBytes: 260_000, needsDrain: false }, 8_000)).toBe(true);
    expect(rejectsOutgoingWrite({ bufferedBytes: 140_000, needsDrain: true }, 8_000)).toBe(true);
  });
});
