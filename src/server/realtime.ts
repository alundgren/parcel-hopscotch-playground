import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Context, Effect, Layer, Schema, Scope } from "effect";
import { Socket } from "effect/unstable/socket";
import {
  ClientMessage,
  type ServerMessage,
  type WorkspaceSnapshot,
} from "../shared/contracts.js";
import type { ServerConfig } from "./config.js";
import type { RequestIdentity } from "./identity.js";
import { WorkspaceRepository } from "./persistence.js";

const maximumMessageBytes = 16 * 1024;
const maximumOutgoingBufferBytes = 256 * 1024;
const maximumConnectionsPerUser = 4;
const maximumRememberedRequestIds = 128;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface OutgoingBufferState {
  readonly bufferedBytes: number;
  readonly needsDrain: boolean;
}

export const rejectsOutgoingWrite = (
  state: OutgoingBufferState,
  messageBytes: number,
): boolean =>
  messageBytes > maximumOutgoingBufferBytes ||
  state.bufferedBytes + messageBytes > maximumOutgoingBufferBytes ||
  (state.needsDrain &&
    state.bufferedBytes + messageBytes > maximumOutgoingBufferBytes / 2);

export class RealtimeLimitError extends Schema.TaggedError<RealtimeLimitError>()(
  "RealtimeLimitError",
  { message: Schema.String },
) {}

interface HubConnection {
  readonly id: string;
  readonly generation: number;
  readonly send: (message: ServerMessage) => Effect.Effect<void>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
  clientId: string | null;
}

export interface RealtimeHubService {
  readonly register: (
    userId: string,
    connection: HubConnection,
  ) => Effect.Effect<void, RealtimeLimitError, Scope.Scope>;
  readonly bindClient: (
    userId: string,
    connectionId: string,
    clientId: string,
  ) => Effect.Effect<void>;
  readonly publish: (
    userId: string,
    generation: number,
    sequence: number,
    event: string,
    payload: unknown,
  ) => Effect.Effect<void>;
}

export class RealtimeHub extends Context.Service<RealtimeHub, RealtimeHubService>()(
  "parcel-hopscotch/RealtimeHub",
) {}

export const realtimeHubLayer = Layer.sync(RealtimeHub)(() => {
  const connections = new Map<string, Map<string, HubConnection>>();

  const register: RealtimeHubService["register"] = (userId, connection) =>
    Effect.gen(function* () {
      const existing = connections.get(userId) ?? new Map<string, HubConnection>();
      if (existing.size >= maximumConnectionsPerUser) {
        return yield* new RealtimeLimitError({
          message: "Too many live workspace connections.",
        });
      }
      existing.set(connection.id, connection);
      connections.set(userId, existing);
      const scope = yield* Effect.scope;
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          const current = connections.get(userId);
          current?.delete(connection.id);
          if (current?.size === 0) connections.delete(userId);
        }),
      );
    });

  const bindClient: RealtimeHubService["bindClient"] = (
    userId,
    connectionId,
    clientId,
  ) =>
    Effect.gen(function* () {
      const current = connections.get(userId);
      if (current === undefined) return;
      for (const connection of current.values()) {
        if (connection.id !== connectionId && connection.clientId === clientId) {
          yield* connection.close(4001, "A newer connection replaced this session.");
          current.delete(connection.id);
        }
      }
      const connection = current.get(connectionId);
      if (connection !== undefined) connection.clientId = clientId;
    });

  const publish: RealtimeHubService["publish"] = (
    userId,
    generation,
    sequence,
    event,
    payload,
  ) =>
    Effect.forEach(
      [...(connections.get(userId)?.values() ?? [])],
      (connection) =>
        connection.generation === generation
          ? connection.send({ type: "event", generation, sequence, event, payload })
          : connection.close(4002, "The workspace generation changed."),
      { concurrency: 4, discard: true },
    );

  return RealtimeHub.of({ register, bindClient, publish });
});

const headerValues = (
  rawHeaders: ReadonlyArray<string>,
  name: string,
): ReadonlyArray<string> => {
  const values: Array<string> = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
};

export const validateOrigin = (
  request: IncomingMessage,
  config: ServerConfig,
): Effect.Effect<void, RealtimeLimitError> =>
  Effect.gen(function* () {
    const values = headerValues(request.rawHeaders, "origin");
    if (values.length !== 1) {
      return yield* new RealtimeLimitError({
        message: "Exactly one Origin header is required.",
      });
    }
    let received: string;
    let expected: string;
    try {
      received = new URL(values[0]!).origin;
      expected = new URL(config.publicOrigin).origin;
    } catch {
      return yield* new RealtimeLimitError({ message: "The Origin header is invalid." });
    }
    if (received !== expected) {
      return yield* new RealtimeLimitError({ message: "The Origin is not trusted." });
    }
  });

