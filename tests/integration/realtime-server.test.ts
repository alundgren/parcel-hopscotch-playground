import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerMessage } from "../../src/shared/contracts";

let child: ChildProcess;
let directory: string;
let databasePath: string;
let port: number;
let origin: string;
const workContext = { context: { view: "work", focus: null } } as const;

const availablePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not allocate a test port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

const waitForHealth = async () => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still opening its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Realtime test server did not start.");
};

const nextMessage = (
  socket: WebSocket,
  predicate: (message: ServerMessage) => boolean = () => true,
) =>
  new Promise<ServerMessage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for a message.")), 5000);
    const listener = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });

const waitForProviderAttempt = async (turnId: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 500");
      const row = database.prepare("SELECT id FROM provider_attempts WHERE turn_id = ? LIMIT 1").get(turnId);
      if (row !== undefined) return;
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.includes("database is locked")) throw cause;
    } finally {
      database.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the provider attempt.");
};

const connect = (
  email: string | null,
  requestOrigin = origin,
  duplicateEmail?: string,
) =>
  new Promise<{ socket: WebSocket; snapshot: ServerMessage }>((resolve, reject) => {
    const value = duplicateEmail === undefined ? email : [email, duplicateEmail];
    const headers = value === null
      ? undefined
      : { "Cf-Access-Authenticated-User-Email": value };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: requestOrigin,
      headers: headers as WebSocket.ClientOptions["headers"],
    });
    socket.once("unexpected-response", (_request, response) => {
      reject(Object.assign(new Error(`Rejected with ${response.statusCode}`), { status: response.statusCode }));
    });
    socket.once("error", reject);
    socket.once("message", (data) => {
      resolve({ socket, snapshot: JSON.parse(data.toString()) as ServerMessage });
    });
  });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "parcel-hopscotch-realtime-"));
  databasePath = join(directory, "workspace.sqlite");
  port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_ORIGIN: origin,
      DATABASE_PATH: databasePath,
      ENABLE_DEV_IDENTITY: "false",
      AGENT_PROVIDER_MODE: "scripted",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth();
});

afterAll(async () => {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
  await rm(directory, { recursive: true, force: true });
});

