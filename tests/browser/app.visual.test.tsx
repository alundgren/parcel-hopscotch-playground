import { render } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, test, vi, type TestContext } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import "../../src/client/styles.css";
import { addressProposal, groupedAuditPage, auditPage, createWorkspace, proposal, receipt, snapshot } from "./fixtures";

const workspaceState = vi.hoisted(() => ({ current: null as ReturnType<typeof createWorkspace> | null }));
vi.mock("../../src/client/use-workspace", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/client/use-workspace")>()), useWorkspace: () => workspaceState.current }));

import App from "../../src/client/App";
import { describeProposalReview, workOperatorGuide } from "../../src/modules/work";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    captureViewport(relativePath: string): Promise<string>;
  }
}

let testContext: TestContext;

const settleVisuals = async () => {
  await document.fonts.ready;
  await Promise.all(Array.from(document.images, async (image) => {
    if (!image.complete) await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error(`Image failed to load: ${image.currentSrc || image.src}`)), { once: true });
    });
    await image.decode();
  }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
};

const checkpoint = async (name: string, focus?: Element) => {
  if (import.meta.env.VISUAL_PROOF !== "true") return;
  if (focus === undefined) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  else focus.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
  await settleVisuals();
  const project = window.innerWidth <= 400 ? "browser-narrow" : "browser-desktop";
  const checkpointName = `${project}-${window.innerWidth}x${window.innerHeight}-${name}`;
  const relativePath = `${project}/${checkpointName}.png`;
  await page.mark(checkpointName);
  await commands.captureViewport(relativePath);
  await testContext.annotate(checkpointName, "visual-proof", { path: `artifacts/visual/screenshots/${relativePath}`, contentType: "image/png" });
};

const bounds = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
};

const expectInside = (child: Element, parent: Element, tolerance = 1) => {
  const inner = bounds(child);
  const outer = bounds(parent);
  expect(inner.left).toBeGreaterThanOrEqual(outer.left - tolerance);
  expect(inner.right).toBeLessThanOrEqual(outer.right + tolerance);
  expect(inner.top).toBeGreaterThanOrEqual(outer.top - tolerance);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + tolerance);
};

const expectInViewport = (element: Element) => {
  const rect = bounds(element);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
};

const expectNotClipped = (element: Element) => {
  const node = element as HTMLElement;
  expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
  expect(node.scrollHeight).toBeLessThanOrEqual(node.clientHeight + 1);
};

const overlapArea = (first: Element, second: Element) => {
  const a = bounds(first);
  const b = bounds(second);
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
};

const expectNoOverlap = (first: Element, second: Element) => expect(overlapArea(first, second)).toBe(0);

