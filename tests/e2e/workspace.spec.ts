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
