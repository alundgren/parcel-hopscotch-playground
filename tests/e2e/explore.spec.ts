import { expect, test, type Page, type TestInfo } from "@playwright/test";

const pause = (page: Page) => page.waitForTimeout(600);

const resetWorkspace = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  const cancel = page.getByRole("button", { name: "Cancel" });
  if (await cancel.isVisible()) await cancel.click();
  const back = page.getByRole("button", { name: /Back to (work|queue)/ });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByRole("heading", { name: "Reset my demo" })).toBeVisible();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByText("Fresh workspace ready")).toBeVisible();
  await page.getByRole("button", { name: "Back to work" }).click();
};

const openExplore = async (page: Page) => {
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Explore" })).toBeVisible();
  await expect(page.locator(".tool-row")).toHaveCount(16);
};

test("filters and inspects the validated registry catalogue", async ({ page, context }, testInfo: TestInfo) => {
  await resetWorkspace(page);
  await openExplore(page);
  await expect(page.locator(".scenario-card")).toHaveCount(4);
  await expect(page.getByText("16 tools", { exact: true })).toBeVisible();
  await pause(page);
  await page.screenshot({ path: testInfo.outputPath(`actual-explore-default-${testInfo.project.name}.png`), fullPage: true });

  await page.getByRole("button", { name: "Show tools for Get your bearings" }).click();
  await expect(page.getByText("3 of 16 tools", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.getByText("2 of 16 tools", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Filter tools" }).fill("omit filters");
  await expect(page.getByText("1 of 16 tools", { exact: true })).toBeVisible();
  await expect(page.locator(".tool-row")).toHaveCount(1);

  await page.getByRole("searchbox", { name: "Filter tools" }).fill("does-not-exist");
  await expect(page.getByText("No tools match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".tool-row")).toHaveCount(16);

  const resetRow = page.locator('[data-tool-id="prepareReset"]');
  await resetRow.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(resetRow).toHaveAttribute("open", "");
  await expect(resetRow.getByText("Example data.")).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4173" });
  await resetRow.getByRole("button", { name: "Copy example call for prepareReset" }).click();
  await expect(page.locator(".copy-status")).toContainText(/Copied the prepareReset example|example is selected/);

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await pause(page);
  await page.screenshot({ path: testInfo.outputPath(`actual-explore-expanded-${testInfo.project.name}.png`), fullPage: true });
});

test("launches the orientation, tutorial, and batch scenarios through working flows", async ({ page }) => {
  await resetWorkspace(page);
  await openExplore(page);
  await page.getByRole("button", { name: "Try in Work: Get your bearings" }).click();
  await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
  const overview = page.locator('[data-chat-role="assistant"]').last();
  await expect(overview).toContainText("Ready: 6");
  await expect(overview).toContainText("Review: 14");
  await expect(overview).toContainText("Waiting: 4");
  await expect(overview).toContainText("BB-1042: review, address. Street number needs checking.");
  await expect(page.getByPlaceholder("Message...")).toBeEnabled();
  await pause(page);

  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "Try in Work: Learn a task" }).click();
  await expect(page.getByLabel("Address correction tutorial")).toBeVisible();
  await expect(page.getByPlaceholder("Message...")).toBeEnabled();
  await pause(page);
  await page.getByRole("button", { name: "Dismiss tutorial" }).click();

  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "Try in Work: Make a batch decision" }).click();
  await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toBeVisible();
  await expect(page.getByText("Nothing changes until you accept it.")).toBeVisible();
  await expect(page.getByText("Accepted by you")).toHaveCount(0);
  await pause(page);
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("opens the exact Jev trace and recovers completed examples through review", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeAddEventListener = WebSocket.prototype.addEventListener as (this: WebSocket, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => void;
    const nativeSend = WebSocket.prototype.send;
    const testWindow = window as unknown as { __agentCompleteAcks: number; __ackSawVisibleConsent: boolean };
    testWindow.__agentCompleteAcks = 0;
    testWindow.__ackSawVisibleConsent = false;
    WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      try {
        const message = JSON.parse(String(data)) as { type?: string };
        if (message.type === "agent_complete_ack") {
          testWindow.__agentCompleteAcks += 1;
          const result = document.querySelector('[data-focused-consent-result="true"]');
          testWindow.__ackSawVisibleConsent = result instanceof HTMLElement
            && result.getClientRects().length > 0
            && result.textContent?.includes("Consent: conditional") === true;
        }
      } catch {
        // Non-JSON frames are not application acknowledgements.
      }
      return nativeSend.call(this, data);
    };
    WebSocket.prototype.addEventListener = function (this: WebSocket, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (type !== "message" || listener === null) return nativeAddEventListener.call(this, type, listener, options);
      const delayedListener: EventListener = (event) => {
        let delay = 0;
        try {
          const message = JSON.parse(String((event as MessageEvent).data)) as { type?: string; result?: { kind?: string } };
          if (message.type === "command_result" && message.result?.kind === "explore") delay = 1_500;
          if (message.type === "audit_detail") delay = 1_500;
        } catch {
          // Non-JSON frames remain immediate.
        }
        window.setTimeout(() => {
          if (typeof listener === "function") listener.call(this, event);
          else listener.handleEvent(event);
        }, delay);
      };
      return nativeAddEventListener.call(this, type, delayedListener, options);
    } as typeof WebSocket.prototype.addEventListener;
  });
  await resetWorkspace(page);
  await openExplore(page);
  await page.getByRole("button", { name: "View in Audit: Test a judgement" }).click();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
  await page.waitForTimeout(900);
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __agentCompleteAcks: number }).__agentCompleteAcks)).toBe(0);
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await page.waitForTimeout(500);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __agentCompleteAcks: number }).__agentCompleteAcks)).toBe(0);
  const expanded = page.locator('.audit-summary[aria-hidden="false"]');
  const row = page.locator(".audit-summary[data-attempt-id]").first();
  await expect(row).toBeVisible();
  const attemptId = await row.getAttribute("data-attempt-id");
  expect(attemptId).not.toBeNull();
  await expect(page.locator(".audit-filter input")).toHaveValue(attemptId!);
  await expect(row.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`#audit-detail-${attemptId}`)).toContainText("Check replacement consent");
  await expect(page.locator(`#audit-detail-${attemptId}`)).toContainText("Fixture run");
  await expect(page.locator(`#audit-detail-${attemptId}`)).toContainText("Browser send to completed work");
  const focusedResult = page.locator(`#audit-detail-${attemptId} details[data-focused-application-result="true"]`);
  await expect(focusedResult).toHaveAttribute("open", "");
  await expect(focusedResult.locator("pre")).toBeVisible();
  await expect(focusedResult.locator("pre")).toContainText('"consent": "conditional"');
  await expect(focusedResult.locator('[data-focused-consent-result="true"]')).toBeVisible();
  await expect(focusedResult.locator('[data-focused-consent-result="true"]')).toHaveText("Consent: conditional. Human review required.");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __agentCompleteAcks: number }).__agentCompleteAcks)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ackSawVisibleConsent: boolean }).__ackSawVisibleConsent)).toBe(true);
  await expect(expanded).toHaveCount(0);
  await pause(page);

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await page.locator("#target-order-BB-1042").click();
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Accept 1 change" }).click();
  await expect(page.getByText("Accepted by you")).toBeVisible();
  await page.getByRole("button", { name: "Back to work" }).click();
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "Try in Work: Learn a task" }).click();
  await expect(page.getByText("BB-1042 has already moved past its address review.")).toBeVisible();
  await pause(page);
  await page.getByRole("button", { name: "Prepare reset for review" }).click();
  await expect(page.getByRole("heading", { name: "Reset my demo" })).toBeVisible();
  await expect(page.getByText("Fresh workspace ready")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "Advance stock case" }).click();
  await expect(page.getByText("Scenario advanced: sage mug stock changed.")).toBeVisible();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByText("Fresh workspace ready")).toBeVisible();
  await page.getByRole("button", { name: "Back to work" }).click();
});
