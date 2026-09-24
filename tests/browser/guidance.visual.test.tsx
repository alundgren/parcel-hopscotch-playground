import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi, type TestContext } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import "../../src/client/styles.css";
import type { CommandResult, ReviewedProposal } from "../../src/shared/contracts";
import { WorkspaceRequestError } from "../../src/client/use-workspace";
import { GuideTargetRegistry } from "../../src/client/guidance/targets";
import { GuideDisplay } from "../../src/client/guidance/GuideDisplay";
import { createGuidanceContext } from "../../src/modules/guidance";
import { addressProposal, auditDetail, auditPage, completedAttempt, createWorkspace, proposal, receipt, snapshot } from "./fixtures";

const workspaceState = vi.hoisted(() => ({ current: null as ReturnType<typeof createWorkspace> | null }));
vi.mock("../../src/client/use-workspace", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/client/use-workspace")>()), useWorkspace: () => workspaceState.current }));
import App from "../../src/client/App";

declare module "vite-plus/test/browser" {
  interface BrowserCommands { captureViewport(relativePath: string): Promise<string> }
}

let testContext: TestContext;
beforeEach((context) => { testContext = context; sessionStorage.clear(); workspaceState.current = createWorkspace(); });
afterEach(() => vi.restoreAllMocks());

const checkpoint = async (name: string) => {
  if (import.meta.env.VISUAL_PROOF !== "true") return;
  await document.fonts.ready;
  await Promise.all([...document.images].map((image) => image.decode()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const project = window.innerWidth <= 400 ? "browser-narrow" : "browser-desktop";
  const file = `${project}/${project}-${window.innerWidth}x${window.innerHeight}-${name}.png`;
  await page.mark(name);
  await commands.captureViewport(file);
  await testContext.annotate(name, "visual-proof", { path: `artifacts/visual/screenshots/${file}`, contentType: "image/png" });
};

const withinViewport = (element: Element) => {
  const rect = element.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
};
const overlapArea = (left: Element, right: Element) => {
  const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
};

const contrast = (foreground: string, background: string) => {
  const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const light = (value: string) => {
    const [red, green, blue] = rgb(value).map((channel) => { const x = channel / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const a = light(foreground), b = light(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test("stale review offers consent, marks the real order action, and preserves the ready filter on return", async () => {
  const observed = vi.spyOn(GuideTargetRegistry.prototype, "visibleTargetIds");
  const fresh: ReviewedProposal = { ...addressProposal, id: "fresh-1076", title: "Review replacement", changes: [{ ...proposal.changes[0]!, orderId: "BB-1076" }] };
  let acceptance = 0;
  const runCommand = vi.fn(async (input: { readonly type: string }): Promise<CommandResult> => {
    if (input.type === "prepare_batch") return { kind: "proposal", proposal };
    if (input.type === "prepare_resolution") return { kind: "proposal", proposal: fresh };
    if (input.type === "accept_proposal" && acceptance++ === 0) throw new WorkspaceRequestError("stale_proposal", "Nothing was applied. The review is out of date.", { kind: "stale_review", proposalId: proposal.id, orderId: "BB-1076", reason: "stock_changed", expectedVersion: 2, currentVersion: 3, resolved: false });
    if (input.type === "accept_proposal") return { kind: "receipt", receipt: { ...receipt, proposalId: fresh.id, changes: fresh.changes } };
    return { kind: "scenario", message: "Scenario advanced." };
  });
  workspaceState.current = createWorkspace({ snapshot: { ...snapshot, currentProposal: null }, runCommand });
  const app = await render(<App />);
  await page.getByRole("button", { name: /^Ready / }).click();
  await expect.element(page.getByRole("button", { name: /^Ready / })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Review ready orders" }).click();
  await page.getByRole("button", { name: "Accept 1 change" }).click();
  await expect.element(page.getByRole("complementary", { name: "Task trail" })).toHaveAttribute("data-guidance-status", "offered");
  await expect.element(page.getByRole("button", { name: "Show me" })).toBeVisible();
  await checkpoint("guidance-offer");
  await page.getByRole("textbox", { name: "Message" }).fill("Why was the review rejected?");
  await page.getByRole("button", { name: "Send message" }).click();
  expect(workspaceState.current!.sendAgentMessage).toHaveBeenCalledOnce();

  await page.getByRole("button", { name: "Show me" }).click();
  await expect.element(page.getByRole("complementary", { name: "Notes on work" })).toBeVisible();
  const action = page.getByRole("button", { name: "Review change" }).element();
  const outline = document.querySelector(".guide-outline")!;
  const target = action.getBoundingClientRect(), marked = outline.getBoundingClientRect();
  expect(action).not.toBeDisabled();
  expect(marked.left).toBeLessThan(target.left);
  expect(marked.right).toBeGreaterThan(target.right);
  expect(marked.top).toBeLessThan(target.top);
  expect(marked.bottom).toBeGreaterThan(target.bottom);
  const note = document.querySelector(".work-note")!;
  expect(note.textContent).toContain("Current");
  expect(contrast(getComputedStyle(note).color, getComputedStyle(note).backgroundColor)).toBeGreaterThanOrEqual(4.5);
  withinViewport(note);
  withinViewport(document.querySelector(".task-trail")!);
  const composer = document.querySelector(".composer")!;
  expect(overlapArea(document.querySelector(".task-trail")!, composer)).toBe(0);
  expect(overlapArea(note, composer)).toBe(0);
  expect(overlapArea(note, document.querySelector(".evidence")!)).toBe(0);
  expect(overlapArea(note, document.querySelector(".detail-current")!)).toBe(0);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await checkpoint("guidance-note-and-trail");

  expect(action).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("complementary", { name: "Task trail" })).toHaveAttribute("data-guidance-status", "paused");
  page.getByRole("button", { name: "Resume", exact: true }).element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("complementary", { name: "Task trail" })).toHaveAttribute("data-guidance-status", "active");

  await page.getByRole("textbox", { name: "Message" }).fill("Explain the marked action.");
  await page.getByRole("button", { name: "Send message" }).click();
  const context = createGuidanceContext({
    snapshot: workspaceState.current!.snapshot!,
    location: { view: "work", focus: { kind: "order", orderId: "BB-1076" } },
    problem: { kind: "stale_review", proposalId: proposal.id, orderId: "BB-1076", reason: "stock_changed", expectedVersion: 2, currentVersion: 3, resolved: false },
    observedTargetIds: observed.mock.results.at(-1)!.value,
  });
  const noteOperation = { id: "note-current-action", turnId: "turn-new", generation: snapshot.generation, kind: "show_note" as const, contextRef: context.publicContext.contextRef, note: { targetRef: context.publicContext.targets.find((target) => target.label === "Review change")!.targetRef, targetId: "work.order.review:BB-1076", entityId: "BB-1076", text: "Read the proposed replacement before accepting it." } };
  workspaceState.current = { ...workspaceState.current!, agentOperation: noteOperation };
  await app.rerender(<App />);
  await expect.element(page.getByText(noteOperation.note.text, { exact: true })).toBeVisible();
  expect(workspaceState.current.acknowledgeAgentOperation).toHaveBeenCalledWith(noteOperation, "applied", expect.anything());
  workspaceState.current = { ...workspaceState.current, agentOperation: null };
  observed.mockRestore();

  await page.getByRole("button", { name: "Review change" }).click();
  await expect.element(page.getByRole("heading", { name: "Review replacement" })).toBeVisible();
  await expect.element(page.getByRole("complementary", { name: "Task trail" })).toHaveAttribute("data-guidance-step", "2");
  const accept = page.getByRole("button", { name: "Accept 1 change", exact: true }).element().getBoundingClientRect();
  const acceptOutline = document.querySelector(".guide-outline")!.getBoundingClientRect();
  expect(acceptOutline.left).toBeLessThan(accept.left);
  expect(acceptOutline.right).toBeGreaterThan(accept.right);
  expect(acceptOutline.height).toBeLessThan(accept.height + 12);
  if (window.innerWidth > 760) {
    const actionNote = document.querySelector(".work-note")!.getBoundingClientRect();
    expect(actionNote.top - accept.bottom).toBeGreaterThanOrEqual(0);
    expect(actionNote.top - accept.bottom).toBeLessThan(32);
  }
  await checkpoint("guidance-fresh-review");
  await page.getByRole("button", { name: "Accept 1 change" }).click();
  await expect.element(page.getByRole("heading", { name: "One change saved" })).toBeVisible();
  await page.getByRole("button", { name: "Return to work" }).click();
  await expect.element(page.getByRole("button", { name: /^Ready / })).toHaveAttribute("aria-pressed", "true");
  await expect.element(page.getByRole("button", { name: "Review ready orders" })).toBeVisible();
  expect(runCommand.mock.calls.filter(([input]) => input.type === "prepare_batch")).toHaveLength(1);
  await checkpoint("guidance-returned-queue");
});

test("a missing or differently bound target gives recovery text without marking another item", async () => {
  const registry = new GuideTargetRegistry();
  const dismiss = vi.fn();
  const element = document.createElement("button");
  element.textContent = "Another item's action";
  document.body.append(element);
  registry.register("work.order.review:BB-1076", "BB-1042", element, true);
  try {
    await render(<GuideDisplay registry={registry} targetId="work.order.review:BB-1076" entityId="BB-1076" title="Review the item" note="Read the current evidence." progress="2 of 4" step={1} phase="active" onPause={vi.fn()} onResume={vi.fn()} onDismiss={dismiss} />);
    await expect.element(page.getByText("The marked area is not on screen yet.", { exact: false })).toBeVisible();
    expect(document.querySelector(".guide-outline")).toBeNull();
    expect(document.querySelector(".work-note")).toBeNull();
    await checkpoint("guidance-missing-target");
    await page.getByRole("button", { name: "Dismiss guide" }).click();
    expect(dismiss).toHaveBeenCalledOnce();
  } finally { element.remove(); }
});

test("busy and held actions report the same disabled state as the rendered control", async () => {
  const registrations = vi.spyOn(GuideTargetRegistry.prototype, "register");
  const problem = { kind: "stale_review" as const, proposalId: proposal.id, orderId: "BB-1076", reason: "stock_changed" as const, expectedVersion: 2, currentVersion: 3, resolved: false };
  const held: ReviewedProposal = { ...addressProposal, id: "held-1076", title: "Review replacement", ready: false, changes: [{ ...proposal.changes[0]!, orderId: "BB-1076" }] };
  let finishReview: (() => void) | undefined;
  const runCommand = vi.fn(async (input: { readonly type: string }): Promise<CommandResult> => {
    if (input.type === "prepare_batch") return { kind: "proposal", proposal };
    if (input.type === "accept_proposal") throw new WorkspaceRequestError("stale_proposal", "Nothing was applied.", problem);
    if (input.type === "prepare_resolution") return new Promise((resolve) => { finishReview = () => {
      workspaceState.current = { ...workspaceState.current!, snapshot: { ...snapshot, currentProposal: held } };
      resolve({ kind: "proposal", proposal: held });
    }; });
    return { kind: "scenario", message: "Scenario advanced." };
  });
  workspaceState.current = createWorkspace({ snapshot: { ...snapshot, currentProposal: null }, runCommand });
  await render(<App />);
  await page.getByRole("button", { name: "Review ready orders" }).click();
  await page.getByRole("button", { name: "Accept 1 change" }).click();
  await page.getByRole("button", { name: "Show me" }).click();
  await page.getByRole("button", { name: "Review change", exact: true }).click();
  try {
    await expect.element(page.getByRole("button", { name: "Review change", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "Message" }).fill("Which action is available?");
    await page.getByRole("button", { name: "Send message" }).click();
    const location = workspaceState.current.sendAgentMessage.mock.calls.at(-1)![1];
    expect(location.guidance?.disabledTargetIds).toContain("work.order.review:BB-1076");
    const context = createGuidanceContext({ snapshot: workspaceState.current.snapshot!, location, problem, observedTargetIds: location.guidance?.visibleTargetIds, disabledTargetIds: location.guidance?.disabledTargetIds });
    expect(context.publicContext.targets.find((target) => target.label === "Review change")?.availability.available).toBe(false);
    expect(registrations.mock.calls.filter(([id, , element]) => id === "work.order.review:BB-1076" && element !== null).at(-1)?.[3]).toBe(false);
  } finally { finishReview?.(); }
  await expect.element(page.getByRole("button", { name: "Held", exact: true })).toBeDisabled();
  expect(registrations.mock.calls.filter(([id, , element]) => id === "work.proposal.review:BB-1076" && element !== null).at(-1)?.[3]).toBe(false);
  await page.getByRole("textbox", { name: "Message" }).fill("Explain this held proposal.");
  await page.getByRole("button", { name: "Send message" }).click();
  const location = workspaceState.current.sendAgentMessage.mock.calls.at(-1)![1];
  const context = createGuidanceContext({ snapshot: workspaceState.current.snapshot!, location, presentedProposal: held, problem, observedTargetIds: location.guidance?.visibleTargetIds, disabledTargetIds: location.guidance?.disabledTargetIds });
  expect(context.publicContext.targets.find((target) => target.label === "Fresh proposal review")?.availability).toEqual({ available: false, reason: "This proposal is held and cannot be accepted." });
});

test("Audit guide explains an empty result area without claiming a result", async () => {
  workspaceState.current = createWorkspace({ auditPage: { ...auditPage, requests: [], attempts: [], total: 0 } });
  await render(<App />);
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await page.getByRole("button", { name: "Explain Audit" }).click();
  await expect.element(page.getByRole("button", { name: "Show me" })).toBeVisible();
  await page.getByRole("button", { name: "Show me" }).click();
  await expect.element(page.getByRole("complementary", { name: "Task trail" })).toHaveAttribute("data-guidance-step", "1");
  await expect.element(page.getByRole("complementary", { name: "Notes on work" })).toBeVisible();
  expect(document.querySelector(".work-note")?.textContent?.toLowerCase()).toContain("no recorded request");
  expect(document.querySelector(".audit-empty")).toBeTruthy();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await checkpoint("guidance-audit-empty");
});

test("Audit guide waits for a rendered Application result", async () => {
  await render(<App />);
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await page.getByRole("button", { name: "Explain Audit" }).click();
  await page.getByRole("button", { name: "Show me" }).click();
  const trail = page.getByRole("complementary", { name: "Task trail" });
  await expect.element(trail).toHaveAttribute("data-guidance-step", "1");
  await page.getByRole("button", { name: /Summarise the ready orders/ }).click();
  await expect.element(trail).toHaveAttribute("data-guidance-status", "active");
  await page.getByRole("button", { name: /Turn 1 · Chat/ }).click();
  await expect.element(trail).toHaveAttribute("data-guidance-step", "1");
  await page.getByRole("tab", { name: "Application result" }).click();
  await expect.element(trail).toHaveAttribute("data-guidance-status", "complete");
  await checkpoint("guidance-audit-result");
});

test.each(["empty", "unrelated"] as const)("Audit guide does not complete for an %s result panel", async (kind) => {
  workspaceState.current = createWorkspace({ auditDetails: { [completedAttempt.id]: { ...auditDetail, application: kind === "empty" ? [] : auditDetail.application.map((record) => ({ ...record, requestId: "other-request", turnId: "other-turn" })) } } });
  await render(<App />);
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await page.getByRole("button", { name: "Explain Audit" }).click();
  await page.getByRole("button", { name: "Show me" }).click();
  await page.getByRole("button", { name: /Summarise the ready orders/ }).click();
  await page.getByRole("button", { name: /Turn 1 · Chat/ }).click();
  await page.getByRole("tab", { name: "Application result" }).click();
  if (kind === "empty") await expect.element(page.getByText("No correlated application result was recorded.")).toBeVisible();
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await expect.element(page.getByRole("complementary", { name: "Task trail" })).toHaveAttribute("data-guidance-status", "active");
  const note = document.querySelector(".work-note")!;
  expect(overlapArea(note, document.querySelector(".topbar")!)).toBe(0);
  expect(overlapArea(note, page.getByRole("searchbox").element())).toBe(0);
  if (kind === "empty") await checkpoint("guidance-audit-no-result");
});

test("a pending batch does not replace a new individual receipt", async () => {
  const initial = { ...snapshot, currentProposal: proposal };
  const fresh = { ...addressProposal, id: "fresh-address" };
  workspaceState.current = createWorkspace({ snapshot: initial, runCommand: vi.fn(async (input: { readonly type: string }): Promise<CommandResult> => {
    if (input.type === "prepare_resolution") {
      workspaceState.current = createWorkspace({ snapshot: { ...initial, currentProposal: { ...proposal, id: "pending-batch-from-other-tab" } }, runCommand: workspaceState.current!.runCommand });
      return { kind: "proposal", proposal: fresh };
    }
    if (input.type === "accept_proposal") return { kind: "receipt", receipt: { ...receipt, proposalId: fresh.id, changes: fresh.changes } };
    return { kind: "scenario", message: "Scenario advanced." };
  }) });
  await render(<App />);
  await expect.element(page.getByRole("heading", { name: "Review ready orders" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: /BB-1042/ }).click();
  await page.getByRole("button", { name: "Review change" }).click();
  await expect.element(page.getByRole("heading", { name: "Check address" })).toBeVisible();
  await page.getByRole("button", { name: "Accept 1 change" }).click();
  await expect.element(page.getByRole("heading", { name: "One change saved" })).toBeVisible();
});
