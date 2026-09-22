import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AgentViewContext, AuditAttemptDetail, AuditAttemptSummary, AuditPage, CommandReceipt, CommandResult, OrderSummary, ReviewedProposal, ToolCatalogueEntry, ToolCategory, TutorialState, WorkspaceSnapshot } from "../shared/contracts";
import { exploreScenarios, type ExploreScenarioId } from "../shared/explore";
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

type CatalogueCategory = "All" | ToolCategory;
interface ScenarioNotice { readonly scenario: ExploreScenarioId; readonly message: string; readonly offerReset: boolean }
const effectLabels: Readonly<Record<string, string>> = {
  read_workspace: "Read the current workspace",
  read_audit: "Read owner-scoped Audit history",
  navigate_registered_view: "Open a registered application view",
  highlight_registered_target: "Highlight a registered application target",
  start_bounded_tutorial: "Start a bounded tutorial",
  stop_tutorial_guidance: "Dismiss the current tutorial",
  create_reviewed_proposal: "Prepare a proposal for human review",
  provider_classification: "Run a bounded provider classification",
  read_only: "Leave workspace data unchanged",
};

function ExploreView({ entries, connected, busy, scenarioActive, notice, runScenario, cancelScenario, prepareReset, advanceScenario }: {
  entries: ReadonlyArray<ToolCatalogueEntry>;
  connected: boolean;
  busy: boolean;
  scenarioActive: boolean;
  notice: ScenarioNotice | null;
  runScenario: (scenario: ExploreScenarioId) => void;
  cancelScenario: () => void;
  prepareReset: () => void;
  advanceScenario: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CatalogueCategory>("All");
  const [scenarioId, setScenarioId] = useState<ExploreScenarioId | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scenario = exploreScenarios.find((candidate) => candidate.id === scenarioId) ?? null;
  const matches = entries.filter((entry) =>
    (category === "All" || entry.category === category)
    && (scenario === null || scenario.tools.includes(entry.id))
    && words.every((word) => JSON.stringify(entry).toLowerCase().includes(word))
  );
  const clear = () => { setQuery(""); setCategory("All"); setScenarioId(null); setCopyStatus(""); };
  const showScenarioTools = (id: ExploreScenarioId) => {
    setQuery("");
    setCategory("All");
    setScenarioId(id);
    setCopyStatus("");
    requestAnimationFrame(() => document.getElementById("tool-filter")?.focus());
  };
  const copyExample = async (entry: ToolCatalogueEntry) => {
    const value = JSON.stringify({ tool: entry.id, arguments: entry.example.arguments }, null, 2);
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`Copied the ${entry.id} example.`);
    } catch {
      const node = document.getElementById(`tool-call-${entry.id}`);
      if (node !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopyStatus("The example is selected. Use your usual copy shortcut.");
    }
  };
  return <main className="explore-view" aria-labelledby="explore-title">
    <div className="explore-heading"><h1 id="explore-title">Explore</h1><span>Current workspace</span></div>
    <div className="scenario-grid">
      {exploreScenarios.map((item) => <article className="scenario-card" key={item.id} data-scenario={item.id}>
        <h2>{item.title}</h2>
        <p className="scenario-prompt">{item.prompt}</p>
        <p>{item.description}</p>
        {notice?.scenario === item.id && <div className="scenario-notice" role="status"><p>{notice.message}</p>{scenarioActive && <Button variant="link" onClick={cancelScenario}>Cancel</Button>}{notice.offerReset && <Button variant="link" onClick={prepareReset} disabled={!connected || busy}>Prepare reset for review</Button>}</div>}
        <div className="scenario-actions"><Button className="scenario-try" aria-label={`${item.actionLabel}: ${item.title}`} onClick={() => runScenario(item.id)} disabled={!connected || busy}>{busy && notice?.scenario === item.id ? "Working…" : item.actionLabel} <span aria-hidden="true">↗</span></Button><Button variant="link" aria-label={`Show tools for ${item.title}`} aria-pressed={scenarioId === item.id} onClick={() => showScenarioTools(item.id)}>{item.tools.length} tools</Button>{item.id === "batch" && <Button variant="link" onClick={advanceScenario} disabled={!connected || busy}>Advance stock case</Button>}</div>
      </article>)}
    </div>
    <section aria-label="Tool catalogue" id="tool-catalogue">
      <div className="tools-toolbar">
        <label className="tool-search"><span aria-hidden="true">⌕</span><span className="sr-only">Filter tools</span><input id="tool-filter" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setCopyStatus(""); }} placeholder="Filter tools or try a phrase…" autoComplete="off" />{query.length > 0 && <Button variant="icon" aria-label="Clear tool search" onClick={() => { setQuery(""); setCopyStatus(""); document.getElementById("tool-filter")?.focus(); }}>×</Button>}</label>
        <div className="tool-filters" role="group" aria-label="Tool type">{(["All", "Read", "Guide", "Prepare", "Classify"] as const).map((name) => <Button key={name} variant="quiet" aria-pressed={category === name} onClick={() => { setCategory(name); setCopyStatus(""); }}>{name}</Button>)}</div>
      </div>
      <div className="tool-status"><span aria-live="polite">{matches.length === entries.length ? `${matches.length} tools` : `${matches.length} of ${entries.length} tools`}</span>{scenario !== null && <Button className="scenario-filter" onClick={() => setScenarioId(null)} aria-label={`Clear ${scenario.title} scenario filter`}>{scenario.title} ×</Button>}</div>
      {matches.length === 0 ? <div className="tools-empty"><p>No tools match these filters.</p><Button onClick={clear}>Clear filters</Button></div> : <>
        <div className="tool-columns" aria-hidden="true"><span>Tool</span><span>What it does</span><span>Type</span><span /></div>
        <div className="tool-list">{matches.map((entry) => <details className="tool-row" key={entry.id} data-tool-id={entry.id}>
          <summary><span><span className="tool-name">{entry.purpose}</span><code className="tool-id">{entry.id}</code></span><span className="tool-description">{entry.description}</span><span className="tool-kind">{entry.category}</span><span className="tool-chevron" aria-hidden="true">›</span></summary>
          <div className="tool-detail"><p className="tool-effect">What it may do: {entry.allowedEffects.map((effect) => effectLabels[effect] ?? effect).join("; ")}.</p><p className="tool-example-note">Illustrative examples validated against the runtime schemas.</p><div className="tool-examples"><div><div className="code-label"><span>Example call</span><Button variant="link" onClick={() => void copyExample(entry)} aria-label={`Copy example call for ${entry.id}`}>Copy</Button></div><pre id={`tool-call-${entry.id}`}>{JSON.stringify({ tool: entry.id, arguments: entry.example.arguments }, null, 2)}</pre></div><div><div className="code-label"><span>Example result</span></div><pre>{JSON.stringify(entry.example.result, null, 2)}</pre></div></div></div>
        </details>)}</div>
      </>}
      <div className="copy-status" role="status">{copyStatus}</div>
    </section>
  </main>;
}

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
const consentResultText = (bodyText: string): string | null => {
  try {
    const body = JSON.parse(bodyText) as { result?: { ok?: boolean; result?: { consent?: unknown; needsReview?: unknown }; consent?: unknown; needsReview?: unknown } };
    const result = body.result?.ok === true ? body.result.result : body.result;
    if (typeof result?.consent !== "string" || typeof result.needsReview !== "boolean") return null;
    return `Consent: ${result.consent}. ${result.needsReview ? "Human review required." : "No further consent review required."}`;
  } catch {
    return null;
  }
};

