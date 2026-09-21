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
});
