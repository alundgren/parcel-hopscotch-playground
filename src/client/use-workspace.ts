import { useCallback, useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { ServerMessageSchema, WorkspaceSnapshot as WorkspaceSnapshotSchema, type AgentUiOperation, type AgentViewContext, type AuditAttemptDetail, type AuditPage, type CommandResult, type ServerMessage, type TutorialId, type WorkspaceCommand, type WorkspaceSnapshot } from "../shared/contracts";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline" | "retired";
type WorkspaceEvent = Extract<ServerMessage, { readonly type: "event" }>;
export type EventDecision = { readonly kind: "ignore" } | { readonly kind: "refresh"; readonly optimistic: WorkspaceSnapshot };

export const decideWorkspaceEvent = (current: WorkspaceSnapshot, event: WorkspaceEvent): EventDecision => {
  if (event.generation !== current.generation) return { kind: "refresh", optimistic: current };
  if (event.sequence <= current.sequence) return { kind: "ignore" };
  if (event.sequence === current.sequence + 1) return { kind: "refresh", optimistic: { ...current, sequence: event.sequence } };
  return { kind: "refresh", optimistic: current };
};
export const isCurrentSocket = <SocketValue,>(disposed: boolean, current: SocketValue | null, candidate: SocketValue): boolean => !disposed && current === candidate;
export const acceptsWorkspaceState = (current: WorkspaceSnapshot | null, incoming: WorkspaceSnapshot): boolean =>
  current === null
  || incoming.generation > current.generation
  || (incoming.generation === current.generation && incoming.sequence >= current.sequence);
export const acceptsAgentOperation = (current: WorkspaceSnapshot | null, operation: AgentUiOperation): boolean =>
  current !== null && operation.generation === current.generation;

type CommandInput =
  | { readonly type: "prepare_resolution"; readonly orderId: string }
  | { readonly type: "prepare_batch" }
  | { readonly type: "prepare_undo"; readonly receiptId: string }
  | { readonly type: "prepare_reset" }
  | { readonly type: "accept_proposal"; readonly proposalId: string; readonly idempotencyKey: string }
  | { readonly type: "advance_scenario"; readonly scenario: "stock_change" }
  | { readonly type: "stop_tutorial" }
  | { readonly type: "tutorial_action"; readonly tutorialId: TutorialId; readonly tutorialInstanceId: string; readonly expectedStep: number; readonly action: "order_selected"; readonly orderId: string }
  | { readonly type: "tutorial_action"; readonly tutorialId: TutorialId; readonly tutorialInstanceId: string; readonly expectedStep: number; readonly action: "ready_filter_selected" }
  | { readonly type: "tutorial_action"; readonly tutorialId: TutorialId; readonly tutorialInstanceId: string; readonly expectedStep: number; readonly action: "receipt_confirmed"; readonly receiptId: string };
export interface PendingCommand { readonly resolve: (result: CommandResult) => void; readonly reject: (error: Error) => void }
type CommandResultMessage = Extract<ServerMessage, { readonly type: "command_result" }>;
export const settleCommandResult = (
  current: WorkspaceSnapshot | null,
  message: CommandResultMessage,
  pending: Map<string, PendingCommand>,
  applyState: (incoming: WorkspaceSnapshot) => boolean,
): void => {
  const waiter = pending.get(message.requestId);
  pending.delete(message.requestId);
  if (current !== null && message.state.generation < current.generation) {
    waiter?.reject(new Error("The workspace was reset before this command reply arrived. Review the current work and try again."));
    return;
  }
  applyState(message.state);
  waiter?.resolve(message.result);
};
const requestId = () => crypto.randomUUID();
const getClientId = (): string => { const key = "parcel-hopscotch-client-id"; const existing = sessionStorage.getItem(key); if (existing !== null) return existing; const value = crypto.randomUUID(); sessionStorage.setItem(key, value); return value; };
const committedState = (message: WorkspaceEvent): WorkspaceSnapshot | null => {
  if (message.event !== "workspace.committed" || typeof message.payload !== "object" || message.payload === null || !("state" in message.payload)) return null;
  const state = (message.payload as { state?: unknown }).state;
  try { return Schema.decodeUnknownSync(WorkspaceSnapshotSchema, { onExcessProperty: "error" })(state); } catch { return null; }
};

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [agentOperation, setAgentOperation] = useState<AgentUiOperation | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState<AuditPage | null>(null);
  const [auditDetails, setAuditDetails] = useState<Readonly<Record<string, AuditAttemptDetail>>>({});
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditRevision, setAuditRevision] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const stateRef = useRef<WorkspaceSnapshot | null>(null);
  const disposedRef = useRef(false);
  const offlineRef = useRef(false);
  const retiredRef = useRef(false);
  const pendingRef = useRef(new Map<string, PendingCommand>());
  const turnStartedRef = useRef(new Map<string, number>());
  const auditPageRef = useRef<AuditPage | null>(null);
  const pendingAuditPagesRef = useRef(new Map<string, { readonly append: boolean }>());
  const pendingAuditDetailsRef = useRef(new Map<string, { readonly attemptId: string; readonly append: boolean }>());
  stateRef.current = snapshot;
  auditPageRef.current = auditPage;

  const rejectPending = useCallback((message: string) => {
    for (const pending of pendingRef.current.values()) pending.reject(new Error(message));
    pendingRef.current.clear();
  }, []);

  const connect = useCallback(() => {
    if (!navigator.onLine) { setStatus("offline"); return; }
    if (disposedRef.current || retiredRef.current) return;
    if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) return;
    setStatus(reconnectAttempt.current === 0 ? "connecting" : "reconnecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socketRef.current = socket;
    socket.addEventListener("open", () => {
      if (!isCurrentSocket(disposedRef.current, socketRef.current, socket)) { socket.close(1000, "Obsolete connection"); return; }
      reconnectAttempt.current = 0; setStatus("connected");
      const current = stateRef.current;
      socket.send(JSON.stringify({ type: "hello", requestId: requestId(), clientId: getClientId(), knownGeneration: current?.generation ?? 0, knownSequence: current?.sequence ?? 0 }));
    });
    socket.addEventListener("message", (event) => {
      if (!isCurrentSocket(disposedRef.current, socketRef.current, socket)) return;
      let message: ServerMessage;
      try { message = Schema.decodeUnknownSync(ServerMessageSchema, { onExcessProperty: "error" })(JSON.parse(String(event.data))) as ServerMessage; } catch { return; }
      const applyState = (incoming: WorkspaceSnapshot): boolean => {
        const current = stateRef.current;
        if (!acceptsWorkspaceState(current, incoming)) return false;
        if (current !== null && current.generation !== incoming.generation) setAgentOperation(null);
        stateRef.current = incoming;
        setSnapshot(incoming);
        return true;
      };
      if (message.type === "snapshot") {
        applyState(message.state);
        return;
      }
      if (message.type === "command_result") {
        settleCommandResult(stateRef.current, message, pendingRef.current, applyState);
        setAuditRevision((current) => current + 1);
        return;
      }
      if (message.type === "agent_state") {
        applyState(message.state);
        setAuditRevision((current) => current + 1);
        return;
      }
      if (message.type === "agent_ui_operation") {
        if (acceptsAgentOperation(stateRef.current, message.operation)) setAgentOperation(message.operation);
        return;
      }
      if (message.type === "audit_page") {
        const pending = pendingAuditPagesRef.current.get(message.requestId);
        if (pending === undefined) return;
        pendingAuditPagesRef.current.delete(message.requestId);
        const current = auditPageRef.current;
        const next = pending.append && current !== null && current.query === message.page.query
          ? { ...message.page, attempts: [...current.attempts, ...message.page.attempts.filter((attempt) => !current.attempts.some((existing) => existing.id === attempt.id))] }
          : message.page;
        auditPageRef.current = next;
        setAuditPage(next);
        setAuditLoading(false);
        setAuditError(null);
        return;
      }
      if (message.type === "audit_detail") {
        const pending = pendingAuditDetailsRef.current.get(message.requestId);
        if (pending === undefined) return;
        pendingAuditDetailsRef.current.delete(message.requestId);
        if (message.detail !== null) setAuditDetails((current) => {
          const previous = current[pending.attemptId];
          const detail = pending.append && previous !== undefined
            ? { ...message.detail!, application: [...previous.application, ...message.detail!.application.filter((record) => !previous.application.some((existing) => existing.id === record.id))] }
            : message.detail!;
          return { ...current, [pending.attemptId]: detail };
        });
        setAuditError(message.detail === null ? "That audit detail is unavailable." : null);
        return;
      }
      if (message.type === "audit_event") {
        setAuditRevision((current) => current + 1);
        return;
      }
      if (message.type === "error") {
        if (message.requestId !== null) { pendingRef.current.get(message.requestId)?.reject(new Error(message.message)); pendingRef.current.delete(message.requestId); }
        if (message.requestId !== null && pendingAuditPagesRef.current.delete(message.requestId)) { setAuditLoading(false); setAuditError(message.message); }
        if (message.requestId !== null && pendingAuditDetailsRef.current.delete(message.requestId)) setAuditError(message.message);
        if (message.code.startsWith("agent_") || message.code.includes("turn") || message.code.includes("acknowledgement")) setAgentError(message.message);
        return;
      }
      if (message.type !== "event") return;
      const pushed = committedState(message);
      if (pushed !== null) { applyState(pushed); setAuditRevision((current) => current + 1); return; }
      const current = stateRef.current;
      if (current === null) return;
      const decision = decideWorkspaceEvent(current, message);
      if (decision.kind === "ignore") return;
      stateRef.current = decision.optimistic; setSnapshot(decision.optimistic);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "request_snapshot", requestId: requestId() }));
    });
    socket.addEventListener("close", (event) => {
      if (!isCurrentSocket(disposedRef.current, socketRef.current, socket)) return;
      socketRef.current = null; rejectPending("The realtime session closed before the command completed.");
      if (event.code === 4001) { retiredRef.current = true; setStatus("retired"); return; }
      if (offlineRef.current || !navigator.onLine) { setStatus("offline"); return; }
      setStatus("reconnecting");
      const delay = Math.min(5000, 250 * 2 ** reconnectAttempt.current++);
      reconnectTimer.current = window.setTimeout(connect, delay);
    });
  }, [rejectPending]);

  const runCommand = useCallback((input: CommandInput): Promise<CommandResult> => {
    const socket = socketRef.current; const state = stateRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN || state === null || status !== "connected") return Promise.reject(new Error("Reconnect before changing this workspace."));
    const id = requestId();
    return new Promise<CommandResult>((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      const message = { ...input, requestId: id, generation: state.generation } satisfies WorkspaceCommand;
      socket.send(JSON.stringify(message));
    });
  }, [status]);

  const sendAgentMessage = useCallback((content: string, viewContext: AgentViewContext): string => {
    const socket = socketRef.current; const state = stateRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN || state === null || status !== "connected") throw new Error("Reconnect before sending a message.");
    const turnId = `turn_${crypto.randomUUID()}`;
    turnStartedRef.current.set(turnId, performance.now());
    setAgentError(null);
    socket.send(JSON.stringify({ type: "send_agent_turn", requestId: requestId(), generation: state.generation, turnId, message: content, context: viewContext }));
    return turnId;
  }, [status]);

  const cancelAgentTurn = useCallback(() => {
    const socket = socketRef.current; const state = stateRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN || state?.activeTurn === null || state === null) return;
    socket.send(JSON.stringify({ type: "cancel_agent_turn", requestId: requestId(), generation: state.generation, turnId: state.activeTurn.id }));
  }, []);

  const acknowledgeAgentOperation = useCallback((operation: AgentUiOperation, outcome: "applied" | "missing") => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "agent_ui_ack", requestId: requestId(), generation: operation.generation, turnId: operation.turnId, operationId: operation.id, outcome }));
    setAgentOperation((current) => current?.id === operation.id ? null : current);
  }, []);

  const acknowledgeAgentComplete = useCallback((turnId: string, generation: number) => {
    const socket = socketRef.current;
    const started = turnStartedRef.current.get(turnId);
    if (socket === null || socket.readyState !== WebSocket.OPEN || started === undefined) return;
    const durationMs = performance.now() - started;
    turnStartedRef.current.delete(turnId);
    socket.send(JSON.stringify({ type: "agent_complete_ack", requestId: requestId(), generation, turnId, durationMs }));
  }, []);

  const acknowledgeCommandVisible = useCallback((receiptId: string, generation: number, durationMs: number) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "command_visible_ack", requestId: requestId(), generation, receiptId, durationMs }));
  }, []);

  const requestAudit = useCallback((query: string, cursor: string | null = null, append = false) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) { setAuditError("Reconnect to load Audit."); return; }
    const id = requestId();
    pendingAuditPagesRef.current.set(id, { append });
    setAuditLoading(true);
    setAuditError(null);
    socket.send(JSON.stringify({ type: "request_audit", requestId: id, query, cursor }));
  }, []);

  const requestAuditDetail = useCallback((attemptId: string, applicationCursor: string | null = null, append = false) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) { setAuditError("Reconnect to load this request."); return; }
    const id = requestId();
    pendingAuditDetailsRef.current.set(id, { attemptId, append });
    setAuditError(null);
    socket.send(JSON.stringify({ type: "request_audit_detail", requestId: id, attemptId, applicationCursor }));
  }, []);

  useEffect(() => {
    disposedRef.current = false; connect();
    const goOffline = () => { offlineRef.current = true; setStatus("offline"); socketRef.current?.close(1000, "Browser offline"); };
    const goOnline = () => { offlineRef.current = false; if (retiredRef.current) return; reconnectAttempt.current = 1; connect(); };
    window.addEventListener("offline", goOffline); window.addEventListener("online", goOnline);
    return () => { disposedRef.current = true; window.removeEventListener("offline", goOffline); window.removeEventListener("online", goOnline); if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current); rejectPending("Workspace unmounted."); socketRef.current?.close(1000, "Workspace unmounted"); socketRef.current = null; };
  }, [connect, rejectPending]);

  return { snapshot, status, runCommand, sendAgentMessage, cancelAgentTurn, agentOperation, acknowledgeAgentOperation, acknowledgeAgentComplete, acknowledgeCommandVisible, agentError, auditPage, auditDetails, auditLoading, auditError, auditRevision, requestAudit, requestAuditDetail };
}
