import { writeFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

const identityHeader = "Cf-Access-Authenticated-User-Email";

const projectIdentity = (testInfo: TestInfo, purpose: string) =>
  `acceptance-${purpose}-${testInfo.project.name}@example.test`;

const openWorkspace = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
};

const send = async (page: Page, message: string) => {
  await page.getByPlaceholder("Message...").fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
};

const demonstrationPause = async (page: Page) => {
  if (process.env.PROOF_DEMO === "true") await page.waitForTimeout(1_200);
};

test("rejects a stale batch in the browser without applying any reviewed order", async ({ page, context }, testInfo) => {
  await context.setExtraHTTPHeaders({ [identityHeader]: projectIdentity(testInfo, "stale") });
  await openWorkspace(page);
  const secondPage = await context.newPage();
  try {
    await openWorkspace(secondPage);
    await demonstrationPause(page);
    await page.getByRole("button", { name: "Review ready orders" }).click();
    await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toBeVisible();
    await expect(page.getByText("BB-1051", { exact: true })).toBeVisible();
    await demonstrationPause(page);

    await secondPage.getByRole("button", { name: "Advance stock scenario" }).click();
    await expect(secondPage.getByRole("status")).toContainText("Scenario advanced: sage mug stock changed.");
    await demonstrationPause(secondPage);

    await page.getByRole("button", { name: /Accept \d+ changes/ }).click();
    await expect(page.getByRole("status")).toContainText("Stock for MUG-SAGE changed after review. Nothing was applied.");
    await expect(page.getByText("Accepted by you")).toHaveCount(0);
    await demonstrationPause(page);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "All 24" })).toBeVisible();
    await expect(page.locator("#target-order-BB-1063 .status")).toHaveText("Ready");
    await demonstrationPause(page);
  } finally {
    await secondPage.close();
  }
});

test("cancels an active provider request when reset commits and retains its audit outcome", async ({ page, context }, testInfo) => {
  await context.setExtraHTTPHeaders({ [identityHeader]: projectIdentity(testInfo, "reset") });
  await openWorkspace(page);

  await send(page, "Slow turn, show BB-1042.");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByRole("heading", { name: "Reset my demo" })).toBeVisible();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByText("Fresh workspace ready")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByText("I found the order and showed the relevant evidence.")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to work" }).click();
  await expect(page.getByRole("button", { name: "All 24" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);

  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await expect(page.locator(".audit-summary").first()).toBeVisible();
  await expect(page.getByText("Interrupted", { exact: true }).first()).toBeVisible();
});

const isolatedContext = async (browser: Browser, testInfo: TestInfo, identity: string): Promise<BrowserContext> => {
  const viewport = testInfo.project.use.viewport ?? { width: 1440, height: 1000 };
  return browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    viewport,
    ...(process.env.RECORD_VIDEO === "true" ? { recordVideo: { dir: testInfo.outputPath("isolation-videos"), size: viewport } } : {}),
    extraHTTPHeaders: { [identityHeader]: identity },
  });
};