function AuditDetails({ detail, tab, setTab, loadMore, filterTurn, revealToolResult }: { detail: AuditAttemptDetail | null; tab: AuditTab; setTab: (tab: AuditTab) => void; loadMore: (attemptId: string, cursor: string) => void; filterTurn: (turnId: string) => void; revealToolResult: boolean }) {
  if (detail === null) return <div className="audit-detail-loading" role="status">Loading request details…</div>;
  const panelId = `audit-panel-${detail.attempt.id}`;
  const selectedText = tab === "request" ? detail.requestText : detail.responseText ?? "No response body was recorded.";
  return <div className="audit-detail" id={`audit-detail-${detail.attempt.id}`}>
    <div className="audit-meta">
      <span className="audit-id">Attempt {detail.attempt.id}</span><span className="audit-id">Request {detail.attempt.requestId}</span><Button variant="link" className="audit-turn-filter" onClick={() => filterTurn(detail.attempt.turnId)}>Show all attempts for turn {detail.attempt.turnId}</Button><span>{detail.attempt.provider}</span><span className="audit-id">{detail.attempt.actualModel ?? detail.attempt.requestedModel}</span><span>{detail.attempt.mode === "scripted" ? "Fixture run" : detail.attempt.mode === "live" ? "Live run" : "Provider unavailable"}</span>
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
      {(["request", "response", "application"] as const).map((name, index, tabs) => <button key={name} type="button" role="tab" tabIndex={tab === name ? 0 : -1} aria-selected={tab === name} aria-controls={panelId} id={`audit-tab-${detail.attempt.id}-${name}`} onClick={() => setTab(name)} onKeyDown={(event) => { let next = index; if (event.key === "ArrowRight") next = (index + 1) % tabs.length; else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length; else if (event.key === "Home") next = 0; else if (event.key === "End") next = tabs.length - 1; else return; event.preventDefault(); const nextTab = tabs[next]!; setTab(nextTab); document.getElementById(`audit-tab-${detail.attempt.id}-${nextTab}`)?.focus(); }}>{name === "application" ? "Application result" : name[0]!.toUpperCase() + name.slice(1)}</button>)}
    </div>
    <div role="tabpanel" id={panelId} aria-labelledby={`audit-tab-${detail.attempt.id}-${tab}`}>
      {tab === "application" ? detail.application.length === 0 ? <p className="audit-no-result">No correlated application result was recorded.</p> : <div className="audit-results">{detail.application.map((record) => { const focusedResult = revealToolResult && record.kind === "tool"; const focusedConsent = focusedResult ? consentResultText(record.bodyText) : null; return <details key={record.id} open={focusedResult || undefined} data-focused-application-result={focusedResult ? "true" : undefined}><summary><strong>{record.label}</strong><span>{record.outcome}</span><span>{new Date(record.occurredAt).toLocaleTimeString()}</span></summary>{focusedConsent !== null && <p className="audit-focused-result" data-focused-consent-result="true">{focusedConsent}</p>}<div className="audit-result-refs">{record.requestId !== null && <span>Request {record.requestId}</span>}{record.turnId !== null && <span>Turn {record.turnId}</span>}{record.proposalId !== null && <span>Proposal {record.proposalId}</span>}{record.receiptId !== null && <span>Receipt {record.receiptId}</span>}</div><pre>{record.bodyText}</pre></details>; })}{detail.applicationNextCursor !== null && <Button variant="quiet" onClick={() => loadMore(detail.attempt.id, detail.applicationNextCursor!)}>Load earlier results</Button>}</div> : <pre>{selectedText}</pre>}
    </div>
  </div>;
}

