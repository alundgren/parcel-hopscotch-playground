import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMessage, WorkspaceSnapshot } from "../shared/contracts";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "retired";

type WorkspaceEvent = Extract<ServerMessage, { readonly type: "event" }>;

export type EventDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "refresh"; readonly optimistic: WorkspaceSnapshot };

export const decideWorkspaceEvent = (
  current: WorkspaceSnapshot,
  event: WorkspaceEvent,
): EventDecision => {
  if (event.generation !== current.generation) {
    return { kind: "refresh", optimistic: current };
  }
  if (event.sequence <= current.sequence) return { kind: "ignore" };
  if (event.sequence === current.sequence + 1) {
    return {
      kind: "refresh",
      optimistic: { ...current, sequence: event.sequence },
    };
  }
  return { kind: "refresh", optimistic: current };
};

const requestId = () => crypto.randomUUID();

const getClientId = (): string => {
  const key = "parcel-hopscotch-client-id";
  const existing = sessionStorage.getItem(key);
  if (existing !== null) return existing;
  const value = crypto.randomUUID();
  sessionStorage.setItem(key, value);
  return value;
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
  stateRef.current = snapshot;

  const connect = useCallback(() => {
    if (!navigator.onLine) {
      setStatus("offline");
      return;
    }
    if (disposedRef.current || retiredRef.current) return;
    if (
      socketRef.current?.readyState === WebSocket.OPEN ||
      socketRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    setStatus(reconnectAttempt.current === 0 ? "connecting" : "reconnecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (disposedRef.current || socketRef.current !== socket) {
        socket.close(1000, "Obsolete connection");
        return;
      }
      reconnectAttempt.current = 0;
      setStatus("connected");
      const current = stateRef.current;
      socket.send(
        JSON.stringify({
          type: "hello",
          requestId: requestId(),
          clientId: getClientId(),
          knownGeneration: current?.generation ?? 0,
          knownSequence: current?.sequence ?? 0,
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "snapshot") {
        stateRef.current = message.state;
        setSnapshot(message.state);
        return;
      }
      if (message.type !== "event") return;
      const current = stateRef.current;
      if (current === null) return;
      const decision = decideWorkspaceEvent(current, message);
      if (decision.kind === "ignore") return;
      stateRef.current = decision.optimistic;
      setSnapshot(decision.optimistic);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: "request_snapshot", requestId: requestId() }),
        );
      }
    });

    socket.addEventListener("close", (event) => {
      if (disposedRef.current || socketRef.current !== socket) return;
      socketRef.current = null;
      if (event.code === 4001) {
        retiredRef.current = true;
        setStatus("retired");
        return;
      }
      if (offlineRef.current || !navigator.onLine) {
        setStatus("offline");
        return;
      }
      setStatus("reconnecting");
      const delay = Math.min(5000, 250 * 2 ** reconnectAttempt.current++);
      reconnectTimer.current = window.setTimeout(connect, delay);
    });
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    const goOffline = () => {
      offlineRef.current = true;
      setStatus("offline");
      socketRef.current?.close(1000, "Browser offline");
    };
    const goOnline = () => {
      offlineRef.current = false;
      if (retiredRef.current) return;
      reconnectAttempt.current = 1;
      connect();
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      disposedRef.current = true;
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      socketRef.current?.close(1000, "Workspace unmounted");
      socketRef.current = null;
    };
  }, [connect]);

  return { snapshot, status };
}
