import { describe, expect, it } from "vite-plus/test";
import type { OrderSummary, WorkspaceSnapshot } from "../../src/shared/contracts";
import { resolveSelectedOrder } from "../../src/client/App";
import {
  acceptsAgentOperation,
  acceptsWorkspaceState,
  decideWorkspaceEvent,
  isCurrentSocket,
  settleCommandResult,
  type PendingCommand,
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
  businessValue: "14 Willow Lane, Bath BA1 2AB",
  targetId: "target-order-BB-1042",
  evidence: [],
});

const snapshot = (sequence: number, generation = 1): WorkspaceSnapshot => ({
  generation,
  sequence,
  orders: [order("Street number needs checking.")],
  latestReceipt: null,
  tutorialReceipt: null,
  currentProposal: null,
  tutorialProposal: null,
  chat: [],
  activeTurn: null,
  agentMode: "unavailable",
  tutorial: null,
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

  it("rejects delayed pre-reset snapshots and UI work", () => {
    const reset = snapshot(0, 2);
    expect(acceptsWorkspaceState(reset, snapshot(4, 1))).toBe(false);
    expect(acceptsWorkspaceState(snapshot(2, 2), snapshot(1, 2))).toBe(false);
    expect(acceptsWorkspaceState(snapshot(2, 2), snapshot(2, 2))).toBe(true);
    expect(acceptsWorkspaceState(reset, snapshot(1, 2))).toBe(true);
    expect(acceptsWorkspaceState(reset, snapshot(0, 3))).toBe(true);
    expect(acceptsAgentOperation(reset, { id: "operation_old", turnId: "turn_12345678-old", generation: 1, kind: "navigate", view: "work" })).toBe(false);
    expect(acceptsAgentOperation(reset, { id: "operation_current", turnId: "turn_12345678-current", generation: 2, kind: "navigate", view: "work" })).toBe(true);
  });

  it("settles an overtaken command exactly once without applying its older snapshot", async () => {
    const current = snapshot(1, 1);
    const older = snapshot(0, 1);
    let applied = false;
    let resolutionCount = 0;
    let resolveResult: ((value: string) => void) | null = null;
    let rejectResult: ((error: Error) => void) | null = null;
    const settled = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const pending = new Map<string, PendingCommand>([["command-overtaken", {
      resolve: () => { resolutionCount += 1; resolveResult?.("resolved"); },
      reject: (error) => rejectResult?.(error),
    }]]);
    settleCommandResult(current, {
      type: "command_result",
      requestId: "command-overtaken",
      result: { kind: "scenario", message: "Advanced." },
      state: older,
    }, pending, (incoming) => { applied = acceptsWorkspaceState(current, incoming); return applied; });
    settleCommandResult(current, {
      type: "command_result",
      requestId: "command-overtaken",
      result: { kind: "scenario", message: "Advanced." },
      state: older,
    }, pending, (incoming) => { applied = acceptsWorkspaceState(current, incoming); return applied; });
    await expect(settled).resolves.toBe("resolved");
    expect(applied).toBe(false);
    expect(resolutionCount).toBe(1);
    expect(pending.size).toBe(0);
  });

  it("rejects and clears an obsolete-generation command result", async () => {
    let rejectResult: ((error: Error) => void) | null = null;
    const settled = new Promise<void>((_resolve, reject) => { rejectResult = reject; });
    const pending = new Map<string, PendingCommand>([["command-reset", {
      resolve: () => undefined,
      reject: (error) => rejectResult?.(error),
    }]]);
    settleCommandResult(snapshot(0, 2), {
      type: "command_result",
      requestId: "command-reset",
      result: { kind: "scenario", message: "Advanced." },
      state: snapshot(3, 1),
    }, pending, () => { throw new Error("Old-generation state must not be applied."); });
    await expect(settled).rejects.toThrow("workspace was reset");
    expect(pending.size).toBe(0);
  });
});

describe("outgoing realtime buffer", () => {
  it("allows small writes and rejects writes beyond the checked Node buffer limit", () => {
    expect(rejectsOutgoingWrite({ bufferedBytes: 32_000, needsDrain: false }, 8_000)).toBe(false);
    expect(rejectsOutgoingWrite({ bufferedBytes: 260_000, needsDrain: false }, 8_000)).toBe(true);
    expect(rejectsOutgoingWrite({ bufferedBytes: 140_000, needsDrain: true }, 8_000)).toBe(true);
  });
});