const snapshotMessage = (
  snapshot: WorkspaceSnapshot,
  requestId: string | null,
): ServerMessage => ({
  type: "snapshot",
  requestId,
  generation: snapshot.generation,
  sequence: snapshot.sequence,
  state: snapshot,
});

export const runWorkspaceSocket = (
  socket: Socket.Socket,
  identity: RequestIdentity,
  outgoingBuffer: () => OutgoingBufferState = () => ({
    bufferedBytes: 0,
    needsDrain: false,
  }),
): Effect.Effect<void, never, WorkspaceRepository | RealtimeHub | Scope.Scope> =>
  Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const hub = yield* RealtimeHub;
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const initialSnapshot = yield* repository.snapshot(identity).pipe(Effect.orDie);
    const connectionId = randomUUID();
    let outgoingClosed = false;
    const close = (code: number, reason: string) => {
      outgoingClosed = true;
      return writer.write(new Socket.CloseEvent(code, reason)).pipe(Effect.orDie);
    };
    const send = (message: ServerMessage) => {
      if (outgoingClosed) return Effect.void;
      const encoded = JSON.stringify(message);
      const messageBytes = textEncoder.encode(encoded).byteLength;
      if (rejectsOutgoingWrite(outgoingBuffer(), messageBytes)) {
        return close(1013, "The outgoing realtime buffer is full.");
      }
      return writer.write(encoded).pipe(Effect.orDie);
    };

    const registration = yield* Effect.result(
      hub.register(identity.id, {
        id: connectionId,
        generation: initialSnapshot.generation,
        send,
        close,
        clientId: null,
      }),
    );
    if (registration._tag === "Failure") {
      yield* send({
        type: "error",
        requestId: null,
        code: "connection_limit",
        message: registration.failure.message,
      });
      yield* close(1013, registration.failure.message);
      return;
    }
    yield* send(snapshotMessage(initialSnapshot, null));

    const seenRequestIds = new Set<string>();
    const remember = (requestId: string): boolean => {
      if (seenRequestIds.has(requestId)) return false;
      seenRequestIds.add(requestId);
      if (seenRequestIds.size > maximumRememberedRequestIds) {
        const first = seenRequestIds.values().next().value;
        if (first !== undefined) seenRequestIds.delete(first);
      }
      return true;
    };

    const processFrame = (frame: Uint8Array | string) =>
      Effect.gen(function* () {
        const text = typeof frame === "string" ? frame : textDecoder.decode(frame);
        if (textEncoder.encode(text).byteLength > maximumMessageBytes) {
          yield* send({
            type: "error",
            requestId: null,
            code: "message_too_large",
            message: "Realtime messages are limited to 16 KiB.",
          });
          return;
        }
        let unknownMessage: unknown;
        try {
          unknownMessage = JSON.parse(text);
        } catch {
          yield* send({
            type: "error",
            requestId: null,
            code: "invalid_json",
            message: "The realtime message is not valid JSON.",
          });
          return;
        }
        const message = yield* Schema.decodeUnknownEffect(ClientMessage)(
          unknownMessage,
        ).pipe(Effect.option);
        if (message._tag === "None") {
          yield* send({
            type: "error",
            requestId: null,
            code: "invalid_message",
            message: "The realtime message does not match the contract.",
          });
          return;
        }
        if (!remember(message.value.requestId)) {
          yield* send({
            type: "error",
            requestId: message.value.requestId,
            code: "duplicate_request",
            message: "This request ID was already handled.",
          });
          return;
        }

        if (message.value.type === "ping") {
          yield* send({ type: "pong", requestId: message.value.requestId });
          return;
        }
        if (message.value.type === "hello") {
          yield* hub.bindClient(identity.id, connectionId, message.value.clientId);
        }
        const snapshot = yield* repository.snapshot(identity).pipe(Effect.orDie);
        yield* send(snapshotMessage(snapshot, message.value.requestId));
      });

    yield* Effect.gen(function* () {
      while (true) {
        const frames = yield* reader.pull;
        for (const frame of frames) {
          yield* processFrame(frame);
        }
      }
    }).pipe(
      Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
      Effect.catch(() => Effect.void),
    );
  }).pipe(Effect.catch(() => Effect.void));
