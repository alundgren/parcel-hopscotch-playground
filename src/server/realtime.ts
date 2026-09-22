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
import type { AgentCoordinator } from "./agent-runtime.js";
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
  generation: number;
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
  readonly promoteGeneration: (
    userId: string,
    connectionId: string,
    generation: number,
  ) => Effect.Effect<void>;
  readonly publish: (
    userId: string,
    generation: number,
    sequence: number,
    event: string,
    payload: unknown,
  ) => Effect.Effect<void>;
  readonly publishAudit: (
    userId: string,
    payload: unknown,
  ) => Effect.Effect<void>;
  readonly publishAgent: (
    userId: string,
    generation: number,
    state: WorkspaceSnapshot,
    excludeConnectionId?: string,
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
      if (existing.size >= maximumConnectionsPerUser + 1) {
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
      if (current.size > maximumConnectionsPerUser && connection !== undefined) {
        yield* connection.close(1013, "Too many live workspace connections.");
        current.delete(connectionId);
      }
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

  const promoteGeneration: RealtimeHubService["promoteGeneration"] = (
    userId,
    connectionId,
    generation,
  ) => Effect.sync(() => {
    const connection = connections.get(userId)?.get(connectionId);
    if (connection !== undefined) connection.generation = generation;
  });

  const publishAudit: RealtimeHubService["publishAudit"] = (userId, payload) =>
    Effect.forEach(
      [...(connections.get(userId)?.values() ?? [])],
      (connection) =>
        connection.send({
          type: "audit_event",
          event: "audit.attempt.completed",
          payload,
        }),
      { concurrency: 4, discard: true },
    );

  const publishAgent: RealtimeHubService["publishAgent"] = (userId, generation, state, excludeConnectionId) =>
    Effect.forEach(
      [...(connections.get(userId)?.values() ?? [])],
      (connection) => connection.id !== excludeConnectionId && connection.generation === generation
        ? connection.send({ type: "agent_state", state })
        : Effect.void,
      { concurrency: 4, discard: true },
    );

  return RealtimeHub.of({ register, bindClient, promoteGeneration, publish, publishAudit, publishAgent });
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
  agentCoordinator: AgentCoordinator,
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
        const message = yield* Schema.decodeUnknownEffect(ClientMessage, { onExcessProperty: "error" })(
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
        if (message.value.type === "send_agent_turn") {
          const agentMessage = message.value;
          const result = yield* Effect.result(Effect.tryPromise(() => agentCoordinator.start({
            repository,
            hub,
            identity,
            generation: agentMessage.generation,
            turnId: agentMessage.turnId,
            requestId: agentMessage.requestId,
            message: agentMessage.message,
            viewContext: agentMessage.context,
            connectionId,
            send: (outgoing) => Effect.runPromise(send(outgoing)),
          })));
          if (result._tag === "Failure") {
            yield* send({ type: "error", requestId: agentMessage.requestId, code: "agent_start_failed", message: result.failure instanceof Error ? result.failure.message : "The agent turn could not start." });
          }
          return;
        }
        if (message.value.type === "cancel_agent_turn") {
          const cancelMessage = message.value;
          const cancelled = yield* Effect.promise(() => agentCoordinator.cancel(repository, identity, cancelMessage.generation, cancelMessage.turnId));
          if (!cancelled) yield* send({ type: "error", requestId: cancelMessage.requestId, code: "turn_not_active", message: "That turn is no longer active." });
          return;
        }
        if (message.value.type === "agent_ui_ack") {
          const accepted = agentCoordinator.acknowledgeUi(identity, message.value.generation, message.value.turnId, message.value.operationId, connectionId, message.value.outcome);
          if (!accepted) yield* send({ type: "error", requestId: message.value.requestId, code: "acknowledgement_expired", message: "That UI operation is no longer waiting for acknowledgement." });
          return;
        }
        if (message.value.type === "agent_complete_ack") {
          if (!agentCoordinator.acknowledgeComplete(identity, message.value.generation, message.value.turnId, connectionId)) {
            yield* send({ type: "error", requestId: message.value.requestId, code: "acknowledgement_expired", message: "That completed turn is not awaiting this browser's acknowledgement." });
            return;
          }
          const completed = yield* Effect.result(repository.completeAgentMeasurement(identity, message.value.generation, message.value.turnId, message.value.durationMs));
          if (completed._tag === "Failure") {
            yield* send({ type: "error", requestId: message.value.requestId, code: completed.failure.code, message: completed.failure.message });
            return;
          }
          const state = yield* repository.snapshot(identity).pipe(Effect.orDie);
          yield* hub.publishAgent(identity.id, message.value.generation, state);
          return;
        }
        if (message.value.type === "command_visible_ack") {
          const recorded = yield* Effect.result(repository.recordCommandMeasurement(identity, message.value.generation, message.value.receiptId, message.value.durationMs));
          if (recorded._tag === "Failure") yield* send({ type: "error", requestId: message.value.requestId, code: recorded.failure.code, message: recorded.failure.message });
          return;
        }
        if (message.value.type === "prepare_resolution") {
          const result = yield* Effect.result(repository.prepareResolution(identity, message.value.generation, message.value.orderId));
          if (result._tag === "Failure") {
            yield* send({ type: "error", requestId: message.value.requestId, code: result.failure.code, message: result.failure.message });
            return;
          }
          const state = yield* repository.snapshot(identity).pipe(Effect.orDie);
          yield* send({ type: "command_result", requestId: message.value.requestId, result: { kind: "proposal", proposal: result.success }, state });
          return;
        }
        if (message.value.type === "prepare_batch" || message.value.type === "prepare_reset" || message.value.type === "prepare_undo") {
          const action = message.value.type === "prepare_batch"
            ? repository.prepareBatch(identity, message.value.generation)
            : message.value.type === "prepare_reset"
              ? repository.prepareReset(identity, message.value.generation)
              : repository.prepareUndo(identity, message.value.generation, message.value.receiptId);
          const result = yield* Effect.result(action);
          if (result._tag === "Failure") {
            yield* send({ type: "error", requestId: message.value.requestId, code: result.failure.code, message: result.failure.message });
            return;
          }
          const state = yield* repository.snapshot(identity).pipe(Effect.orDie);
          yield* send({ type: "command_result", requestId: message.value.requestId, result: { kind: "proposal", proposal: result.success }, state });
          return;
        }
        if (message.value.type === "accept_proposal") {
          const acceptMessage = message.value;
          const result = yield* Effect.result(repository.accept(identity, acceptMessage.generation, acceptMessage.proposalId, acceptMessage.idempotencyKey));
          if (result._tag === "Failure") {
            const failure = result.failure;
            yield* send({ type: "error", requestId: acceptMessage.requestId, code: failure._tag === "WorkspaceCommandError" ? failure.code : "store_error", message: failure.message });
            return;
          }
          const commandResult = { kind: "receipt" as const, receipt: result.success.receipt };
          if (result.success.generationChanged) {
            yield* Effect.promise(() => agentCoordinator.cancelGeneration(identity, acceptMessage.generation));
            yield* hub.promoteGeneration(identity.id, connectionId, result.success.snapshot.generation);
          }
          yield* send({ type: "command_result", requestId: acceptMessage.requestId, result: commandResult, state: result.success.snapshot });
          yield* hub.publish(identity.id, result.success.snapshot.generation, result.success.snapshot.sequence, "workspace.committed", { state: result.success.snapshot, result: commandResult });
          return;
        }
        if (message.value.type === "advance_scenario") {
          const result = yield* Effect.result(repository.advanceScenario(identity, message.value.generation));
          if (result._tag === "Failure") {
            const failure = result.failure;
            yield* send({ type: "error", requestId: message.value.requestId, code: failure._tag === "WorkspaceCommandError" ? failure.code : "store_error", message: failure.message });
            return;
          }
          const commandResult = { kind: "scenario" as const, message: result.success.message };
          yield* send({ type: "command_result", requestId: message.value.requestId, result: commandResult, state: result.success.snapshot });
          yield* hub.publish(identity.id, result.success.snapshot.generation, result.success.snapshot.sequence, "workspace.committed", { state: result.success.snapshot, result: commandResult });
          return;
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
      Effect.ensuring(Effect.promise(() => agentCoordinator.disconnect(repository, identity, connectionId))),
    );
  }).pipe(Effect.catch(() => Effect.void));