test("isolates turns, provider failures, audit history, accepted work, and reset between two users", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const firstContext = await isolatedContext(browser, testInfo, projectIdentity(testInfo, "owner-a"));
  const secondContext = await isolatedContext(browser, testInfo, projectIdentity(testInfo, "owner-b"));
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    await Promise.all([openWorkspace(first), openWorkspace(second)]);

    await send(first, "Find BB-1042, open it, and highlight the evidence.");
    await expect(first.getByText("I found the order and showed the relevant evidence.")).toBeVisible();
    await expect(second.getByText("Find BB-1042, open it, and highlight the evidence.")).toHaveCount(0);
    await expect(second.getByText("I found the order and showed the relevant evidence.")).toHaveCount(0);

    await first.getByRole("button", { name: "Review change" }).click();
    await first.getByRole("button", { name: "Accept 1 change" }).click();
    await expect(first.getByText("Accepted by you")).toBeVisible();
    await second.locator("#target-order-BB-1042").click();
    await expect(second.locator(".detail-current")).toContainText("14 Willow Lane, Bath BA1 2AB");

    await send(first, "Simulate the provider failure fixture.");
    await expect(first.getByText("I could not complete that turn. You can retry it, and any proposal already shown is still available for review.")).toBeVisible();
    await expect(first.getByPlaceholder("Message...")).toBeEnabled();
    await expect(second.getByText("I could not complete that turn. You can retry it, and any proposal already shown is still available for review.")).toHaveCount(0);

    await send(first, "Find BB-1088, open it, and highlight the evidence.");
    await expect(first.getByText("I found the order and showed the relevant evidence.")).toHaveCount(2);
    await expect(second.getByText("Find BB-1088, open it, and highlight the evidence.")).toHaveCount(0);

    await first.getByRole("button", { name: "Audit", exact: true }).click();
    await expect(first.locator("[data-audit-request-id]")).toHaveCount(3);
    await expect(first.getByText("Error", { exact: true }).first()).toBeVisible();
    await second.getByRole("button", { name: "Audit", exact: true }).click();
    await expect(second.locator("[data-audit-request-id]")).toHaveCount(0);

    await first.getByRole("button", { name: "Work", exact: true }).click();
    await first.getByRole("button", { name: "Back to queue" }).click();
    await first.getByRole("button", { name: "Reset my demo" }).click();
    await first.getByRole("button", { name: "Reset my demo" }).click();
    await expect(first.getByText("Fresh workspace ready")).toBeVisible();
    await second.getByRole("button", { name: "Work", exact: true }).click();
    await expect(second.locator(".detail-current")).toContainText("14 Willow Lane, Bath BA1 2AB");
    await expect(second.getByText("Fresh workspace ready")).toHaveCount(0);

    await first.getByRole("button", { name: "Audit", exact: true }).click();
    await expect(first.locator("[data-audit-request-id]")).toHaveCount(3);
    await expect(first.getByText("Workspace reset", { exact: true })).toBeVisible();
    await second.getByRole("button", { name: "Audit", exact: true }).click();
    await expect(second.locator("[data-audit-request-id]")).toHaveCount(0);
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()]);
  }
});

test("records server-turn, browser completed-work, and accept-to-visible measurements separately", async ({ page, context }, testInfo) => {
  await context.setExtraHTTPHeaders({ [identityHeader]: projectIdentity(testInfo, "metrics") });
  await openWorkspace(page);
  await demonstrationPause(page);

  await send(page, "Prepare all the green orders as a batch.");
  await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toBeVisible();
  await expect(page.getByText("The proposal is ready for your review. Nothing changes until you accept it.")).toBeVisible();
  const turnId = await page.locator('[data-chat-role="user"]').last().getAttribute("data-chat-turn");
  expect(turnId).not.toBeNull();
  await demonstrationPause(page);

  await page.getByRole("button", { name: /Accept \d+ changes/ }).click();
  await expect(page.getByText("Accepted by you")).toBeVisible();
  await demonstrationPause(page);
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  const search = page.getByLabel("Search audit history");
  await search.fill(turnId!);
  await page.locator("[data-audit-request-id]").first().getByRole("button").click();
  const row = page.locator(".audit-summary[data-attempt-id]").first();
  await expect(row).toBeVisible();
  await row.getByRole("button").click();
  const detail = page.locator(".audit-detail");
  const serverTurn = detail.getByText(/^Server turn /);
  const browserCompleted = detail.getByText(/^Browser send to completed work /);
  await expect(serverTurn).not.toContainText(/Unknown|Incomplete/);
  await expect(browserCompleted).not.toContainText(/Unknown|Incomplete/);
  await detail.getByRole("tab", { name: "Application result" }).click();
  const acceptVisible = detail.locator("summary strong").filter({ hasText: /^Accept to visible · / });
  await expect(acceptVisible).toBeVisible();
  await demonstrationPause(page);

  const evidence = {
    project: testInfo.project.name,
    viewport: testInfo.project.use.viewport,
    environment: "deterministic scripted providers over the actual WebSocket and SQLite persistence",
    serverTurn: await serverTurn.textContent(),
    browserSendToCompletedWork: await browserCompleted.textContent(),
    acceptToCommittedVisibleUpdate: await acceptVisible.textContent(),
  };
  const path = testInfo.outputPath(`acceptance-metrics-${testInfo.project.name}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await testInfo.attach(`acceptance metrics ${testInfo.project.name}`, { path, contentType: "application/json" });
});
