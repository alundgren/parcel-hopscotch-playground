import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandResult, ServerMessage, WorkspaceCommand, WorkspaceSnapshot } from "../shared/contracts";

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

type CommandInput =
  | { readonly type: "prepare_resolution"; readonly orderId: string }
  | { readonly type: "prepare_batch" }
  | { readonly type: "prepare_undo"; readonly receiptId: string }
  | { readonly type: "prepare_reset" }
  | { readonly type: "accept_proposal"; readonly proposalId: string; readonly idempotencyKey: string }
  | { readonly type: "advance_scenario"; readonly scenario: "stock_change" };
interface PendingCommand { readonly resolve: (result: CommandResult) => void; readonly reject: (error: Error) => void }
const requestId = () => crypto.randomUUID();
const getClientId = (): string => { const key = "parcel-hopscotch-client-id"; const existing = sessionStorage.getItem(key); if (existing !== null) return existing; const value = crypto.randomUUID(); sessionStorage.setItem(key, value); return value; };
const committedState = (message: WorkspaceEvent): WorkspaceSnapshot | null => {
  if (message.event !== "workspace.committed" || typeof message.payload !== "object" || message.payload === null || !("state" in message.payload)) return null;
  const state = (message.payload as { state?: unknown }).state;
  return typeof state === "object" && state !== null && "generation" in state && "orders" in state ? state as WorkspaceSnapshot : null;
};

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const stateRef = useRef<WorkspaceSnapshot | null>(null);
  const disposedRef = useRef(false);
  const offlineRef = useRef(false);
  const retiredRef = useRef(false);
  const pendingRef = useRef(new Map<string, PendingCommand>());
  stateRef.current = snapshot;

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
      try { message = JSON.parse(String(event.data)) as ServerMessage; } catch { return; }
      if (message.type === "snapshot" || message.type === "command_result") {
        stateRef.current = message.state; setSnapshot(message.state);
        if (message.type === "command_result") { pendingRef.current.get(message.requestId)?.resolve(message.result); pendingRef.current.delete(message.requestId); }
        return;
      }
      if (message.type === "error") {
        if (message.requestId !== null) { pendingRef.current.get(message.requestId)?.reject(new Error(message.message)); pendingRef.current.delete(message.requestId); }
        return;
      }
      if (message.type !== "event") return;
      const pushed = committedState(message);
      if (pushed !== null) { stateRef.current = pushed; setSnapshot(pushed); return; }
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

  useEffect(() => {
    disposedRef.current = false; connect();
    const goOffline = () => { offlineRef.current = true; setStatus("offline"); socketRef.current?.close(1000, "Browser offline"); };
    const goOnline = () => { offlineRef.current = false; if (retiredRef.current) return; reconnectAttempt.current = 1; connect(); };
    window.addEventListener("offline", goOffline); window.addEventListener("online", goOnline);
    return () => { disposedRef.current = true; window.removeEventListener("offline", goOffline); window.removeEventListener("online", goOnline); if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current); rejectPending("Workspace unmounted."); socketRef.current?.close(1000, "Workspace unmounted"); socketRef.current = null; };
  }, [connect, rejectPending]);

  return { snapshot, status, runCommand };
}
