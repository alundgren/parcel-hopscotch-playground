import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { CommandReceipt, CommandResult, OrderSummary, ReviewedProposal, WorkspaceSnapshot } from "../shared/contracts";
import { targets } from "../shared/targets";
import { Button } from "./components/ui/button";
import { useWorkspace, type ConnectionStatus } from "./use-workspace";

type View = "work" | "explore" | "audit";
type Filter = "all" | "ready";
function BrandIcon() { return <span className="brand-icon" aria-hidden="true"><img src="/favicon.png" alt="" /></span>; }
const connectionText: Record<ConnectionStatus, string> = { connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting", offline: "Offline", retired: "Session replaced" };
export const resolveSelectedOrder = (orders: ReadonlyArray<OrderSummary>, selectedOrderId: string | null) => selectedOrderId === null ? null : orders.find((order) => order.id === selectedOrderId) ?? null;

interface ActionProps { readonly disabled: boolean; readonly run: () => void }

function OrderDetail({ order, onBack, review }: { order: OrderSummary; onBack: () => void; review: ActionProps }) {
  return <section className="order-detail" aria-labelledby="detail-title">
    <Button variant="link" onClick={onBack} className="back-button"><span aria-hidden="true">←</span> Back to queue</Button>
    <div className="detail-heading"><div><span className="order-id">{order.id}</span><h1 id="detail-title">{order.family === "address" ? "Check address" : order.item}</h1></div><span className={`status status-${order.status}`}>{order.statusLabel}</span></div>
    <p className="detail-summary">{order.issue}</p>
    <div className="detail-current"><span>Current</span><p>{order.businessValue}</p></div>
    <div className="evidence" id={targets.orderEvidence(order.id)}>{order.evidence.map((item) => <div className="evidence-row" key={`${item.label}-${item.occurredAt}`}><div><span className="evidence-label">{item.label}</span><span className="evidence-age">{item.age}</span></div><p>“{item.value}”</p></div>)}</div>
    <div className="detail-actions"><Button onClick={review.run} disabled={review.disabled}>Review change</Button></div>
  </section>;
}

function ProposalView({ proposal, orders, busy, connected, onAccept, onCancel }: { proposal: ReviewedProposal; orders: ReadonlyArray<OrderSummary>; busy: boolean; connected: boolean; onAccept: () => void; onCancel: () => void }) {
  const reset = proposal.kind === "reset";
  const addressChange = proposal.kind === "resolution" && proposal.changes.length === 1 && proposal.changes[0]?.family === "address" ? proposal.changes[0] : null;
  const addressOrder = addressChange === null ? null : orders.find((order) => order.id === addressChange.orderId) ?? null;
  const acceptLabel = !proposal.ready ? "Held" : !connected ? "Reconnect to accept" : busy ? "Working…" : reset ? "Reset my demo" : `Accept ${proposal.changes.length} ${proposal.changes.length === 1 ? "change" : "changes"}`;
  if (addressChange !== null && addressOrder !== null) return <section className="order-detail proposal-screen address-review" aria-labelledby="proposal-title">
    <div className="detail-heading"><h1 id="proposal-title" tabIndex={-1}>Check address</h1><span className="order-id">{addressOrder.id}</span></div>
    <div className="address-evidence"><div><span>Order</span><p>{addressChange.before}</p></div><div><span>Customer</span><p>“{addressOrder.evidence[0]?.value}”</p></div></div>
    <div className="address-proposal"><p><span aria-hidden="true">✧</span> <s>{addressChange.before.split(",")[0]}</s> <span aria-hidden="true">→</span> <strong>{addressChange.after}</strong></p><Button className="address-action" onClick={onAccept} disabled={busy || !connected || !proposal.ready}>{acceptLabel}</Button></div>
    <Button variant="link" onClick={onCancel} disabled={busy}>Cancel</Button>
  </section>;
  return <section className="order-detail proposal-screen" aria-labelledby="proposal-title">
    <h1 id="proposal-title" tabIndex={-1}>{proposal.title}</h1>
    <p className={`proposal-state ${proposal.ready ? "ready" : ""}`}>{proposal.ready ? "✓ Ready" : "Needs review"}</p>
    {proposal.changes.length > 0 && <div className="change-list">{proposal.changes.map((change) => <article className="change-row" key={change.orderId}><span className="order-id">{change.orderId}</span><div><strong>{change.before} <span aria-hidden="true">→</span> {change.after}</strong><p>{change.effect}</p></div></article>)}</div>}
    {reset && proposal.effects.length > 0 && <ul className="effect-list">{proposal.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>}
    {proposal.omissions.length > 0 && <div className="omissions" aria-label="Orders left out">{proposal.omissions.map((item) => <p key={item.orderId}><span className="order-id">{item.orderId}</span> excluded · {item.reason}</p>)}</div>}
    <div className="proposal-actions"><Button className={reset ? "danger-action" : proposal.kind === "batch" ? "batch-action" : "accept-action"} onClick={onAccept} disabled={busy || !connected || !proposal.ready}>{acceptLabel}</Button><Button variant="quiet" onClick={onCancel} disabled={busy}>Cancel</Button></div>
  </section>;
}

function ReceiptView({ receipt, busy, connected, onBack, onUndo }: { receipt: CommandReceipt; busy: boolean; connected: boolean; onBack: () => void; onUndo: () => void }) {
  return <section className="order-detail receipt-screen" aria-labelledby="receipt-title">
    <h1 id="receipt-title" tabIndex={-1}>{receipt.title}</h1>
    <p className="receipt-state">✓ {receipt.kind === "reset" ? "Fresh workspace ready" : receipt.kind === "undo" ? "Undone by you" : "Accepted by you"}</p>
    {receipt.changes.length > 0 && <div className="receipt-list">{receipt.changes.map((change) => <div className="receipt-row" key={change.orderId}><span className="order-id">{change.orderId}</span><span>{change.after}</span></div>)}</div>}
    <div className="proposal-actions"><Button className="accept-action" onClick={onBack}>Back to work</Button>{receipt.undoable && <Button variant="quiet" onClick={onUndo} disabled={busy || !connected}>{!connected ? "Reconnect to undo" : busy ? "Checking…" : "Undo"}</Button>}</div>
  </section>;
}

function WorkQueue({ orders, latestReceipt, connected, selectedOrderId, setSelectedOrderId, prepare, prepareBatch, prepareReset, advance, openReceipt }: { orders: ReadonlyArray<OrderSummary>; latestReceipt: CommandReceipt | null; connected: boolean; selectedOrderId: string | null; setSelectedOrderId: (id: string | null) => void; prepare: (id: string) => void; prepareBatch: () => void; prepareReset: () => void; advance: () => void; openReceipt: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const selectedOrder = resolveSelectedOrder(orders, selectedOrderId);
  const readyCount = orders.filter((order) => order.status === "ready").length;
  const visibleOrders = useMemo(() => orders.filter((order) => filter === "all" || order.status === "ready"), [filter, orders]);
  if (selectedOrder !== null) return <OrderDetail order={selectedOrder} onBack={() => setSelectedOrderId(null)} review={{ disabled: !connected, run: () => prepare(selectedOrder.id) }} />;
  return <section className="work-panel" aria-labelledby="work-title" id={targets.workQueue}>
    <h1 id="work-title">Decisions</h1>
    <div className="queue-toolbar"><div className="filters" aria-label="Filter decisions"><Button variant="quiet" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All {orders.length}</Button><Button variant="quiet" id={targets.readyFilter} aria-pressed={filter === "ready"} onClick={() => setFilter("ready")}>Ready {readyCount}</Button></div><Button variant="link" onClick={prepareBatch} disabled={!connected || readyCount === 0}>Review ready orders</Button></div>
    <ul className="order-list" data-testid="order-list">{visibleOrders.map((order) => <li key={order.id}><button type="button" id={order.targetId} className="order-row" onClick={() => setSelectedOrderId(order.id)}><span className="order-id">{order.id}</span><span className="order-copy"><strong>{order.item}</strong><span>{order.issue}</span></span><span className={`status status-${order.status}`}>{order.statusLabel}</span></button></li>)}</ul>
    <div className="workspace-controls"><span>{latestReceipt !== null && <Button variant="link" onClick={openReceipt}>View last receipt</Button>}<Button variant="link" onClick={advance} disabled={!connected}>Advance stock scenario</Button></span><Button variant="link" className="reset-link" onClick={prepareReset} disabled={!connected}>Reset my demo</Button></div>
  </section>;
}

function ChatPanel({ snapshot, connected, onSend, onCancel, error }: { snapshot: WorkspaceSnapshot; connected: boolean; onSend: (message: string) => void; onCancel: () => void; error: string | null }) {
  const [message, setMessage] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const active = snapshot.activeTurn;
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [snapshot.chat.length, active?.phase]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = message.trim();
    if (value.length === 0 || active !== null || !connected) return;
    onSend(value);
    setMessage("");
  };
  return <aside className="chat-panel" aria-label={`Assistant chat, ${snapshot.agentMode} provider`} data-provider-mode={snapshot.agentMode}>
    <div className="chat-messages" ref={listRef} aria-live="polite">
      {snapshot.chat.map((item) => <p key={item.id} className={`chat-message chat-${item.role}`} data-chat-turn={item.turnId} data-chat-role={item.role}>{item.content}</p>)}
      {active !== null && <div className="turn-progress" role="status"><span className="progress-dot" aria-hidden="true" /> <span>{active.phase}</span><Button variant="link" onClick={onCancel}>Cancel</Button></div>}
      {error !== null && <p className="chat-error" role="alert">{error}</p>}
    </div>
    <form className="composer" id={targets.chatComposer} onSubmit={submit}>
      <label className="sr-only" htmlFor="chat-message">Message</label>
      <input id="chat-message" type="text" placeholder="Message..." value={message} maxLength={2000} onChange={(event) => setMessage(event.target.value)} disabled={!connected || active !== null} />
      <Button variant="icon" type="submit" aria-label="Send message" disabled={!connected || active !== null || message.trim().length === 0}><span aria-hidden="true">↑</span></Button>
    </form>
  </aside>;
}
function EmptyRoute({ title, text }: { title: string; text: string }) { return <main className="empty-route"><h1>{title}</h1><p>{text}</p></main>; }

export default function App() {
  const [view, setView] = useState<View>("work");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ReviewedProposal | null>(null);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { snapshot, status, runCommand, sendAgentMessage, cancelAgentTurn, agentOperation, acknowledgeAgentOperation, acknowledgeAgentComplete, acknowledgeCommandVisible, agentError } = useWorkspace();
  const acceptStarted = useRef<number | null>(null);
  const priorGeneration = useRef<number | null>(null);
  useEffect(() => {
    if (snapshot === null) return;
    if (priorGeneration.current !== null && priorGeneration.current !== snapshot.generation) {
      if (proposal?.generation !== snapshot.generation) setProposal(null);
      if (receipt?.generation !== snapshot.generation) setReceipt(null);
      setSelectedOrderId(null);
    }
    priorGeneration.current = snapshot.generation;
  }, [snapshot?.generation, proposal?.generation, receipt?.generation]);
  useEffect(() => {
    if (proposal !== null) document.getElementById("proposal-title")?.focus();
    else if (receipt !== null) document.getElementById("receipt-title")?.focus();
  }, [proposal?.id, receipt?.id]);
  useEffect(() => {
    if (snapshot?.currentProposal !== null && snapshot?.currentProposal !== undefined && proposal?.id !== snapshot.currentProposal.id) {
      setReceipt(null);
      setProposal(snapshot.currentProposal);
    }
  }, [snapshot?.currentProposal?.id]);
  useEffect(() => {
    if (agentOperation === null || snapshot === null) return;
    if (agentOperation.kind === "navigate") {
      if (agentOperation.view === "order") { setView("work"); setSelectedOrderId(agentOperation.orderId ?? null); }
      else { setView(agentOperation.view); setSelectedOrderId(null); }
    }
    if (agentOperation.kind === "present_proposal") {
      const prepared = snapshot.currentProposal;
      if (prepared !== null && prepared.id === agentOperation.proposalId) { setView("work"); setReceipt(null); setProposal(prepared); }
    }
    let cancelled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (cancelled) return;
      const target = agentOperation.kind === "highlight"
        ? document.getElementById(agentOperation.targetId)
        : agentOperation.kind === "present_proposal"
          ? document.getElementById("proposal-title")
          : agentOperation.view === "order"
            ? agentOperation.orderId === undefined ? null : document.getElementById(targets.orderEvidence(agentOperation.orderId))
            : document.querySelector(`[data-view="${agentOperation.view}"]`);
      if (target instanceof HTMLElement && agentOperation.kind === "highlight") {
        target.classList.add("agent-highlight");
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        window.setTimeout(() => target.classList.remove("agent-highlight"), 2400);
      }
      acknowledgeAgentOperation(agentOperation, target === null ? "missing" : "applied");
    }));
    return () => { cancelled = true; };
  }, [agentOperation?.id, snapshot?.currentProposal?.id]);
  useEffect(() => {
    const active = snapshot?.activeTurn;
    if (snapshot === null || active == null || active.phase !== "Rendering answer") return;
    let cancelled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (cancelled) return;
      const rendered = document.querySelector(`[data-chat-turn="${CSS.escape(active.id)}"][data-chat-role="assistant"]`);
      if (rendered !== null) acknowledgeAgentComplete(active.id, snapshot.generation);
    }));
    return () => { cancelled = true; };
  }, [snapshot?.activeTurn?.id, snapshot?.activeTurn?.phase, snapshot?.chat.length]);
  useEffect(() => {
    if (receipt === null || acceptStarted.current === null) return;
    let cancelled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (cancelled || document.getElementById("receipt-title") === null || acceptStarted.current === null) return;
      const durationMs = performance.now() - acceptStarted.current;
      acceptStarted.current = null;
      acknowledgeCommandVisible(receipt.id, receipt.generation, durationMs);
    }));
    return () => { cancelled = true; };
  }, [receipt?.id]);
  const perform = async (task: () => Promise<CommandResult>) => { setBusy(true); setError(null); try { return await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The command failed."); return null; } finally { setBusy(false); } };
  const showProposal = async (task: () => Promise<CommandResult>) => { const result = await perform(task); if (result?.kind === "proposal") { setReceipt(null); setProposal(result.proposal); } };
  const accept = async () => { if (proposal === null) return; acceptStarted.current = performance.now(); const result = await perform(() => runCommand({ type: "accept_proposal", proposalId: proposal.id, idempotencyKey: crypto.randomUUID() })); if (result?.kind === "receipt") { setProposal(null); setSelectedOrderId(null); setReceipt(result.receipt); } else { acceptStarted.current = null; } };
  const undo = async () => { if (receipt === null) return; await showProposal(() => runCommand({ type: "prepare_undo", receiptId: receipt.id })); };
  const advance = async () => { const result = await perform(() => runCommand({ type: "advance_scenario", scenario: "stock_change" })); if (result?.kind === "scenario") setError(result.message); };

  return <div className="app-shell"><header className="topbar"><div className="brand"><BrandIcon /> <span>Bracken &amp; Beam</span></div><span className={`connection connection-${status}`} data-testid="connection-status"><span aria-hidden="true" />{connectionText[status]}</span><nav aria-label="Main navigation">{(["work", "explore", "audit"] as const).map((item) => <Button key={item} variant="quiet" aria-current={view === item ? "page" : undefined} onClick={() => setView(item)}>{item[0]!.toUpperCase() + item.slice(1)}</Button>)}</nav></header>
    {view === "work" ? <main className="work-layout" data-view="work">{snapshot === null ? <section className="work-panel loading-panel" aria-live="polite"><h1>Decisions</h1><p>{status === "offline" ? "Reconnect to load your workspace." : "Loading your workspace…"}</p></section> : proposal !== null ? <ProposalView proposal={proposal} orders={snapshot.orders} busy={busy} connected={status === "connected"} onAccept={accept} onCancel={() => { setProposal(null); setSelectedOrderId(null); }} /> : receipt !== null ? <ReceiptView receipt={receipt} busy={busy} connected={status === "connected"} onBack={() => setReceipt(null)} onUndo={undo} /> : <WorkQueue orders={snapshot.orders} latestReceipt={snapshot.latestReceipt} connected={status === "connected" && !busy} selectedOrderId={selectedOrderId} setSelectedOrderId={setSelectedOrderId} prepare={(orderId) => void showProposal(() => runCommand({ type: "prepare_resolution", orderId }))} prepareBatch={() => void showProposal(() => runCommand({ type: "prepare_batch" }))} prepareReset={() => void showProposal(() => runCommand({ type: "prepare_reset" }))} advance={() => void advance()} openReceipt={() => setReceipt(snapshot.latestReceipt)} />}{snapshot !== null && <ChatPanel snapshot={snapshot} connected={status === "connected"} onSend={(message) => { try { sendAgentMessage(message); } catch (cause) { setError(cause instanceof Error ? cause.message : "The message could not be sent."); } }} onCancel={cancelAgentTurn} error={agentError} />}{error !== null && <div className="command-message" role="status">{error}</div>}</main> : view === "explore" ? <div data-view="explore"><EmptyRoute title="Explore" text="Scenario guides and the tool catalogue arrive with agent integration." /></div> : <div data-view="audit"><EmptyRoute title="Audit" text="Inference activity arrives with agent integration. Command audit is already retained by the server." /></div>}
  </div>;
}
