import { expect, test } from "@playwright/test";

test("opens, filters, inspects evidence, and reconnects over WebSocket", async ({
  page,
  context,
}, testInfo) => {
  const apiRequests: Array<string> = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && !request.url().endsWith("/api/health")) {
      apiRequests.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await expect(page.getByRole("button", { name: "All 24" })).toBeVisible();

  await page.getByRole("button", { name: /^Ready / }).click();
  await expect(page.locator("#target-order-BB-1051")).toBeVisible();
  await expect(page.locator("#target-order-BB-1042")).toHaveCount(0);
  await page.getByRole("button", { name: "All 24" }).click();

  await page.locator("#target-order-BB-1042").scrollIntoViewIfNeeded();
  await page.locator("#target-order-BB-1042").click();
  await expect(page.getByRole("heading", { name: "Check address" })).toBeVisible();
  await expect(page.locator("#target-order-BB-1042-evidence")).toContainText(
    "The number is 41, not 14",
  );
  await page.getByRole("button", { name: "Back to queue" }).click();

  await context.setOffline(true);
  await expect(page.getByTestId("connection-status")).toContainText("Offline");
  await context.setOffline(false);
  await expect(page.getByTestId("connection-status")).toContainText("Connected", {
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "All 24" })).toBeVisible();
  expect(apiRequests).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath(`actual-work-${testInfo.project.name}.png`),
    fullPage: true,
  });
});

test("retires a replaced browser session without a reconnect loop", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    sessionStorage.setItem("parcel-hopscotch-client-id", "duplicated-browser-session");
  });
  let firstPageSockets = 0;
  page.on("websocket", () => { firstPageSockets += 1; });
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");

  const replacement = await context.newPage();
  await replacement.goto("/");
  await expect(replacement.getByTestId("connection-status")).toContainText("Connected");
  await expect(page.getByTestId("connection-status")).toContainText("Session replaced");
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("connection-status")).toContainText("Session replaced");
  expect(firstPageSockets).toBeLessThanOrEqual(2);
  await replacement.close();
});

test("reviews an address and batch, undoes the batch, and resets the demo", async ({
  page,
  context,
}, testInfo) => {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");

  await page.locator("#target-order-BB-1042").click();
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByRole("heading", { name: "Check address" })).toBeVisible();
  await expect(page.getByText("14 Willow Lane, Bath BA1 2AB")).toBeVisible();
  await expect(page.getByText("41 Willow Lane, Bath BA1 2AB")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("address.png"), fullPage: true });
  await page.getByRole("button", { name: "Accept 1 change" }).click();
  await expect(page.getByText("Accepted by you")).toBeVisible();
  await page.getByRole("button", { name: "Back to work" }).click();

  await page.getByRole("button", { name: "Review ready orders" }).click();
  await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toBeVisible();
  await expect(page.getByLabel("Orders left out")).toContainText("BB-1088");
  await page.screenshot({ path: testInfo.outputPath("batch.png"), fullPage: true });
  await page.getByRole("button", { name: /Accept \d+ changes/ }).click();
  await expect(page.getByText("Accepted by you")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("receipt.png"), fullPage: true });

  await page.getByRole("button", { name: "Back to work" }).click();
  await expect(page.getByRole("button", { name: "View last receipt" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await page.getByRole("button", { name: "View last receipt" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("heading", { name: /Undo \d+ orders ready to pack/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("undo.png"), fullPage: true });
  await page.getByRole("button", { name: /Accept \d+ changes/ }).click();
  await expect(page.getByText("Undone by you")).toBeVisible();
  await page.getByRole("button", { name: "Back to work" }).click();

  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await expect(otherTab.getByTestId("connection-status")).toContainText("Connected");
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByRole("heading", { name: "Reset my demo" })).toBeVisible();
  await expect(page.getByText("Keep audit history and add a reset marker.")).toBeVisible();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByText("Fresh workspace ready")).toBeVisible();
  await expect(otherTab.getByTestId("connection-status")).toContainText("Connected", { timeout: 10_000 });
  await expect(otherTab.getByRole("button", { name: "All 24" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("reset.png"), fullPage: true });
  await otherTab.close();
  await page.getByRole("button", { name: "Back to work" }).click();
  await expect(page.getByRole("button", { name: "All 24" })).toBeVisible();
  await page.locator("#target-order-BB-1042").click();
  await expect(page.getByText("Street number needs checking.")).toBeVisible();
});

test("holds conditional consent and exhausted stock without an acceptance action", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");

  await page.locator("#target-order-BB-1076").scrollIntoViewIfNeeded();
  await page.locator("#target-order-BB-1076").click();
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByText("The customer asked for a picture first, so the replacement is not agreed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Held" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("conditional-held.png"), fullPage: true });
  await page.getByRole("button", { name: "Cancel" }).click();

  const advance = page.getByRole("button", { name: "Advance stock scenario" });
  for (let step = 0; step < 4; step += 1) {
    await advance.click();
    await expect(advance).toBeEnabled();
  }
  await page.locator("#target-order-BB-1051").click();
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByText("MUG-SAGE does not have enough stock.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Held" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("zero-stock-held.png"), fullPage: true });

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByText("Fresh workspace ready")).toBeVisible();
});