function AuditView({ page, details, loading, error, revision, connected, focusedAttemptId, onFocusedAttemptRendered, requestPage, requestDetail }: {
  page: AuditPage | null;
  details: Readonly<Record<string, AuditAttemptDetail>>;
  loading: boolean;
  error: string | null;
  revision: number;
  connected: boolean;
  focusedAttemptId: string | null;
  onFocusedAttemptRendered: (attemptId: string) => void;
  requestPage: (query: string, cursor?: string | null, appendAttempts?: boolean, markerCursor?: string | null, appendMarkers?: boolean) => void;
  requestDetail: (attemptId: string, applicationCursor?: string | null, append?: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<AuditTab>("request");
  const acknowledgedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (focusedAttemptId === null) return;
    acknowledgedFocus.current = null;
    setQuery(focusedAttemptId);
    setOpenId(focusedAttemptId);
    setTab("application");
    if (connected && details[focusedAttemptId] === undefined) requestDetail(focusedAttemptId);
  }, [focusedAttemptId]);
  useEffect(() => {
    if (!connected) return;
    const timer = window.setTimeout(() => requestPage(query), 180);
    return () => window.clearTimeout(timer);
  }, [query, revision, connected, requestPage]);
  useEffect(() => {
    if (connected && openId !== null) requestDetail(openId);
  }, [revision, connected]);
  useEffect(() => {
    if (focusedAttemptId === null || acknowledgedFocus.current === focusedAttemptId || details[focusedAttemptId] === undefined || !page?.attempts.some((attempt) => attempt.id === focusedAttemptId)) return;
    let cancelled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const detail = document.getElementById(`audit-detail-${focusedAttemptId}`);
      const visibleResult = detail?.querySelector('[data-focused-consent-result="true"]');
      const openResult = visibleResult?.closest('details[data-focused-application-result="true"][open]');
      if (cancelled || !(visibleResult instanceof HTMLElement) || openResult === null || openResult === undefined || visibleResult.getClientRects().length === 0) return;
      acknowledgedFocus.current = focusedAttemptId;
      onFocusedAttemptRendered(focusedAttemptId);
    }));
    return () => { cancelled = true; };
  }, [focusedAttemptId, details, page?.attempts, onFocusedAttemptRendered]);
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
      <label className="audit-filter"><span aria-hidden="true">⌕</span><span className="sr-only">Search audit history</span><input type="search" value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} placeholder="Filter requests..." autoComplete="off" />{query.length > 0 && <Button variant="icon" aria-label="Clear audit search" onClick={() => setQuery("")}>×</Button>}</label>
      <span className="audit-count" aria-live="polite">{page === null ? "Loading requests" : query.trim().length > 0 ? `${page.total} matching ${page.total === 1 ? "request" : "requests"}` : `${page.total} ${page.total === 1 ? "request" : "requests"}`}</span>
    </div>
    {error !== null && <p className="audit-load-error" role="alert">{error}</p>}
    {page !== null && page.markers.length > 0 && <div className="audit-markers" aria-label="Reset history">{page.markers.map((marker) => <details key={marker.id} data-reset-id={marker.id}><summary><span>Workspace reset</span><span>{new Date(marker.occurredAt).toLocaleString()}</span></summary><pre>{marker.bodyText}</pre></details>)}{page.markerNextCursor !== null && <div className="audit-more"><Button variant="quiet" disabled={loading} onClick={() => requestPage(query, null, false, page.markerNextCursor, true)}>{loading ? "Loading…" : "Load earlier resets"}</Button></div>}</div>}
    {visible.length === 0 && !loading ? <div className="audit-empty">{query.trim().length > 0 ? <>No requests match this filter. <Button variant="link" onClick={() => setQuery("")}>Clear search</Button></> : "No inference attempts have been recorded yet."}</div> : <div className="audit-scroll"><table className="audit-table" aria-label="Inference requests"><colgroup><col className="audit-col-time" /><col /><col className="audit-col-model" /><col className="audit-col-outcome" /><col className="audit-col-duration" /><col className="audit-col-tokens" /><col className="audit-col-cost" /></colgroup><thead><tr><th scope="col">At</th><th scope="col">Request</th><th scope="col">Model</th><th scope="col">Outcome</th><th scope="col" className="audit-number">Duration</th><th scope="col" className="audit-number">Tokens</th><th scope="col" className="audit-number">Cost</th></tr></thead><tbody>{visible.map((attempt) => {
      const expanded = openId === attempt.id;
      return <Fragment key={attempt.id}><tr className={`audit-summary${expanded ? " audit-summary-open" : ""}`} data-attempt-id={attempt.id}><td>{new Date(attempt.startedAt).toLocaleTimeString([], { hour12: false })}</td><td><button type="button" className="audit-expand" aria-expanded={expanded} aria-controls={`audit-detail-${attempt.id}`} onClick={() => open(attempt.id)}><span aria-hidden="true">{expanded ? "⌄" : "›"}</span><span>{attempt.requestLabel}</span></button></td><td><span>{modelText(attempt)}</span>{attempt.mode === "scripted" && <small>Fixture</small>}</td><td className={`audit-outcome audit-outcome-${attempt.outcome}`}>{outcomeText[attempt.outcome]}</td><td className="audit-number">{durationText(attempt.durationMs)}</td><td className="audit-number">{tokenText(attempt)}</td><td className="audit-number">{costText(attempt)}</td></tr>{expanded && <tr><td colSpan={7} className="audit-detail-cell"><AuditDetails detail={details[attempt.id] ?? null} tab={tab} setTab={setTab} loadMore={(attemptId, cursor) => requestDetail(attemptId, cursor, true)} filterTurn={(turnId) => setQuery(turnId)} revealToolResult={focusedAttemptId === attempt.id} /></td></tr>}</Fragment>;
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
  const [scenarioNotice, setScenarioNotice] = useState<ScenarioNotice | null>(null);
  const [auditFocus, setAuditFocus] = useState<{ readonly attemptId: string; readonly turnId: string; readonly generation: number; readonly acknowledge: boolean } | null>(null);
  const { snapshot, status, toolCatalogue, runCommand, runExploreScenario, sendAgentMessage, cancelAgentTurn, agentOperation, acknowledgeAgentOperation, acknowledgeAgentComplete, acknowledgeCommandVisible, agentError, auditPage, auditDetails, auditLoading, auditError, auditRevision, requestAudit, requestAuditDetail } = useWorkspace();
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
  const advanceFromExplore = async () => {
    setScenarioNotice({ scenario: "batch", message: "Advancing the stock case without inference…", offerReset: false });
    const result = await perform(() => runCommand({ type: "advance_scenario", scenario: "stock_change" }));
    if (result?.kind === "scenario") setScenarioNotice({ scenario: "batch", message: result.message, offerReset: false });
    else if (result === null) setScenarioNotice({ scenario: "batch", message: "This stock case has no further step. Prepare a reset to restore it.", offerReset: true });
  };
  const launchExploreScenario = async (scenarioId: ExploreScenarioId) => {
    if (snapshot === null) return;
    setError(null);
    if (scenarioId === "learn") {
      const address = snapshot.orders.find((order) => order.id === "BB-1042");
      if (address === undefined || address.status !== "review") {
        setScenarioNotice({ scenario: scenarioId, message: "BB-1042 has already moved past its address review. Prepare a reset to practise the approved walkthrough again.", offerReset: true });
        return;
      }
    }
    if (scenarioId === "batch" && !snapshot.orders.some((order) => order.status === "ready")) {
      setScenarioNotice({ scenario: scenarioId, message: "There are no ready orders left to review. Prepare a reset to restore the example queue.", offerReset: true });
      return;
    }
    setScenarioNotice({ scenario: scenarioId, message: scenarioId === "consent" ? "Checking the selected customer evidence…" : "Opening this scenario in Work…", offerReset: false });
    if (scenarioId === "consent") {
      const result = await perform(runExploreScenario);
      if (result?.kind !== "explore") {
        if (result === null) setScenarioNotice({ scenario: scenarioId, message: "The consent check did not complete. Its recorded failure remains available in Audit.", offerReset: false });
        return;
      }
      setScenarioNotice({ scenario: scenarioId, message: result.message, offerReset: false });
      setAuditFocus({ attemptId: result.attemptId, turnId: result.turnId, generation: snapshot.generation, acknowledge: result.outcome === "completed" });
      setView("audit");
      return;
    }
    const selected = exploreScenarios.find((candidate) => candidate.id === scenarioId);
    if (selected === undefined) return;
    setView("work");
    sendAgentMessage(selected.prompt, { view: "explore", focus: null });
  };
  const prepareExploreReset = async () => {
    setView("work");
    await showProposal(() => runCommand({ type: "prepare_reset" }));
  };
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

  return <div className="app-shell"><header className="topbar"><div className="brand"><BrandIcon /> <span>Bracken &amp; Beam</span></div><span className={`connection connection-${status}`} data-testid="connection-status"><span aria-hidden="true" />{connectionText[status]}</span><nav aria-label="Main navigation">{(["work", "explore", "audit"] as const).map((item) => <Button key={item} variant="quiet" aria-current={view === item ? "page" : undefined} onClick={() => { setView(item); setAuditFocus(null); }}>{item[0]!.toUpperCase() + item.slice(1)}</Button>)}</nav></header>
    {view === "work" ? <main className="work-layout" data-view="work">{snapshot === null ? <section className="work-panel loading-panel" aria-live="polite"><h1>Decisions</h1><p>{status === "offline" ? "Reconnect to load your workspace." : "Loading your workspace…"}</p></section> : proposal !== null ? <ProposalView proposal={proposal} orders={snapshot.orders} busy={busy} connected={status === "connected"} onAccept={accept} onCancel={() => { setProposal(null); setSelectedOrderId(null); }} coach={coach} /> : receipt !== null ? <ReceiptView receipt={receipt} busy={busy} connected={status === "connected"} onBack={() => void confirmReceiptAndBack()} onUndo={undo} coach={coach} /> : <WorkQueue orders={snapshot.orders} latestReceipt={snapshot.latestReceipt} tutorialReceipt={snapshot.tutorialReceipt} savedProposal={snapshot.currentProposal} tutorialProposal={snapshot.tutorialProposal} connected={status === "connected" && !busy} selectedOrderId={selectedOrderId} selectOrder={(orderId) => { setSelectedOrderId(orderId); if (orderId !== null) void reportTutorialAction({ action: "order_selected", orderId }); }} prepare={(orderId) => void showProposal(() => runCommand({ type: "prepare_resolution", orderId }))} prepareBatch={() => void showProposal(() => runCommand({ type: "prepare_batch" }))} prepareReset={() => void showProposal(() => runCommand({ type: "prepare_reset" }))} advance={() => void advance()} openReceipt={() => setReceipt(snapshot.latestReceipt)} openTutorialReceipt={() => setReceipt(snapshot.tutorialReceipt)} openSavedProposal={() => setProposal(snapshot.currentProposal)} openTutorialProposal={() => setProposal(snapshot.tutorialProposal)} selectReady={() => { void reportTutorialAction({ action: "ready_filter_selected" }); }} coach={coach} />}{snapshot !== null && <ChatPanel snapshot={snapshot} connected={status === "connected"} onSend={(message) => { try { const context: AgentViewContext = proposal !== null ? { view: "work", focus: { kind: "proposal", proposalId: proposal.id } } : receipt !== null ? { view: "work", focus: { kind: "receipt", receiptId: receipt.id } } : selectedOrderId !== null ? { view: "work", focus: { kind: "order", orderId: selectedOrderId } } : { view, focus: null }; sendAgentMessage(message, context); } catch (cause) { setError(cause instanceof Error ? cause.message : "The message could not be sent."); } }} onCancel={cancelAgentTurn} error={agentError} />}{error !== null && <div className="command-message" role="status">{error}</div>}</main> : view === "explore" ? <div data-view="explore"><ExploreView entries={toolCatalogue} connected={status === "connected" && snapshot !== null && snapshot.activeTurn === null} busy={busy} scenarioActive={snapshot?.activeTurn !== null && snapshot?.activeTurn !== undefined} notice={scenarioNotice} runScenario={(scenario) => void launchExploreScenario(scenario)} cancelScenario={cancelAgentTurn} prepareReset={() => void prepareExploreReset()} advanceScenario={() => void advanceFromExplore()} />{coach}</div> : <div data-view="audit"><AuditView page={auditPage} details={auditDetails} loading={auditLoading} error={auditError} revision={auditRevision} connected={status === "connected"} focusedAttemptId={auditFocus?.attemptId ?? null} onFocusedAttemptRendered={(attemptId) => { if (auditFocus?.attemptId === attemptId && auditFocus.acknowledge) acknowledgeAgentComplete(auditFocus.turnId, auditFocus.generation); }} requestPage={requestAudit} requestDetail={requestAuditDetail} />{coach}</div>}
  </div>;
}