describe("realtime server", () => {
  it("returns authoritative personal snapshots and isolates subsequent reads", async () => {
    const first = await connect("first@example.test");
    const second = await connect("second@example.test");
    expect(first.snapshot.type).toBe("snapshot");
    expect(second.snapshot.type).toBe("snapshot");
    if (first.snapshot.type !== "snapshot" || second.snapshot.type !== "snapshot") return;
    expect(first.snapshot.state.orders).toHaveLength(24);
    expect(second.snapshot.state.orders).toHaveLength(24);

    const database = new DatabaseSync(databasePath);
    const users = database.prepare("SELECT id FROM users ORDER BY created_at").all() as Array<{ id: string }>;
    database
      .prepare("UPDATE orders SET issue = ? WHERE user_id = ? AND order_id = ?")
      .run("Private first-user evidence.", users[0]!.id, "BB-1042");
    database.close();

    const firstReply = nextMessage(first.socket, (message) => message.type === "snapshot" && message.requestId === "first-refresh");
    first.socket.send(JSON.stringify({ type: "request_snapshot", requestId: "first-refresh" }));
    const secondReply = nextMessage(second.socket, (message) => message.type === "snapshot" && message.requestId === "second-refresh");
    second.socket.send(JSON.stringify({ type: "request_snapshot", requestId: "second-refresh" }));
    const [firstSnapshot, secondSnapshot] = await Promise.all([firstReply, secondReply]);
    if (firstSnapshot.type !== "snapshot" || secondSnapshot.type !== "snapshot") return;
    expect(firstSnapshot.state.orders.find((order) => order.id === "BB-1042")?.issue).toBe("Private first-user evidence.");
    expect(secondSnapshot.state.orders.find((order) => order.id === "BB-1042")?.issue).toBe("Street number needs checking.");
    first.socket.close();
    second.socket.close();
  });

  it("rejects missing and duplicate identities and an untrusted Origin", async () => {
    await expect(connect(null)).rejects.toMatchObject({ status: 401 });
    await expect(connect("one@example.test", origin, "two@example.test")).rejects.toMatchObject({ status: 401 });
    await expect(connect("one@example.test", "https://untrusted.example.test")).rejects.toMatchObject({ status: 403 });
  });

  it("admits a replacement at the per-user connection limit and rejects an additional distinct client", async () => {
    const sockets: Array<WebSocket> = [];
    for (let index = 0; index < 4; index += 1) {
      const connected = await connect("capacity@example.test");
      sockets.push(connected.socket);
      const hello = nextMessage(connected.socket, (message) => message.type === "snapshot" && message.requestId === `capacity-${index}`);
      connected.socket.send(JSON.stringify({ type: "hello", requestId: `capacity-${index}`, clientId: `client-${index}`, knownGeneration: 1, knownSequence: 0 }));
      await hello;
    }
    const retired = new Promise<number>((resolve) => sockets[0]!.once("close", (code) => resolve(code)));
    const replacement = await connect("capacity@example.test");
    const replacementHello = nextMessage(replacement.socket, (message) => message.type === "snapshot" && message.requestId === "capacity-replacement");
    replacement.socket.send(JSON.stringify({ type: "hello", requestId: "capacity-replacement", clientId: "client-0", knownGeneration: 1, knownSequence: 0 }));
    await replacementHello;
    await expect(retired).resolves.toBe(4001);

    const distinct = await connect("capacity@example.test");
    const rejected = new Promise<number>((resolve) => distinct.socket.once("close", (code) => resolve(code)));
    distinct.socket.send(JSON.stringify({ type: "hello", requestId: "capacity-distinct", clientId: "client-4", knownGeneration: 1, knownSequence: 0 }));
    await expect(rejected).resolves.toBe(1013);
    replacement.socket.close();
    distinct.socket.close();
    sockets.slice(1).forEach((socket) => socket.close());
  });

  it("correlates requests, rejects duplicate IDs, and retires an older client socket", async () => {
    const first = await connect("session@example.test");
    const firstHello = nextMessage(first.socket, (message) => message.type === "snapshot" && message.requestId === "hello-one");
    first.socket.send(JSON.stringify({
      type: "hello",
      requestId: "hello-one",
      clientId: "browser-session",
      knownGeneration: 0,
      knownSequence: 0,
    }));
    await firstHello;

    const duplicate = nextMessage(first.socket, (message) => message.type === "error" && message.requestId === "hello-one");
    first.socket.send(JSON.stringify({ type: "ping", requestId: "hello-one" }));
    await expect(duplicate).resolves.toMatchObject({ type: "error", code: "duplicate_request" });

    const closed = new Promise<number>((resolve) => first.socket.once("close", (code) => resolve(code)));
    const second = await connect("session@example.test");
    const secondHello = nextMessage(second.socket, (message) => message.type === "snapshot" && message.requestId === "hello-two");
    second.socket.send(JSON.stringify({
      type: "hello",
      requestId: "hello-two",
      clientId: "browser-session",
      knownGeneration: 1,
      knownSequence: 0,
    }));
    await secondHello;
    await expect(closed).resolves.toBe(4001);
    second.socket.close();
  });

  it("admits only one simultaneous agent turn for an owner across two sockets", async () => {
    const first = await connect("agent-admission@example.test");
    const second = await connect("agent-admission@example.test");
    const received: Array<ServerMessage> = [];
    const record = (data: WebSocket.RawData) => { received.push(JSON.parse(data.toString()) as ServerMessage); };
    first.socket.on("message", record);
    second.socket.on("message", record);

    first.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "admission-one", generation: 1, turnId: "turn_12345678-admission-one", message: "Start a slow turn.", ...workContext }));
    second.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "admission-two", generation: 1, turnId: "turn_12345678-admission-two", message: "Start a slow turn.", ...workContext }));
    await new Promise((resolve) => setTimeout(resolve, 120));

    const database = new DatabaseSync(databasePath);
    const user = database.prepare("SELECT id FROM users WHERE identity_digest IS NOT NULL AND id IN (SELECT user_id FROM agent_turns WHERE id LIKE 'turn_12345678-admission-%')").get() as { id: string };
    const turns = database.prepare("SELECT id FROM agent_turns WHERE user_id = ? AND id LIKE 'turn_12345678-admission-%'").all(user.id) as Array<{ id: string }>;
    const attempts = database.prepare("SELECT COUNT(*) AS count FROM provider_attempts WHERE user_id = ? AND turn_id LIKE 'turn_12345678-admission-%'").get(user.id) as { count: number };
    database.close();
    expect(turns).toHaveLength(1);
    expect(Number(attempts.count)).toBe(1);
    expect(received.filter((message) => message.type === "error" && message.code === "agent_start_failed")).toHaveLength(1);

    const activeTurnId = turns[0]!.id;
    const cancelled = nextMessage(first.socket, (message) => message.type === "agent_state" && message.state.activeTurn === null);
    first.socket.send(JSON.stringify({ type: "cancel_agent_turn", requestId: "cancel-admitted", generation: 1, turnId: activeTurnId }));
    await cancelled;
    first.socket.off("message", record);
    second.socket.off("message", record);
    first.socket.close();
    second.socket.close();
  });

  it("delivers reset success to the accepting socket, retires another tab, and rejects old accepted work", async () => {
    const first = await connect("reset-tabs@example.test");
    const second = await connect("reset-tabs@example.test");

    const preparedAddress = nextMessage(first.socket, (message) => message.type === "command_result" && message.requestId === "prepare-address");
    first.socket.send(JSON.stringify({ type: "prepare_resolution", requestId: "prepare-address", generation: 1, orderId: "BB-1042" }));
    const addressResult = await preparedAddress;
    expect(addressResult.type).toBe("command_result");
    if (addressResult.type !== "command_result" || addressResult.result.kind !== "proposal") return;

    const acceptedAddress = nextMessage(first.socket, (message) => message.type === "command_result" && message.requestId === "accept-address");
    first.socket.send(JSON.stringify({ type: "accept_proposal", requestId: "accept-address", generation: 1, proposalId: addressResult.result.proposal.id, idempotencyKey: "realtime-address-key" }));
    await expect(acceptedAddress).resolves.toMatchObject({ type: "command_result", result: { kind: "receipt" }, state: { generation: 1 } });

    const preparedReset = nextMessage(first.socket, (message) => message.type === "command_result" && message.requestId === "prepare-reset");
    first.socket.send(JSON.stringify({ type: "prepare_reset", requestId: "prepare-reset", generation: 1 }));
    const resetProposal = await preparedReset;
    if (resetProposal.type !== "command_result" || resetProposal.result.kind !== "proposal") return;

    const retired = new Promise<number>((resolve) => second.socket.once("close", (code) => resolve(code)));
    const acceptedReset = nextMessage(first.socket, (message) => message.type === "command_result" && message.requestId === "accept-reset");
    first.socket.send(JSON.stringify({ type: "accept_proposal", requestId: "accept-reset", generation: 1, proposalId: resetProposal.result.proposal.id, idempotencyKey: "realtime-reset-key" }));
    await expect(acceptedReset).resolves.toMatchObject({ type: "command_result", result: { kind: "receipt", receipt: { kind: "reset", generation: 2 } }, state: { generation: 2, sequence: 1 } });
    await expect(retired).resolves.toBe(4002);

    const oldReplay = nextMessage(first.socket, (message) => message.type === "error" && message.requestId === "old-replay");
    first.socket.send(JSON.stringify({ type: "accept_proposal", requestId: "old-replay", generation: 1, proposalId: addressResult.result.proposal.id, idempotencyKey: "realtime-address-key" }));
    await expect(oldReplay).resolves.toMatchObject({ type: "error", code: "generation_changed" });

    const current = nextMessage(first.socket, (message) => message.type === "snapshot" && message.requestId === "after-reset");
    first.socket.send(JSON.stringify({ type: "request_snapshot", requestId: "after-reset" }));
    await expect(current).resolves.toMatchObject({ type: "snapshot", state: { generation: 2, orders: expect.arrayContaining([expect.objectContaining({ id: "BB-1042", version: 1 })]) } });
    first.socket.close();
  });

  it("rejects a delayed tutorial action after reconnect and accepts the current step", async () => {
    const first = await connect("tutorial-replay@example.test");
    const turnId = "turn_12345678-tutorial-replay";
    const tutorialStarted = new Promise<Extract<ServerMessage, { type: "agent_state" }>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out starting the tutorial.")), 10_000);
      let completionSent = false;
      const listener = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as ServerMessage;
        if (message.type === "error") {
          clearTimeout(timeout);
          first.socket.off("message", listener);
          reject(new Error(`${message.code}: ${message.message}`));
          return;
        }
        if (message.type !== "agent_state") return;
        if (message.state.activeTurn?.phase === "Rendering answer" && message.state.tutorial !== null && !completionSent) {
          completionSent = true;
          first.socket.send(JSON.stringify({ type: "agent_complete_ack", requestId: "tutorial-start-complete", generation: 1, turnId, durationMs: 1 }));
          return;
        }
        if (completionSent && message.state.activeTurn === null && message.state.tutorial !== null) {
          clearTimeout(timeout);
          first.socket.off("message", listener);
          resolve(message);
        }
      };
      first.socket.on("message", listener);
    });
    first.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "tutorial-start", generation: 1, turnId, message: "Teach me the batch approval tutorial.", ...workContext }));
    const startedState = (await tutorialStarted).state;
    const started = startedState.tutorial!;

    const ready = nextMessage(first.socket, (message) => message.type === "command_result" && message.requestId === "tutorial-ready-one");
    first.socket.send(JSON.stringify({ type: "tutorial_action", requestId: "tutorial-ready-one", generation: 1, tutorialId: started.id, tutorialInstanceId: started.instanceId, expectedStep: 0, action: "ready_filter_selected" }));
    await expect(ready).resolves.toMatchObject({ type: "command_result", state: { tutorial: { step: 1 } } });

    const prepared = nextMessage(first.socket, (message) => message.type === "command_result" && message.requestId === "tutorial-prepare");
    first.socket.send(JSON.stringify({ type: "prepare_batch", requestId: "tutorial-prepare", generation: 1 }));
    const preparedResult = await prepared;
    if (preparedResult.type !== "command_result" || preparedResult.result.kind !== "proposal") throw new Error("Tutorial batch proposal was not returned.");
    const accepted = nextMessage(first.socket, (message) => message.type === "command_result" && message.requestId === "tutorial-accept");
    first.socket.send(JSON.stringify({ type: "accept_proposal", requestId: "tutorial-accept", generation: 1, proposalId: preparedResult.result.proposal.id, idempotencyKey: "tutorial-replay-key" }));
    const acceptedResult = await accepted;
    if (acceptedResult.type !== "command_result" || acceptedResult.result.kind !== "receipt") throw new Error("Tutorial receipt was not returned.");
    expect(acceptedResult.state.tutorial?.step).toBe(3);

    const receipt = nextMessage(first.socket, (message) => message.type === "command_result" && message.requestId === "tutorial-receipt");
    first.socket.send(JSON.stringify({ type: "tutorial_action", requestId: "tutorial-receipt", generation: 1, tutorialId: started.id, tutorialInstanceId: started.instanceId, expectedStep: 3, action: "receipt_confirmed", receiptId: acceptedResult.result.receipt.id }));
    await expect(receipt).resolves.toMatchObject({ type: "command_result", state: { tutorial: { step: 4, phase: "practice" } } });

    const closed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
    first.socket.close();
    await closed;
    const replacement = await connect("tutorial-replay@example.test");
    expect(replacement.snapshot).toMatchObject({ type: "snapshot", state: { tutorial: { instanceId: started.instanceId, step: 4 } } });

    const stale = nextMessage(replacement.socket, (message) => message.type === "command_result" && message.requestId === "tutorial-stale-ready");
    replacement.socket.send(JSON.stringify({ type: "tutorial_action", requestId: "tutorial-stale-ready", generation: 1, tutorialId: started.id, tutorialInstanceId: started.instanceId, expectedStep: 0, action: "ready_filter_selected" }));
    await expect(stale).resolves.toMatchObject({ type: "command_result", result: { kind: "tutorial", message: "That action is not the current tutorial step.", advanced: false }, state: { tutorial: { step: 4 } } });

    const current = nextMessage(replacement.socket, (message) => message.type === "command_result" && message.requestId === "tutorial-current-ready");
    replacement.socket.send(JSON.stringify({ type: "tutorial_action", requestId: "tutorial-current-ready", generation: 1, tutorialId: started.id, tutorialInstanceId: started.instanceId, expectedStep: 4, action: "ready_filter_selected" }));
    await expect(current).resolves.toMatchObject({ type: "command_result", result: { kind: "tutorial", advanced: true }, state: { tutorial: { step: 5 } } });
    replacement.socket.close();
  });

  it("runs a correlated multi-tool turn, waits for UI acknowledgements, measures render completion, and deduplicates the turn ID", async () => {
    const connection = await connect("agent@example.test");
    const sibling = await connect("agent@example.test");
    const turnId = "turn_12345678-agent-test";
    const operations: Array<string> = [];
    let completionSent = false;
    const completed = new Promise<Extract<ServerMessage, { type: "agent_state" }>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the agent turn.")), 10_000);
      connection.socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as ServerMessage;
        if (message.type === "error" && message.requestId !== null) {
          clearTimeout(timeout);
          reject(new Error(`${message.code}: ${message.message}`));
          return;
        }
        if (message.type === "agent_ui_operation") {
          operations.push(message.operation.kind);
          connection.socket.send(JSON.stringify({
            type: "agent_ui_ack",
            requestId: `ack-${message.operation.id}`,
            generation: message.operation.generation,
            turnId: message.operation.turnId,
            operationId: message.operation.id,
            outcome: "applied",
          }));
          return;
        }
        if (message.type !== "agent_state") return;
        if (message.state.activeTurn?.phase === "Rendering answer" && !completionSent) {
          completionSent = true;
          connection.socket.send(JSON.stringify({ type: "agent_complete_ack", requestId: "complete-agent-turn", generation: 1, turnId, durationMs: 123.5 }));
          return;
        }
        if (completionSent && message.state.activeTurn === null && message.state.chat.some((item) => item.turnId === turnId && item.role === "assistant")) {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    const siblingCompleted = nextMessage(sibling.socket, (message) => message.type === "agent_state"
      && message.state.activeTurn === null
      && message.state.chat.some((item) => item.turnId === turnId && item.role === "assistant"));
    connection.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "start-agent", generation: 1, turnId, message: "Find BB-1042, open it, and highlight the evidence.", ...workContext }));
    const finalState = await completed;
    await expect(siblingCompleted).resolves.toMatchObject({ type: "agent_state", state: { activeTurn: null } });
    expect(operations).toEqual(["navigate", "highlight"]);
    expect(finalState.state.chat.filter((item) => item.turnId === turnId).map((item) => item.role)).toEqual(["user", "assistant"]);

    const database = new DatabaseSync(databasePath);
    const before = database.prepare("SELECT COUNT(*) AS count FROM provider_attempts WHERE turn_id = ?").get(turnId) as { count: number };
    const measurement = database.prepare("SELECT status, measurement, complete_duration_ms FROM agent_turns WHERE id = ?").get(turnId) as { status: string; measurement: string; complete_duration_ms: number };
    expect(Number(before.count)).toBe(2);
    expect(measurement).toMatchObject({ status: "complete", measurement: "complete", complete_duration_ms: 123.5 });
    database.close();

    const duplicateState = nextMessage(connection.socket, (message) => message.type === "agent_state");
    connection.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "retry-agent", generation: 1, turnId, message: "Run it again.", ...workContext }));
    await duplicateState;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const verify = new DatabaseSync(databasePath);
    const after = verify.prepare("SELECT COUNT(*) AS count FROM provider_attempts WHERE turn_id = ?").get(turnId) as { count: number };
    expect(Number(after.count)).toBe(2);
    verify.close();

    const siblingTurnId = "turn_12345678-agent-sibling";
    const siblingAdmitted = nextMessage(sibling.socket, (message) => message.type === "agent_state" && message.state.activeTurn?.id === siblingTurnId);
    sibling.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "start-agent-sibling", generation: 1, turnId: siblingTurnId, message: "Start a slow turn.", ...workContext }));
    await siblingAdmitted;
    const siblingCancelled = nextMessage(sibling.socket, (message) => message.type === "agent_state" && message.state.activeTurn === null && message.state.chat.some((item) => item.turnId === siblingTurnId && item.content.startsWith("Cancelled.")));
    sibling.socket.send(JSON.stringify({ type: "cancel_agent_turn", requestId: "cancel-agent-sibling", generation: 1, turnId: siblingTurnId }));
    await siblingCancelled;

    const rejected = nextMessage(connection.socket, (message) => message.type === "error" && message.code === "invalid_message");
    connection.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "identity-injection", generation: 1, turnId: "turn_87654321", message: "Show work", ...workContext, userId: "someone-else" }));
    await expect(rejected).resolves.toMatchObject({ type: "error", requestId: null, code: "invalid_message" });
    connection.socket.close();
    sibling.socket.close();
  });

  it("cancels a running provider turn without applying a late result", async () => {
    const connection = await connect("agent-cancel@example.test");
    const turnId = "turn_12345678-cancel";
    const running = nextMessage(connection.socket, (message) => message.type === "agent_state" && message.state.activeTurn?.id === turnId);
    connection.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "start-cancel", generation: 1, turnId, message: "Start a slow turn and inspect BB-1042.", ...workContext }));
    await running;

    const operations: Array<string> = [];
    const observeOperation = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === "agent_ui_operation") operations.push(message.operation.kind);
    };
    connection.socket.on("message", observeOperation);
    const cancelled = nextMessage(connection.socket, (message) => message.type === "agent_state" && message.state.activeTurn === null && message.state.chat.some((item) => item.turnId === turnId && item.content.startsWith("Cancelled.")));
    connection.socket.send(JSON.stringify({ type: "cancel_agent_turn", requestId: "cancel-running", generation: 1, turnId }));
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 700));
    connection.socket.off("message", observeOperation);

    const current = nextMessage(connection.socket, (message) => message.type === "snapshot" && message.requestId === "after-cancel");
    connection.socket.send(JSON.stringify({ type: "request_snapshot", requestId: "after-cancel" }));
    await expect(current).resolves.toMatchObject({ type: "snapshot", state: { activeTurn: null } });
    expect(operations).toEqual([]);

    const database = new DatabaseSync(databasePath);
    const attempt = database.prepare("SELECT outcome FROM provider_attempts WHERE turn_id = ? ORDER BY started_at DESC LIMIT 1").get(turnId) as { outcome: string };
    const turn = database.prepare("SELECT status, measurement FROM agent_turns WHERE id = ?").get(turnId) as { status: string; measurement: string };
    expect(attempt.outcome).not.toBe("running");
    expect(turn).toEqual({ status: "cancelled", measurement: "incomplete" });
    database.close();
    connection.socket.close();
  });

  it("cancels a delayed direct consent attempt through the same socket", async () => {
    const connection = await connect("explore-cancel@example.test");
    const turnId = "turn_12345678-direct-cancel";
    const running = nextMessage(connection.socket, (message) => message.type === "agent_state" && message.state.activeTurn?.id === turnId);
    connection.socket.send(JSON.stringify({ type: "run_explore_scenario", requestId: "start-cancel", generation: 1, turnId, scenario: "consent" }));
    await running;
    await waitForProviderAttempt(turnId);

    const cancelled = nextMessage(connection.socket, (message) => message.type === "agent_state" && message.state.activeTurn === null && message.state.chat.some((item) => item.turnId === turnId && item.content.startsWith("Cancelled.")));
    connection.socket.send(JSON.stringify({ type: "cancel_agent_turn", requestId: "cancel-running", generation: 1, turnId }));
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 700));

    const current = nextMessage(connection.socket, (message) => message.type === "snapshot" && message.requestId === "after-cancel");
    connection.socket.send(JSON.stringify({ type: "request_snapshot", requestId: "after-cancel" }));
    await expect(current).resolves.toMatchObject({ type: "snapshot", state: { activeTurn: null } });
    const database = new DatabaseSync(databasePath);
    const attempt = database.prepare("SELECT outcome FROM provider_attempts WHERE turn_id = ? ORDER BY started_at DESC LIMIT 1").get(turnId) as { outcome: string };
    const turn = database.prepare("SELECT status, measurement FROM agent_turns WHERE id = ?").get(turnId) as { status: string; measurement: string };
    expect(attempt.outcome).not.toBe("running");
    expect(turn).toEqual({ status: "cancelled", measurement: "incomplete" });
    database.close();
    connection.socket.close();
  });

  it("cancels an old-generation provider turn on reset without restoring chat or losing its audit", async () => {
    const connection = await connect("agent-reset@example.test");
    const running = nextMessage(connection.socket, (message) => message.type === "agent_state" && message.state.activeTurn?.id === "turn_12345678-reset");
    connection.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "start-slow", generation: 1, turnId: "turn_12345678-reset", message: "Start a slow turn and inspect BB-1042.", ...workContext }));
    await running;

    const prepared = nextMessage(connection.socket, (message) => message.type === "command_result" && message.requestId === "prepare-reset-during-turn");
    connection.socket.send(JSON.stringify({ type: "prepare_reset", requestId: "prepare-reset-during-turn", generation: 1 }));
    const proposal = await prepared;
    if (proposal.type !== "command_result" || proposal.result.kind !== "proposal") throw new Error("Reset proposal was not returned.");
    const accepted = nextMessage(connection.socket, (message) => message.type === "command_result" && message.requestId === "accept-reset-during-turn");
    connection.socket.send(JSON.stringify({ type: "accept_proposal", requestId: "accept-reset-during-turn", generation: 1, proposalId: proposal.result.proposal.id, idempotencyKey: "agent-reset-key" }));
    await expect(accepted).resolves.toMatchObject({ type: "command_result", state: { generation: 2, chat: [], activeTurn: null } });

    await new Promise((resolve) => setTimeout(resolve, 750));
    const current = nextMessage(connection.socket, (message) => message.type === "snapshot" && message.requestId === "after-agent-reset");
    connection.socket.send(JSON.stringify({ type: "request_snapshot", requestId: "after-agent-reset" }));
    await expect(current).resolves.toMatchObject({ type: "snapshot", state: { generation: 2, chat: [], activeTurn: null } });

    const database = new DatabaseSync(databasePath);
    const attempt = database.prepare("SELECT generation, outcome, cost_usd FROM provider_attempts WHERE turn_id = ? ORDER BY started_at DESC LIMIT 1").get("turn_12345678-reset") as { generation: number; outcome: string; cost_usd: number | null };
    expect(attempt.generation).toBe(1);
    expect(attempt.outcome).not.toBe("running");
    expect(attempt.cost_usd).toBeNull();
    database.close();

    const stale = nextMessage(connection.socket, (message) => message.type === "error" && message.requestId === "stale-turn");
    connection.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "stale-turn", generation: 1, turnId: "turn_87654321-stale", message: "Show work", ...workContext }));
    await expect(stale).resolves.toMatchObject({ type: "error", code: "agent_start_failed" });
    connection.socket.close();
  });

  it("cancels a delayed direct consent attempt on reset without restoring chat or losing its audit", async () => {
    const connection = await connect("explore-reset@example.test");
    const directTurnId = "turn_12345678-direct-reset";
    const running = nextMessage(connection.socket, (message) => message.type === "agent_state" && message.state.activeTurn?.id === directTurnId);
    connection.socket.send(JSON.stringify({ type: "run_explore_scenario", requestId: "start-slow", generation: 1, turnId: directTurnId, scenario: "consent" }));
    await running;
    await waitForProviderAttempt(directTurnId);

    const prepared = nextMessage(connection.socket, (message) => message.type === "command_result" && message.requestId === "prepare-reset-during-turn");
    connection.socket.send(JSON.stringify({ type: "prepare_reset", requestId: "prepare-reset-during-turn", generation: 1 }));
    const proposal = await prepared;
    if (proposal.type !== "command_result" || proposal.result.kind !== "proposal") throw new Error("Reset proposal was not returned.");
    const accepted = nextMessage(connection.socket, (message) => message.type === "command_result" && message.requestId === "accept-reset-during-turn");
    connection.socket.send(JSON.stringify({ type: "accept_proposal", requestId: "accept-reset-during-turn", generation: 1, proposalId: proposal.result.proposal.id, idempotencyKey: "agent-reset-key" }));
    await expect(accepted).resolves.toMatchObject({ type: "command_result", state: { generation: 2, chat: [], activeTurn: null } });

    await new Promise((resolve) => setTimeout(resolve, 750));
    const current = nextMessage(connection.socket, (message) => message.type === "snapshot" && message.requestId === "after-agent-reset");
    connection.socket.send(JSON.stringify({ type: "request_snapshot", requestId: "after-agent-reset" }));
    await expect(current).resolves.toMatchObject({ type: "snapshot", state: { generation: 2, chat: [], activeTurn: null } });

    const database = new DatabaseSync(databasePath);
    const attempt = database.prepare("SELECT generation, outcome, cost_usd FROM provider_attempts WHERE turn_id = ? ORDER BY started_at DESC LIMIT 1").get(directTurnId) as { generation: number; outcome: string; cost_usd: number | null };
    expect(attempt.generation).toBe(1);
    expect(attempt.outcome).not.toBe("running");
    expect(attempt.cost_usd).toBeNull();
    database.close();

    const stale = nextMessage(connection.socket, (message) => message.type === "error" && message.requestId === "stale-turn");
    connection.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "stale-turn", generation: 1, turnId: "turn_87654321-stale", message: "Show work", ...workContext }));
    await expect(stale).resolves.toMatchObject({ type: "error", code: "agent_start_failed" });
    connection.socket.close();
  });

  it("recovers an in-flight turn on reconnect without starting another provider request", async () => {
    const first = await connect("agent-reconnect@example.test");
    const running = nextMessage(first.socket, (message) => message.type === "agent_state" && message.state.activeTurn?.id === "turn_12345678-reconnect");
    first.socket.send(JSON.stringify({ type: "send_agent_turn", requestId: "start-reconnect", generation: 1, turnId: "turn_12345678-reconnect", message: "Start a slow turn and inspect BB-1042.", ...workContext }));
    await running;
    const closed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
    first.socket.close();
    await closed;

    const replacement = await connect("agent-reconnect@example.test");
    expect(replacement.snapshot).toMatchObject({ type: "snapshot", state: { activeTurn: { id: "turn_12345678-reconnect" } } });
    const recovered = nextMessage(replacement.socket, (message) => message.type === "agent_state" && message.state.activeTurn === null && message.state.chat.some((item) => item.turnId === "turn_12345678-reconnect" && item.role === "assistant"));
    await expect(recovered).resolves.toMatchObject({ type: "agent_state", state: { activeTurn: null } });

    try {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        const attempts = database.prepare("SELECT COUNT(*) AS count FROM provider_attempts WHERE turn_id = ?").get("turn_12345678-reconnect") as { count: number };
        const turn = database.prepare("SELECT status, measurement FROM agent_turns WHERE id = ?").get("turn_12345678-reconnect") as { status: string; measurement: string };
        expect(Number(attempts.count)).toBe(2);
        expect(turn).toEqual({ status: "complete", measurement: "incomplete" });
      } finally {
        database.close();
      }
    } finally {
      replacement.socket.close();
    }
  });
});