const srgb = (value: number) => {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

const parseRgb = (value: string): [number, number, number, number] => {
  const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
};

const opaqueBackground = (element: Element): [number, number, number] => {
  let current: Element | null = element;
  while (current !== null) {
    const [red, green, blue, alpha] = parseRgb(getComputedStyle(current).backgroundColor);
    if (alpha > 0.98) return [red, green, blue];
    current = current.parentElement;
  }
  return [255, 255, 255];
};

const contrast = (element: Element) => {
  const [foregroundRed, foregroundGreen, foregroundBlue] = parseRgb(getComputedStyle(element).color);
  const [backgroundRed, backgroundGreen, backgroundBlue] = opaqueBackground(element);
  const luminance = ([red, green, blue]: number[]) => 0.2126 * srgb(red!) + 0.7152 * srgb(green!) + 0.0722 * srgb(blue!);
  const foreground = luminance([foregroundRed, foregroundGreen, foregroundBlue]);
  const background = luminance([backgroundRed, backgroundGreen, backgroundBlue]);
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
};

const expectReadable = (element: Element, minimum = 4.5) => expect(contrast(element)).toBeGreaterThanOrEqual(minimum);

const readingSample = `I can help you inspect orders, prepare reviews, and learn the workflows.

> You review and accept each change before it is saved.

### Find what needs attention
Start in Work, then open an order for its recorded evidence.
- Read the queue: See Ready, Review, and Waiting orders.
- Inspect an order: Open an order such as \`BB-1042\` to read its current details and customer note.

### Prepare a review
Every proposed change needs your review before acceptance.
- Correct an address: Use Review change and compare the before and after values with the recorded evidence.
- Review a substitution: Check the replacement, stock, and consent. A held preview cannot be accepted.
- Release a batch: Review ready orders includes all currently eligible Ready orders. Accepting that separate batch releases them to packing.

### Learn a workflow
You can ask for an explanation or choose a specific walkthrough.
- Address correction: Learn how to inspect evidence and review the proposed correction.
- Batch review: Learn how to check included orders and exclusions before accepting the whole batch.

### Check and undo
After acceptance, check the receipt and the saved change.
- Inspect Audit: See recorded requests, tokens, and costs.
- Undo: When available, review and accept a checked reversal of the whole receipt. Later changes can make Undo unavailable.`;

const readingChat: typeof snapshot.chat = [
  { ...snapshot.chat[1]!, content: "What can you help me do here?" },
  { ...snapshot.chat[0]!, content: readingSample },
];

beforeEach((context) => {
  testContext = context;
  workspaceState.current = createWorkspace();
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});

describe("rendered work UI", () => {
  test("renders the maintained operator introduction with readable app language", async () => {
    workspaceState.current = createWorkspace({ snapshot: { ...snapshot, latestReceipt: null, chat: [{ ...snapshot.chat[0]!, content: workOperatorGuide }] } });
    await render(<App />);
    const assistant = document.querySelector(".chat-assistant")!;
    for (const phrase of ["Start in Work", "evidence", "Review change", "Accept or Cancel", "Review ready orders", "whole receipt"]) expect(assistant.textContent).toContain(phrase);
    expect(assistant.textContent).not.toMatch(/listOrders|getOrder|prepareBatch|startTutorial/);
    expectReadable(assistant);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    document.querySelector<HTMLElement>(".chat-messages")!.scrollTop = 0;
    await checkpoint("agent-operator-introduction", document.querySelector(".chat-panel")!);
  });

  test.each(["resolution", "batch", "held"] as const)("renders the %s acknowledgement alongside the actual review controls", async (kind) => {
    const currentProposal = kind === "resolution" ? addressProposal : kind === "batch" ? proposal : {
      ...addressProposal, ready: false, changes: [], omissions: [{ orderId: "BB-1042", reason: "The recorded address evidence needs review." }],
    };
    workspaceState.current = createWorkspace({ snapshot: { ...snapshot, latestReceipt: null, currentProposal, chat: [{ ...snapshot.chat[0]!, content: describeProposalReview(currentProposal) }] } });
    await render(<App />);
    const assistant = document.querySelector(".chat-assistant")!;
    if (kind === "held") {
      await expect.element(page.getByRole("button", { name: "Held" })).toBeDisabled();
      expect(assistant.textContent).toContain("cannot be accepted");
    } else {
      const accept = page.getByRole("button", { name: "Accept 1 change", exact: true }).element() as HTMLButtonElement;
      expect(accept.disabled).toBe(false);
      expectReadable(accept);
      expectNotClipped(accept);
      expect(assistant.textContent).toContain("Nothing changes until you accept it in the app");
    }
    expectReadable(assistant);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await checkpoint(`agent-${kind}-acknowledgement`, document.querySelector(".chat-panel")!);
  });

  test("renders the prototype answer and keeps draft, work, and reading position while widening", async () => {
    workspaceState.current = createWorkspace({ snapshot: { ...snapshot, chat: readingChat } });
    await render(<App />);
    const layout = document.querySelector(".work-layout")!;
    const chat = document.querySelector(".chat-panel")!;
    const work = document.querySelector(".work-panel")!;
    const list = document.querySelector<HTMLElement>(".chat-messages")!;
    const widthButton = page.getByRole("button", { name: "Widen chat" });
    const assistant = document.querySelector(".chat-assistant")!;
    await expect.element(page.getByText("Find what needs attention", { exact: true })).toBeVisible();
    expect(assistant.querySelector("h3")?.textContent).toBe("Find what needs attention");
    expect(assistant.querySelector("code")?.textContent).toBe("BB-1042");
    expect(assistant.querySelectorAll("li").length).toBe(9);
    expectReadable(assistant);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    list.scrollTop = 0;
    await checkpoint("chat-reading-default", chat);

    if (window.innerWidth <= 760) {
      expect(getComputedStyle(document.querySelector(".chat-controls")!).display).toBe("none");
      expect(bounds(chat).top - bounds(work).bottom).toBeGreaterThanOrEqual(17);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      return;
    }

    expect(bounds(chat).width).toBe(360);
    expect(bounds(chat).left - bounds(work).right).toBe(24);
    expect(document.querySelector(".chat-width-button")?.getAttribute("title")).toBe("Widen chat");
    (document.querySelector(".chat-width-button") as HTMLButtonElement).focus();
    expect(getComputedStyle(document.querySelector(".chat-width-button")!).outlineStyle).not.toBe("none");
    await widthButton.click();
    list.scrollTop = 0;
    await checkpoint("chat-reading-wide-initial", chat);
    await page.getByRole("button", { name: "Restore work space" }).click();
    await page.getByRole("button", { name: /Linen shade and walnut lamp base/ }).click();
    await expect.element(page.getByRole("heading", { name: /Linen shade/ })).toBeVisible();
    await userEvent.fill(document.querySelector<HTMLInputElement>(".composer input")!, "Keep this draft");
    list.scrollTop = (list.scrollHeight - list.clientHeight) * 0.45;
    const beforeFraction = list.scrollTop / (list.scrollHeight - list.clientHeight);
    await widthButton.click();
    expect(workspaceState.current!.sendAgentMessage).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Restore work space" })).toBeVisible();
    expect(layout.classList.contains("chat-wide")).toBe(true);
    expect(bounds(chat).width).toBeGreaterThan(360);
    expect(bounds(chat).width).toBeLessThanOrEqual(560);
    const detail = document.querySelector(".order-detail")!;
    expect(bounds(detail).width).toBeGreaterThanOrEqual(420);
    expect(bounds(chat).left - bounds(detail).right).toBe(24);
    expect(document.querySelector<HTMLInputElement>(".composer input")!.value).toBe("Keep this draft");
    await expect.element(page.getByRole("heading", { name: /Linen shade/ })).toBeVisible();
    expect(Math.abs(list.scrollTop / (list.scrollHeight - list.clientHeight) - beforeFraction)).toBeLessThan(0.06);
    expectReadable(document.querySelector(".chat-width-button")!);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    list.scrollTop = 0;
    await checkpoint("chat-reading-wide", chat);
    layout.setAttribute("style", "width: 856px");
    expect(bounds(document.querySelector(".order-detail")!).width).toBeGreaterThanOrEqual(420);
    expect(bounds(chat).width).toBeGreaterThanOrEqual(360);
    layout.removeAttribute("style");
    await page.getByRole("button", { name: "Restore work space" }).click();
    expect(bounds(chat).width).toBe(360);
    expect(document.querySelector<HTMLInputElement>(".composer input")!.value).toBe("Keep this draft");
    await expect.element(page.getByRole("heading", { name: /Linen shade/ })).toBeVisible();
    list.scrollTop = 0;
    await checkpoint("chat-reading-restored", chat);
    await page.getByRole("button", { name: "Review change" }).click();
    await expect.element(page.getByRole("heading", { name: "Review ready orders" })).toBeVisible();
    await page.getByRole("button", { name: "Widen chat" }).click();
    await expect.element(page.getByRole("heading", { name: "Review ready orders" })).toBeVisible();
    expect(document.querySelector<HTMLInputElement>(".composer input")!.value).toBe("Keep this draft");
  });

  test("keeps user text literal and blocks HTML, images, and unsafe links in assistant Markdown", async () => {
    const hostile = `## Recorded evidence\nA **verified** note with *emphasis* and [safe link](https://example.com/path).\n\n[script link](javascript:alert(1)) [data link](data:text/html,hello) ![remote picture](https://example.com/image.png)\n\n<script>alert(1)</script><img src="https://example.com/other.png" />\n\n\`inline_identifier_${"x".repeat(160)}\`\n\n\`\`\`text\n${"long_identifier_".repeat(30)}\n\`\`\``;
    workspaceState.current = createWorkspace({ snapshot: { ...snapshot, chat: [
      { ...snapshot.chat[1]!, content: "**This stays plain** <img src='https://example.com/user.png'>" },
      { ...snapshot.chat[0]!, content: hostile },
    ] } });
    await render(<App />);
    const assistant = document.querySelector(".chat-assistant")!;
    const user = document.querySelector(".chat-user")!;
    expect(user.textContent).toContain("**This stays plain**");
    expect(user.querySelector("strong, img")).toBeNull();
    expect(assistant.querySelector("h2")?.textContent).toBe("Recorded evidence");
    expect(assistant.querySelector("strong")?.textContent).toBe("verified");
    expect(assistant.querySelector("em")?.textContent).toBe("emphasis");
    expect(assistant.querySelectorAll("img, script")).toHaveLength(0);
    expect(assistant.querySelectorAll("a[href]")).toHaveLength(1);
    expect(assistant.querySelector("a[href]")?.getAttribute("href")).toBe("https://example.com/path");
    expect(assistant.textContent).not.toContain("alert(1)");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const pre = assistant.querySelector("pre")!;
    expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    expect(bounds(pre).width).toBeLessThanOrEqual(bounds(assistant).width);
    expectReadable(assistant);
    await checkpoint("chat-reading-safety", document.querySelector(".chat-panel")!);
  });

  test("keeps existing queue totals on separate lines", async () => {
    workspaceState.current = createWorkspace({ snapshot: { ...snapshot, chat: [{ ...snapshot.chat[0]!, content: "Ready: 1\nReview: 2\nWaiting: 3" }] } });
    await render(<App />);
    const paragraph = document.querySelector<HTMLElement>(".chat-assistant p")!;
    expect(paragraph.innerText).toBe("Ready: 1\nReview: 2\nWaiting: 3");
    expect(getComputedStyle(paragraph).whiteSpace).toBe("pre-line");
  });

  test("leaves a short answer at the default chat width", async () => {
    await render(<App />);
    const chat = document.querySelector(".chat-panel")!;
    expect(chat.querySelector(".chat-assistant p")?.textContent).toContain("I can help you review");
    expect(document.querySelector(".work-layout")?.classList.contains("chat-wide")).toBe(false);
    if (window.innerWidth > 760) expect(bounds(chat).width).toBe(360);
    await checkpoint("chat-reading-short", chat);
  });
  test("restores an address proposal without marking its heading and returns home from the brand icon", async () => {
    workspaceState.current = createWorkspace({ snapshot: { ...snapshot, currentProposal: addressProposal } });
    await render(<App />);

    const title = document.querySelector("#proposal-title")!;
    await expect.element(page.getByRole("heading", { name: "Check address" })).toBeVisible();
    await settleVisuals();
    expect(document.activeElement).not.toBe(title);
    await checkpoint("work-restored-address-proposal");

    await page.getByRole("button", { name: "Go to start page" }).click();
    await expect.element(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Check address" })).not.toBeInTheDocument();
  });

  test("keeps the queue, long order detail, review, and receipt readable", async () => {
    await render(<App />);
    const work = page.getByRole("heading", { name: "Decisions" });
    await expect.element(work).toBeVisible();
    await checkpoint("work-initial");

    const panel = document.querySelector(".work-panel")!;
    const chat = document.querySelector(".chat-panel")!;
    if (window.innerWidth > 760) {
      expect(bounds(chat).left - bounds(panel).right).toBeGreaterThanOrEqual(23);
      expect(bounds(chat).width).toBeGreaterThanOrEqual(350);
    } else {
      expect(bounds(chat).top - bounds(panel).bottom).toBeGreaterThanOrEqual(17);
      expect(bounds(chat).width).toBeLessThanOrEqual(window.innerWidth - 18);
    }
    expectReadable(document.querySelector(".chat-assistant")!);
    expectReadable(document.querySelector(".status-ready")!);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    const input = document.querySelector<HTMLInputElement>(".composer input")!;
    const send = document.querySelector<HTMLButtonElement>(".composer button")!;
    await userEvent.fill(input, "Show the ready orders");
    await expect.element(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(bounds(input).width).toBeGreaterThan(150);
    expectNoOverlap(input, send);
    await checkpoint("work-composer-filled", document.querySelector(".composer")!);
    await userEvent.click(send);
    expect(workspaceState.current!.sendAgentMessage).toHaveBeenCalledWith("Show the ready orders", { view: "work", focus: null });

    await page.getByRole("button", { name: /Linen shade and walnut lamp base/ }).click();
    await expect.element(page.getByRole("heading", { name: /Linen shade/ })).toBeVisible();
    expectInside(document.querySelector(".detail-heading")!, document.querySelector(".order-detail")!);
    expect(document.querySelector(".order-detail")!.scrollWidth).toBeLessThanOrEqual(document.querySelector(".order-detail")!.clientWidth + 1);
    await checkpoint("work-order-detail-long-content");

    await page.getByRole("button", { name: "Review change" }).click();
    await expect.element(page.getByRole("heading", { name: "Review ready orders" })).toBeVisible();
    expect(document.activeElement).toBe(document.querySelector("#proposal-title"));
    expectReadable(document.querySelector(".proposal-state.ready")!);
    expectInside(document.querySelector(".proposal-actions")!, document.querySelector(".proposal-screen")!);
    const accept = document.querySelector(".proposal-actions button:first-child")!;
    const cancel = document.querySelector(".proposal-actions button:last-child")!;
    accept.scrollIntoView({ block: "center", behavior: "instant" });
    await settleVisuals();
    expectInViewport(accept);
    expectInViewport(cancel);
    expectNotClipped(accept);
    expectNotClipped(cancel);
    expectNoOverlap(accept, cancel);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await checkpoint("work-review-open");

    await page.getByRole("button", { name: "Accept 1 change" }).click();
    await expect.element(page.getByRole("heading", { name: receipt.title })).toBeVisible();
    expectReadable(document.querySelector(".receipt-state")!);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await checkpoint("work-receipt-saved");
  });

  test("keeps the narrow queue and chat composer on screen and exposes disconnected controls", async () => {
    workspaceState.current = createWorkspace({ status: "offline" });
    await render(<App />);
    await expect.element(page.getByTestId("connection-status")).toHaveTextContent("Offline");
    await expect.element(page.getByRole("button", { name: "Review ready orders" })).toBeDisabled();
    await expect.element(page.getByPlaceholder("Message...")).toBeDisabled();

    const composer = document.querySelector(".composer")!;
    expectInside(composer, document.querySelector(".chat-panel")!);
    expect(bounds(composer).width).toBeGreaterThan(250);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expectReadable(document.querySelector(".chat-assistant")!);
    await checkpoint("work-disconnected");
  });

  test("shows busy progress without allowing another message", async () => {
    workspaceState.current = createWorkspace({ snapshot: { ...snapshot, activeTurn: { id: "turn-busy", generation: 1, status: "running", phase: "Checking recorded evidence", error: null, startedAt: "2026-09-22T12:34:56.000Z", finishedAt: null, completeDurationMs: null, measurement: "pending" } } });
    await render(<App />);
    await expect.element(page.getByText("Checking recorded evidence")).toBeVisible();
    await expect.element(page.getByPlaceholder("Message...")).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await checkpoint("work-busy-agent-turn", document.querySelector(".turn-progress")!);
  });

  test("keeps a failed review command visible beside the working queue", async () => {
    workspaceState.current = createWorkspace({ runCommand: vi.fn(async () => { throw new Error("The order changed before this review could be prepared."); }) });
    await render(<App />);
    await page.getByRole("button", { name: "Review ready orders" }).click();
    const failure = page.getByRole("status");
    await expect.element(failure).toHaveTextContent("The order changed before this review could be prepared.");
    expectReadable(document.querySelector(".command-message")!);
    expectInViewport(document.querySelector(".command-message")!);
    await checkpoint("work-review-error");
  });
});

describe("rendered Explore UI", () => {
  test("filters, expands, copies, and clears the catalogue", async () => {
    await render(<App />);
    await page.getByRole("button", { name: "Explore" }).click();
    await expect.element(page.getByRole("heading", { name: "Explore" })).toBeVisible();
    expect(document.querySelectorAll(".scenario-card")).toHaveLength(4);
    expectReadable(document.querySelector(".scenario-prompt")!);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await checkpoint("explore-initial");

    await page.getByRole("button", { name: "Prepare", exact: true }).click();
    await expect.element(page.getByText("1 of 4 tools")).toBeVisible();
    await page.getByText("Prepare batch", { exact: true }).click();
    await expect.element(page.getByText("Example call")).toBeVisible();
    const detail = document.querySelector(".tool-detail")!;
    for (const pre of detail.querySelectorAll("pre")) expectInside(pre, detail);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await checkpoint("explore-tool-detail", detail);

    await page.getByRole("button", { name: "Copy example call for prepareBatch" }).click();
    await expect.element(page.getByRole("status").last()).toMatchTextContent(/Copied|selected/);

    await page.getByRole("searchbox", { name: "Filter tools" }).fill("does-not-exist");
    await expect.element(page.getByText("No tools match these filters.")).toBeVisible();
    await checkpoint("explore-empty-filter", document.querySelector(".tools-empty")!);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect.element(page.elementLocator(document.querySelector(".tool-status > span")!)).toHaveTextContent("4 tools");
  });
});

describe("rendered Audit UI", () => {
  test("groups requests with independent keyboard disclosures and complete totals", async () => {
    workspaceState.current = createWorkspace({ auditPage: groupedAuditPage });
    await render(<App />);
    await page.getByRole("button", { name: "Audit", exact: true }).click();
    await expect.element(page.getByText("2 requests", { exact: true })).toBeVisible();
    expect(document.querySelectorAll("[data-audit-request-id]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-attempt-id]")).toHaveLength(0);
    await checkpoint("audit-grouped-collapsed");
    const candle = page.getByRole("button", { name: /open the matched candle review/ });
    await candle.click();
    await expect.element(candle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll("[data-attempt-id]")).toHaveLength(3);
    const first = document.querySelector("[data-audit-request-id='mug-1']")!;
    const second = document.querySelector("[data-audit-request-id='candle-1']")!;
    expect(first.textContent).toContain("5,661");
    expect(second.textContent).toContain("10,558");
    expect(second.textContent).toContain("$0.00041");
    expectReadable(candle.element());
    expectNotClipped(candle.element());
    expectInside(candle.element(), second);
    expectNoOverlap(first, second);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    document.querySelector(".audit-scroll")!.scrollLeft = 0;
    await checkpoint("audit-grouped-expanded");
    const mug = page.getByRole("button", { name: /teach me how to fix the stone mug/ });
    (mug.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(mug).toHaveAttribute("aria-expanded", "true");
    await expect.element(candle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll("[data-attempt-id]")).toHaveLength(5);
    await userEvent.keyboard("{Enter}");
    await expect.element(mug).toHaveAttribute("aria-expanded", "false");
    await expect.element(candle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll("[data-attempt-id]")).toHaveLength(3);
  });

  test("keeps long details inside the horizontal review panel and switches tabs", async () => {
    await render(<App />);
    await page.getByRole("button", { name: "Audit" }).click();
    await expect.element(page.getByRole("heading", { name: "Audit" })).toBeVisible();
    await page.getByRole("button", { name: /Summarise the ready orders/ }).click();
    await page.getByRole("button", { name: /Turn 1 · Chat/ }).click();
    await expect.element(page.getByRole("tab", { name: "Request" })).toHaveAttribute("aria-selected", "true");
    const scroll = document.querySelector(".audit-scroll")!;
    const detail = document.querySelector(".audit-detail-cell")!;
    expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth + 1);
    expect(scroll.scrollWidth).toBeGreaterThanOrEqual(scroll.clientWidth);
    expectReadable(document.querySelector(".audit-detail")!);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await checkpoint("audit-request-detail", detail);

    await page.getByRole("tab", { name: "Response" }).click();
    await expect.element(page.getByRole("tabpanel")).toMatchTextContent(/repeatedContext/);
    expect(document.querySelector(".audit-detail pre")!.scrollWidth).toBeLessThanOrEqual(document.querySelector(".audit-detail pre")!.clientWidth + 1);
    await page.getByRole("tab", { name: "Application result" }).click();
    await expect.element(page.getByText("listOrders", { exact: true })).toBeVisible();
    await checkpoint("audit-application-result", detail);
  });

  test("renders a request failure with readable error text", async () => {
    workspaceState.current = createWorkspace({ auditError: "Audit details could not be loaded." });
    await render(<App />);
    await page.getByRole("button", { name: "Audit" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Audit details could not be loaded.");
    expectReadable(document.querySelector(".audit-load-error")!);
    await checkpoint("audit-error");
  });

  test("renders an empty Audit state without page-wide overflow", async () => {
    workspaceState.current = createWorkspace({ auditPage: { ...auditPage, query: "no-match", requests: [], attempts: [], total: 0 }, auditError: null });
    await render(<App />);
    await page.getByRole("button", { name: "Audit" }).click();
    await expect.element(page.getByText("No inference attempts have been recorded yet.")).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await checkpoint("audit-empty");
  });
});

test("visual checks reject unreadable and overlapping injected styles", () => {
  const host = document.createElement("div");
  host.style.cssText = "position:relative;width:200px;height:40px;background:#fff;color:#fff";
  const label = document.createElement("span");
  label.textContent = "Unreadable";
  const first = document.createElement("button");
  const second = document.createElement("button");
  const clipped = document.createElement("span");
  const offscreen = document.createElement("span");
  first.style.cssText = second.style.cssText = "position:absolute;left:0;top:20px;width:80px;height:20px";
  clipped.textContent = "This label is intentionally clipped";
  clipped.style.cssText = "display:block;width:20px;white-space:nowrap;overflow:hidden";
  offscreen.textContent = "Offscreen";
  offscreen.style.cssText = "position:fixed;left:-100px;top:0";
  host.append(label, first, second, clipped, offscreen);
  document.body.append(host);

  expect(() => expectReadable(label)).toThrow();
  expect(() => expectNoOverlap(first, second)).toThrow();
  expect(() => expectNotClipped(clipped)).toThrow();
  expect(() => expectInViewport(offscreen)).toThrow();
  host.remove();
});
