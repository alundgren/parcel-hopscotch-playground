import { useMemo, useState } from "react";
import type { OrderSummary } from "../shared/contracts";
import { targets } from "../shared/targets";
import { Button } from "./components/ui/button";
import { useWorkspace, type ConnectionStatus } from "./use-workspace";

type View = "work" | "explore" | "audit";
type Filter = "all" | "ready";

function BrandIcon() {
  return (
    <span className="brand-icon" aria-hidden="true">
      <img src="/favicon.png" alt="" />
    </span>
  );
}

const connectionText: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  retired: "Session replaced",
};

export const resolveSelectedOrder = (
  orders: ReadonlyArray<OrderSummary>,
  selectedOrderId: string | null,
) =>
  selectedOrderId === null
    ? null
    : orders.find((order) => order.id === selectedOrderId) ?? null;

function OrderDetail({ order, onBack }: { order: OrderSummary; onBack: () => void }) {
  return (
    <section className="order-detail" aria-labelledby="detail-title">
      <Button variant="link" onClick={onBack} className="back-button">
        <span aria-hidden="true">←</span> Back to queue
      </Button>
      <div className="detail-heading">
        <div>
          <span className="order-id">{order.id}</span>
          <h1 id="detail-title">{order.family === "address" ? "Check address" : order.item}</h1>
        </div>
        <span className={`status status-${order.status}`}>{order.statusLabel}</span>
      </div>
      <p className="detail-summary">{order.issue}</p>
      <div className="evidence" id={targets.orderEvidence(order.id)}>
        {order.evidence.map((item) => (
          <div className="evidence-row" key={`${item.label}-${item.occurredAt}`}>
            <div>
              <span className="evidence-label">{item.label}</span>
              <span className="evidence-age">{item.age}</span>
            </div>
            <p>“{item.value}”</p>
          </div>
        ))}
      </div>
      <div className="deferred-action" role="note">
        <strong>Review only</strong>
        <p>Changes arrive with proposal acceptance in the next workspace step.</p>
      </div>
    </section>
  );
}

function WorkQueue({ orders }: { orders: ReadonlyArray<OrderSummary> }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const selectedOrder = resolveSelectedOrder(orders, selectedOrderId);
  const readyCount = orders.filter((order) => order.status === "ready").length;
  const visibleOrders = useMemo(
    () => orders.filter((order) => filter === "all" || order.status === "ready"),
    [filter, orders],
  );

  if (selectedOrder !== null) {
    return <OrderDetail order={selectedOrder} onBack={() => setSelectedOrderId(null)} />;
  }

  return (
    <section className="work-panel" aria-labelledby="work-title" id={targets.workQueue}>
      <h1 id="work-title">Decisions</h1>
      <div className="queue-toolbar">
        <div className="filters" aria-label="Filter decisions">
          <Button
            variant="quiet"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All {orders.length}
          </Button>
          <Button
            variant="quiet"
            id={targets.readyFilter}
            aria-pressed={filter === "ready"}
            onClick={() => setFilter("ready")}
          >
            Ready {readyCount}
          </Button>
        </div>
        <span className="review-status">Read-only workspace</span>
      </div>
      <ul className="order-list" data-testid="order-list">
        {visibleOrders.map((order) => (
          <li key={order.id}>
            <button
              type="button"
              id={order.targetId}
              className="order-row"
              onClick={() => setSelectedOrderId(order.id)}
            >
              <span className="order-id">{order.id}</span>
              <span className="order-copy">
                <strong>{order.item}</strong>
                <span>{order.issue}</span>
              </span>
              <span className={`status status-${order.status}`}>{order.statusLabel}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChatPanel() {
  return (
    <aside className="chat-panel" aria-label="Assistant chat">
      <div className="chat-empty">
        <p>Agent chat is not available yet.</p>
        <span>You can inspect every order from the queue.</span>
      </div>
      <form className="composer" id={targets.chatComposer} aria-describedby="chat-status">
        <label className="sr-only" htmlFor="chat-message">Message</label>
        <input
          id="chat-message"
          type="text"
          placeholder="Message..."
          disabled
        />
        <Button variant="icon" type="submit" aria-label="Send message" disabled>
          <span aria-hidden="true">↑</span>
        </Button>
      </form>
      <span className="sr-only" id="chat-status">Agent integration is not available.</span>
    </aside>
  );
}

function EmptyRoute({ title, text }: { title: string; text: string }) {
  return (
    <main className="empty-route">
      <h1>{title}</h1>
      <p>{text}</p>
    </main>
  );
}

export default function App() {
  const [view, setView] = useState<View>("work");
  const { snapshot, status } = useWorkspace();

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><BrandIcon /> <span>Bracken &amp; Beam</span></div>
        <span className={`connection connection-${status}`} data-testid="connection-status">
          <span aria-hidden="true" />{connectionText[status]}
        </span>
        <nav aria-label="Main navigation">
          {(["work", "explore", "audit"] as const).map((item) => (
            <Button
              key={item}
              variant="quiet"
              aria-current={view === item ? "page" : undefined}
              onClick={() => setView(item)}
            >
              {item[0]!.toUpperCase() + item.slice(1)}
            </Button>
          ))}
        </nav>
      </header>

      {view === "work" ? (
        <main className="work-layout">
          {snapshot === null ? (
            <section className="work-panel loading-panel" aria-live="polite">
              <h1>Decisions</h1>
              <p>{status === "offline" ? "Reconnect to load your workspace." : "Loading your workspace…"}</p>
            </section>
          ) : (
            <WorkQueue orders={snapshot.orders} />
          )}
          <ChatPanel />
        </main>
      ) : view === "explore" ? (
        <EmptyRoute title="Explore" text="Scenario guides and the tool catalogue arrive in a later step." />
      ) : (
        <EmptyRoute title="Audit" text="Inference and application activity will appear here after agent integration." />
      )}
    </div>
  );
}
