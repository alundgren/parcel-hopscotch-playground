import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AgentViewContext, AuditAttemptDetail, AuditAttemptSummary, AuditPage, CommandReceipt, CommandResult, OrderSummary, ReviewedProposal, TutorialState, WorkspaceSnapshot } from "../shared/contracts";
import { targets } from "../shared/targets";
import { Button } from "./components/ui/button";
import { useWorkspace, type ConnectionStatus } from "./use-workspace";

type View = "work" | "explore" | "audit";
type Filter = "all" | "ready";
function BrandIcon() { return <span className="brand-icon" aria-hidden="true"><img src="/favicon.png" alt="" /></span>; }
const connectionText: Record<ConnectionStatus, string> = { connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting", offline: "Offline", retired: "Session replaced" };
export const resolveSelectedOrder = (orders: ReadonlyArray<OrderSummary>, selectedOrderId: string | null) => selectedOrderId === null ? null : orders.find((order) => order.id === selectedOrderId) ?? null;

interface ActionProps { readonly disabled: boolean; readonly run: () => void }

function TutorialCoach({ tutorial, recoveryText, onDismiss, disabled }: { tutorial: TutorialState; recoveryText: string; onDismiss: () => void; disabled: boolean }) {
  const [targetAvailable, setTargetAvailable] = useState(true);
  useEffect(() => {
    let frame = 0;
    const inspect = () => {
      const target = document.getElementById(tutorial.targetId);
      const available = target instanceof HTMLElement && !target.hidden && target.getClientRects().length > 0;
      setTargetAvailable(available);
      if (!available || !(target instanceof HTMLElement)) return;
      const rect = target.getBoundingClientRect();
      const visible = rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
      if (!visible) {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
        if (!target.matches(":focus, :focus-within")) target.focus({ preventScroll: true });
      }
    };
    frame = requestAnimationFrame(() => requestAnimationFrame(inspect));
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class"] });
    window.addEventListener("resize", inspect);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", inspect); };
  }, [tutorial.id, tutorial.step, tutorial.targetId]);
  const fraction = `${Math.min(tutorial.step + 1, tutorial.totalSteps)} / ${tutorial.totalSteps}`;
  const recovering = tutorial.phase !== "complete" && !targetAvailable;
  return <aside className={`tutorial-coach${recovering ? " tutorial-recovery" : ""}`} id={targets.tutorialCoach} aria-label={`${tutorial.title} tutorial`} data-tutorial-id={tutorial.id} data-tutorial-phase={tutorial.phase} data-tutorial-step={tutorial.step}>
    {recovering && <p className="tutorial-recovery-copy">{recoveryText}</p>}
    <p>{tutorial.instruction}</p>
    <div><span>{fraction}</span><Button variant="icon" onClick={onDismiss} disabled={disabled} aria-label="Dismiss tutorial"><span aria-hidden="true">×</span></Button></div>
  </aside>;
}

function OrderDetail({ order, onBack, review, coach }: { order: OrderSummary; onBack: () => void; review: ActionProps; coach: ReactNode }) {
  return <section className="order-detail" aria-labelledby="detail-title">
    <Button variant="link" onClick={onBack} className="back-button"><span aria-hidden="true">←</span> Back to queue</Button>
    <div className="detail-heading"><div><span className="order-id">{order.id}</span><h1 id="detail-title">{order.family === "address" ? "Check address" : order.item}</h1></div><span className={`status status-${order.status}`}>{order.statusLabel}</span></div>
    <p className="detail-summary">{order.issue}</p>
    <div className="detail-current"><span>Current</span><p>{order.businessValue}</p></div>
    <div className="evidence" id={targets.orderEvidence(order.id)} tabIndex={-1}>{order.evidence.map((item) => <div className="evidence-row" key={`${item.label}-${item.occurredAt}`}><div><span className="evidence-label">{item.label}</span><span className="evidence-age">{item.age}</span></div><p>“{item.value}”</p></div>)}</div>
    <div className="detail-actions"><Button onClick={review.run} disabled={review.disabled}>Review change</Button></div>
    {coach}
  </section>;
}

function ProposalView({ proposal, orders, busy, connected, onAccept, onCancel, coach }: { proposal: ReviewedProposal; orders: ReadonlyArray<OrderSummary>; busy: boolean; connected: boolean; onAccept: () => void; onCancel: () => void; coach: ReactNode }) {
  const reset = proposal.kind === "reset";
  const addressChange = proposal.kind === "resolution" && proposal.changes.length === 1 && proposal.changes[0]?.family === "address" ? proposal.changes[0] : null;
  const addressOrder = addressChange === null ? null : orders.find((order) => order.id === addressChange.orderId) ?? null;
  const acceptLabel = !proposal.ready ? "Held" : !connected ? "Reconnect to accept" : busy ? "Working…" : reset ? "Reset my demo" : `Accept ${proposal.changes.length} ${proposal.changes.length === 1 ? "change" : "changes"}`;
  if (addressChange !== null && addressOrder !== null) return <section className="order-detail proposal-screen address-review" aria-labelledby="proposal-title">
    <div className="detail-heading"><h1 id="proposal-title" tabIndex={-1}>Check address</h1><span className="order-id">{addressOrder.id}</span></div>
    <div className="address-evidence"><div><span>Order</span><p>{addressChange.before}</p></div><div><span>Customer</span><p>“{addressOrder.evidence[0]?.value}”</p></div></div>
    <div className="address-proposal" id={targets.proposalReview} tabIndex={-1}><p><span aria-hidden="true">✧</span> <s>{addressChange.before.split(",")[0]}</s> <span aria-hidden="true">→</span> <strong>{addressChange.after}</strong></p><Button id={targets.proposalAccept} className="address-action" onClick={onAccept} disabled={busy || !connected || !proposal.ready}>{acceptLabel}</Button></div>
    {coach}
    <Button variant="link" onClick={onCancel} disabled={busy}>Cancel</Button>
  </section>;
  return <section className="order-detail proposal-screen" aria-labelledby="proposal-title" id={targets.proposalReview} tabIndex={-1}>
    <h1 id="proposal-title" tabIndex={-1}>{proposal.title}</h1>
    <p className={`proposal-state ${proposal.ready ? "ready" : ""}`}>{proposal.ready ? "✓ Ready" : "Needs review"}</p>
    {proposal.changes.length > 0 && <div className="change-list">{proposal.changes.map((change) => <article className="change-row" key={change.orderId}><span className="order-id">{change.orderId}</span><div><strong>{change.before} <span aria-hidden="true">→</span> {change.after}</strong><p>{change.effect}</p></div></article>)}</div>}
    {reset && proposal.effects.length > 0 && <ul className="effect-list">{proposal.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>}
    {proposal.omissions.length > 0 && <div className="omissions" aria-label="Orders left out">{proposal.omissions.map((item) => <p key={item.orderId}><span className="order-id">{item.orderId}</span> excluded · {item.reason}</p>)}</div>}
    {coach}
    <div className="proposal-actions"><Button id={targets.proposalAccept} className={reset ? "danger-action" : proposal.kind === "batch" ? "batch-action" : "accept-action"} onClick={onAccept} disabled={busy || !connected || !proposal.ready}>{acceptLabel}</Button><Button variant="quiet" onClick={onCancel} disabled={busy}>Cancel</Button></div>
  </section>;
}

function ReceiptView({ receipt, busy, connected, onBack, onUndo, coach }: { receipt: CommandReceipt; busy: boolean; connected: boolean; onBack: () => void; onUndo: () => void; coach: ReactNode }) {
  return <section className="order-detail receipt-screen" aria-labelledby="receipt-title" id={targets.receipt} tabIndex={-1}>
    <h1 id="receipt-title" tabIndex={-1}>{receipt.title}</h1>
    <p className="receipt-state">✓ {receipt.kind === "reset" ? "Fresh workspace ready" : receipt.kind === "undo" ? "Undone by you" : "Accepted by you"}</p>
    {receipt.changes.length > 0 && <div className="receipt-list">{receipt.changes.map((change) => <div className="receipt-row" key={change.orderId}><span className="order-id">{change.orderId}</span><span>{change.after}</span></div>)}</div>}
    {coach}
    <div className="proposal-actions"><Button id={targets.receiptBack} className="accept-action" onClick={onBack}>Back to work</Button>{receipt.undoable && <Button variant="quiet" onClick={onUndo} disabled={busy || !connected}>{!connected ? "Reconnect to undo" : busy ? "Checking…" : "Undo"}</Button>}</div>
  </section>;
}

function WorkQueue({ orders, latestReceipt, tutorialReceipt, savedProposal, tutorialProposal, connected, selectedOrderId, selectOrder, prepare, prepareBatch, prepareReset, advance, openReceipt, openTutorialReceipt, openSavedProposal, openTutorialProposal, selectReady, coach }: { orders: ReadonlyArray<OrderSummary>; latestReceipt: CommandReceipt | null; tutorialReceipt: CommandReceipt | null; savedProposal: ReviewedProposal | null; tutorialProposal: ReviewedProposal | null; connected: boolean; selectedOrderId: string | null; selectOrder: (id: string | null) => void; prepare: (id: string) => void; prepareBatch: () => void; prepareReset: () => void; advance: () => void; openReceipt: () => void; openTutorialReceipt: () => void; openSavedProposal: () => void; openTutorialProposal: () => void; selectReady: () => void; coach: ReactNode }) {
  const [filter, setFilter] = useState<Filter>("all");
  const selectedOrder = resolveSelectedOrder(orders, selectedOrderId);
  const readyCount = orders.filter((order) => order.status === "ready").length;
  const visibleOrders = useMemo(() => orders.filter((order) => filter === "all" || order.status === "ready"), [filter, orders]);
  if (selectedOrder !== null) return <OrderDetail order={selectedOrder} onBack={() => selectOrder(null)} review={{ disabled: !connected, run: () => prepare(selectedOrder.id) }} coach={coach} />;
  return <section className="work-panel" aria-labelledby="work-title" id={targets.workQueue}>
    <h1 id="work-title">Decisions</h1>
    <div className="queue-toolbar"><div className="filters" aria-label="Filter decisions"><Button variant="quiet" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All {orders.length}</Button><Button variant="quiet" id={targets.readyFilter} aria-pressed={filter === "ready"} onClick={() => { setFilter("ready"); selectReady(); }}>Ready {readyCount}</Button></div><span>{savedProposal !== null && <Button variant="link" onClick={openSavedProposal}>Review saved proposal</Button>}{tutorialProposal !== null && tutorialProposal.id !== savedProposal?.id && <Button variant="link" onClick={openTutorialProposal}>Continue tutorial proposal</Button>}<Button variant="link" id={targets.batchReview} onClick={prepareBatch} disabled={!connected || readyCount === 0}>Review ready orders</Button></span></div>
    {coach}
    <ul className="order-list" data-testid="order-list">{visibleOrders.map((order) => <li key={order.id}><button type="button" id={order.targetId} className="order-row" onClick={() => selectOrder(order.id)}><span className="order-id">{order.id}</span><span className="order-copy"><strong>{order.item}</strong><span>{order.issue}</span></span><span className={`status status-${order.status}`}>{order.statusLabel}</span></button></li>)}</ul>
    <div className="workspace-controls"><span>{latestReceipt !== null && <Button variant="link" id={targets.receiptLink} onClick={openReceipt}>View last receipt</Button>}{tutorialReceipt !== null && tutorialReceipt.id !== latestReceipt?.id && <Button variant="link" onClick={openTutorialReceipt}>Continue tutorial receipt</Button>}<Button variant="link" onClick={advance} disabled={!connected}>Advance stock scenario</Button></span><Button variant="link" className="reset-link" onClick={prepareReset} disabled={!connected}>Reset my demo</Button></div>
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

const durationText = (duration: number | null): string => duration === null ? "Unknown" : duration < 1_000 ? `${Math.round(duration)} ms` : `${(duration / 1_000).toFixed(duration < 10_000 ? 2 : 1)} s`;
const tokenText = (attempt: AuditAttemptSummary): string => attempt.totalTokens === null ? "Unknown" : attempt.totalTokens.toLocaleString();
const costText = (attempt: AuditAttemptSummary): string => {
  if (attempt.mode === "scripted") return "Fixture";
  if (attempt.costUsd === null) return "Unknown";
  if (attempt.costUsd === 0) return "$0";
  return `$${attempt.costUsd.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")}`;
};
const modelText = (attempt: AuditAttemptSummary): string => {
  const model = attempt.actualModel ?? attempt.requestedModel;
  const normalized = model.replace("scripted/", "").replace("mistralai/", "").replace("typesafe/", "");
  if (normalized === "ministral-3b-2512") return "Ministral 3B";
  if (normalized.startsWith("jev-1.13")) return "Jev 1.13";
  return normalized;
};
const outcomeText: Record<AuditAttemptSummary["outcome"], string> = {
  running: "Running", success: "Completed", error: "Error", credits_exhausted: "Credits exhausted",
  timeout: "Timed out", cancelled: "Cancelled", interrupted: "Interrupted",
};
type AuditTab = "request" | "response" | "application";

function AuditDetails({ detail, tab, setTab, loadMore }: { detail: AuditAttemptDetail | null; tab: AuditTab; setTab: (tab: AuditTab) => void; loadMore: (attemptId: string, cursor: string) => void }) {
  if (detail === null) return <div className="audit-detail-loading" role="status">Loading request details…</div>;
  const panelId = `audit-panel-${detail.attempt.id}`;
  const selectedText = tab === "request" ? detail.requestText : detail.responseText ?? "No response body was recorded.";
  return <div className="audit-detail" id={`audit-detail-${detail.attempt.id}`}>
    <div className="audit-meta">
      <span className="audit-id">{detail.attempt.id}</span><span>{detail.attempt.provider}</span><span className="audit-id">{detail.attempt.actualModel ?? detail.attempt.requestedModel}</span><span>{detail.attempt.mode === "scripted" ? "Fixture run" : detail.attempt.mode === "live" ? "Live run" : "Provider unavailable"}</span>
    </div>
    <div className="audit-meta">
      <span>Provider request {durationText(detail.attempt.durationMs)}</span>
      <span>Server turn {detail.serverTurnMeasurement === "complete" ? durationText(detail.serverTurnDurationMs) : detail.serverTurnMeasurement === "incomplete" ? "Incomplete" : "Unknown"}</span>
      <span>Browser send to completed work {detail.browserMeasurement === "complete" ? durationText(detail.browserDurationMs) : detail.browserMeasurement === "incomplete" ? "Incomplete" : "Unknown"}</span>
      <span>Input {detail.attempt.inputTokens === null ? "unknown tokens" : `${detail.attempt.inputTokens.toLocaleString()} tokens`} · {detail.requestBytes.toLocaleString()} UTF-8 B</span>
      <span>Output {detail.attempt.outputTokens === null ? "unknown tokens" : `${detail.attempt.outputTokens.toLocaleString()} tokens`} · {detail.responseBytes === null ? "unknown bytes" : `${detail.responseBytes.toLocaleString()} UTF-8 B`}</span>
      <span>Retries {detail.attempt.retryCount}</span>
      <span>Cost {costText(detail.attempt)}</span>
    </div>
    {(detail.errorMessage !== null || detail.attempt.errorCode !== null) && <p className="audit-error">{detail.attempt.errorCode ?? "provider_error"}: {detail.errorMessage ?? "No error detail was recorded."}</p>}
    <div className="audit-tabs" role="tablist" aria-label="Request details">
      {(["request", "response", "application"] as const).map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} aria-controls={panelId} id={`audit-tab-${detail.attempt.id}-${name}`} onClick={() => setTab(name)}>{name === "application" ? "Application result" : name[0]!.toUpperCase() + name.slice(1)}</button>)}
    </div>
    <div role="tabpanel" id={panelId} aria-labelledby={`audit-tab-${detail.attempt.id}-${tab}`}>
      {tab === "application" ? detail.application.length === 0 ? <p className="audit-no-result">No correlated application result was recorded.</p> : <div className="audit-results">{detail.application.map((record) => <details key={record.id}><summary><strong>{record.label}</strong><span>{record.outcome}</span><span>{new Date(record.occurredAt).toLocaleTimeString()}</span></summary><pre>{record.bodyText}</pre></details>)}{detail.applicationNextCursor !== null && <Button variant="quiet" onClick={() => loadMore(detail.attempt.id, detail.applicationNextCursor!)}>Load earlier results</Button>}</div> : <pre>{selectedText}</pre>}
    </div>
  </div>;
}

function AuditView({ page, details, loading, error, revision, connected, requestPage, requestDetail }: {
  page: AuditPage | null;
  details: Readonly<Record<string, AuditAttemptDetail>>;
  loading: boolean;
  error: string | null;
  revision: number;
  connected: boolean;
  requestPage: (query: string, cursor?: string | null, append?: boolean) => void;
  requestDetail: (attemptId: string, applicationCursor?: string | null, append?: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<AuditTab>("request");
  useEffect(() => {
    if (!connected) return;
    const timer = window.setTimeout(() => requestPage(query), 180);
    return () => window.clearTimeout(timer);
  }, [query, revision, connected, requestPage]);
  useEffect(() => {
    if (connected && openId !== null) requestDetail(openId);
  }, [revision, connected]);
  const open = (attemptId: string) => {
    if (openId === attemptId) { setOpenId(null); return; }
    setOpenId(attemptId);
    setTab("request");
    if (details[attemptId] === undefined) requestDetail(attemptId);
  };
  const visible = page?.attempts ?? [];
  return <main className="audit-view" aria-labelledby="audit-title" data-audit-query={page?.query ?? "loading"}>
    <div className="audit-heading"><h1 id="audit-title">Audit</h1><span>Retained inference history</span></div>
    <div className="audit-toolbar">
      <label className="audit-filter"><span aria-hidden="true">⌕</span><span className="sr-only">Search audit history</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter requests..." autoComplete="off" />{query.length > 0 && <Button variant="icon" aria-label="Clear audit search" onClick={() => setQuery("")}>×</Button>}</label>
      <span className="audit-count" aria-live="polite">{page === null ? "Loading requests" : query.trim().length > 0 ? `${page.total} matching ${page.total === 1 ? "request" : "requests"}` : `${page.total} ${page.total === 1 ? "request" : "requests"}`}</span>
    </div>
    {error !== null && <p className="audit-load-error" role="alert">{error}</p>}
    {page !== null && page.markers.length > 0 && <div className="audit-markers" aria-label="Reset history">{page.markers.map((marker) => <details key={marker.id} data-reset-id={marker.id}><summary><span>Workspace reset</span><span>{new Date(marker.occurredAt).toLocaleString()}</span></summary><pre>{marker.bodyText}</pre></details>)}</div>}
    {visible.length === 0 && !loading ? <div className="audit-empty">{query.trim().length > 0 ? <>No requests match this filter. <Button variant="link" onClick={() => setQuery("")}>Clear search</Button></> : "No inference attempts have been recorded yet."}</div> : <div className="audit-scroll"><table className="audit-table" aria-label="Inference requests"><colgroup><col className="audit-col-time" /><col /><col className="audit-col-model" /><col className="audit-col-outcome" /><col className="audit-col-duration" /><col className="audit-col-tokens" /><col className="audit-col-cost" /></colgroup><thead><tr><th scope="col">At</th><th scope="col">Request</th><th scope="col">Model</th><th scope="col">Outcome</th><th scope="col" className="audit-number">Duration</th><th scope="col" className="audit-number">Tokens</th><th scope="col" className="audit-number">Cost</th></tr></thead><tbody>{visible.map((attempt) => {
      const expanded = openId === attempt.id;
      return <Fragment key={attempt.id}><tr className={`audit-summary${expanded ? " audit-summary-open" : ""}`} data-attempt-id={attempt.id}><td>{new Date(attempt.startedAt).toLocaleTimeString([], { hour12: false })}</td><td><button type="button" className="audit-expand" aria-expanded={expanded} aria-controls={`audit-detail-${attempt.id}`} onClick={() => open(attempt.id)}><span aria-hidden="true">{expanded ? "⌄" : "›"}</span><span>{attempt.requestLabel}</span></button></td><td><span>{modelText(attempt)}</span>{attempt.mode === "scripted" && <small>Fixture</small>}</td><td className={`audit-outcome audit-outcome-${attempt.outcome}`}>{outcomeText[attempt.outcome]}</td><td className="audit-number">{durationText(attempt.durationMs)}</td><td className="audit-number">{tokenText(attempt)}</td><td className="audit-number">{costText(attempt)}</td></tr>{expanded && <tr><td colSpan={7} className="audit-detail-cell"><AuditDetails detail={details[attempt.id] ?? null} tab={tab} setTab={setTab} loadMore={(attemptId, cursor) => requestDetail(attemptId, cursor, true)} /></td></tr>}</Fragment>;
    })}</tbody></table></div>}
    {page?.nextCursor !== null && page?.nextCursor !== undefined && <div className="audit-more"><Button variant="quiet" disabled={loading} onClick={() => requestPage(query, page.nextCursor, true)}>{loading ? "Loading…" : "Load more"}</Button></div>}
  </main>;
}

export default function App() {
  const [view, setView] = useState<View>("work");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ReviewedProposal | null>(null);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { snapshot, status, runCommand, sendAgentMessage, cancelAgentTurn, agentOperation, acknowledgeAgentOperation, acknowledgeAgentComplete, acknowledgeCommandVisible, agentError, auditPage, auditDetails, auditLoading, auditError, auditRevision, requestAudit, requestAuditDetail } = useWorkspace();
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
      setProposal(null);
      setReceipt(null);
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
  }, [snapshot?.activeTurn?.id, snapshot?.activeTurn?.phase, snapshot?.chat.length, view]);
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
  type TutorialActionInput =
    | { readonly action: "order_selected"; readonly orderId: string }
    | { readonly action: "ready_filter_selected" }
    | { readonly action: "receipt_confirmed"; readonly receiptId: string };
  const reportTutorialAction = (input: TutorialActionInput) => {
    const tutorial = snapshot?.tutorial;
    if (tutorial === null || tutorial === undefined) return;
    void runCommand({
      type: "tutorial_action",
      tutorialId: tutorial.id,
      tutorialInstanceId: tutorial.instanceId,
      expectedStep: tutorial.step,
      ...input,
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "The tutorial action could not be recorded.");
    });
  };
  const dismissTutorial = () => {
    void perform(() => runCommand({ type: "stop_tutorial" }));
  };
  const confirmReceiptAndBack = async () => {
    if (receipt === null) return;
    const tutorial = snapshot?.tutorial;
    const finalPracticeStep = tutorial !== null && tutorial !== undefined && tutorial.step === tutorial.totalSteps - 1;
    let tutorialCompleted = false;
    if (tutorial !== null && tutorial !== undefined) {
      const result = await perform(() => runCommand({ type: "tutorial_action", tutorialId: tutorial.id, tutorialInstanceId: tutorial.instanceId, expectedStep: tutorial.step, action: "receipt_confirmed", receiptId: receipt.id }));
      tutorialCompleted = finalPracticeStep && result?.kind === "tutorial" && result.advanced;
    }
    if (!tutorialCompleted) setReceipt(null);
  };
  const recoveryText = snapshot?.tutorialReceipt !== null && snapshot?.tutorialReceipt !== undefined
    ? snapshot.tutorialReceipt.id === snapshot.latestReceipt?.id ? "The receipt for this step is saved. Return to Work and use View last receipt." : "The receipt for this step is saved. Return to Work and use Continue tutorial receipt."
    : snapshot?.tutorialProposal !== null && snapshot?.tutorialProposal !== undefined
      ? snapshot.tutorialProposal.id === snapshot.currentProposal?.id ? "The proposal for this step is saved. Return to Work and use Review saved proposal." : "The proposal for this step is saved. Return to Work and use Continue tutorial proposal."
      : "The next step is not visible. Return to Work and open the requested order from the list.";
  const coach = snapshot?.tutorial === null || snapshot?.tutorial === undefined ? null : <TutorialCoach tutorial={snapshot.tutorial} recoveryText={recoveryText} onDismiss={dismissTutorial} disabled={busy || status !== "connected"} />;

  return <div className="app-shell"><header className="topbar"><div className="brand"><BrandIcon /> <span>Bracken &amp; Beam</span></div><span className={`connection connection-${status}`} data-testid="connection-status"><span aria-hidden="true" />{connectionText[status]}</span><nav aria-label="Main navigation">{(["work", "explore", "audit"] as const).map((item) => <Button key={item} variant="quiet" aria-current={view === item ? "page" : undefined} onClick={() => setView(item)}>{item[0]!.toUpperCase() + item.slice(1)}</Button>)}</nav></header>
    {view === "work" ? <main className="work-layout" data-view="work">{snapshot === null ? <section className="work-panel loading-panel" aria-live="polite"><h1>Decisions</h1><p>{status === "offline" ? "Reconnect to load your workspace." : "Loading your workspace…"}</p></section> : proposal !== null ? <ProposalView proposal={proposal} orders={snapshot.orders} busy={busy} connected={status === "connected"} onAccept={accept} onCancel={() => { setProposal(null); setSelectedOrderId(null); }} coach={coach} /> : receipt !== null ? <ReceiptView receipt={receipt} busy={busy} connected={status === "connected"} onBack={() => void confirmReceiptAndBack()} onUndo={undo} coach={coach} /> : <WorkQueue orders={snapshot.orders} latestReceipt={snapshot.latestReceipt} tutorialReceipt={snapshot.tutorialReceipt} savedProposal={snapshot.currentProposal} tutorialProposal={snapshot.tutorialProposal} connected={status === "connected" && !busy} selectedOrderId={selectedOrderId} selectOrder={(orderId) => { setSelectedOrderId(orderId); if (orderId !== null) void reportTutorialAction({ action: "order_selected", orderId }); }} prepare={(orderId) => void showProposal(() => runCommand({ type: "prepare_resolution", orderId }))} prepareBatch={() => void showProposal(() => runCommand({ type: "prepare_batch" }))} prepareReset={() => void showProposal(() => runCommand({ type: "prepare_reset" }))} advance={() => void advance()} openReceipt={() => setReceipt(snapshot.latestReceipt)} openTutorialReceipt={() => setReceipt(snapshot.tutorialReceipt)} openSavedProposal={() => setProposal(snapshot.currentProposal)} openTutorialProposal={() => setProposal(snapshot.tutorialProposal)} selectReady={() => { void reportTutorialAction({ action: "ready_filter_selected" }); }} coach={coach} />}{snapshot !== null && <ChatPanel snapshot={snapshot} connected={status === "connected"} onSend={(message) => { try { const context: AgentViewContext = proposal !== null ? { view: "work", focus: { kind: "proposal", proposalId: proposal.id } } : receipt !== null ? { view: "work", focus: { kind: "receipt", receiptId: receipt.id } } : selectedOrderId !== null ? { view: "work", focus: { kind: "order", orderId: selectedOrderId } } : { view, focus: null }; sendAgentMessage(message, context); } catch (cause) { setError(cause instanceof Error ? cause.message : "The message could not be sent."); } }} onCancel={cancelAgentTurn} error={agentError} />}{error !== null && <div className="command-message" role="status">{error}</div>}</main> : view === "explore" ? <div data-view="explore"><EmptyRoute title="Explore" text="Scenario guides and the tool catalogue arrive with agent integration." />{coach}</div> : <div data-view="audit"><AuditView page={auditPage} details={auditDetails} loading={auditLoading} error={auditError} revision={auditRevision} connected={status === "connected"} requestPage={requestAudit} requestDetail={requestAuditDetail} />{coach}</div>}
  </div>;
}
