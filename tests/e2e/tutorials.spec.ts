import { expect, test, type Page, type TestInfo } from "@playwright/test";

const coach = (page: Page) => page.getByRole("complementary", { name: / tutorial$/ });
const pause = (page: Page) => page.waitForTimeout(700);

const resetWorkspace = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByRole("heading", { name: "Reset my demo" })).toBeVisible();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByText("Fresh workspace ready")).toBeVisible();
  await page.getByRole("button", { name: "Back to work" }).click();
};

const startTutorial = async (page: Page, message: string, title: string) => {
  const composer = page.getByPlaceholder("Message...");
  await composer.fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("The tutorial is ready. Your verified work advances it, and you can dismiss it at any time.")).toBeVisible();
  await expect(page.getByLabel(`${title} tutorial`)).toBeVisible();
  await expect(composer).toBeEnabled();
  await pause(page);
};

const reviewIndividual = async (page: Page, orderId: string) => {
  await page.locator(`#target-order-${orderId}`).click();
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.locator("#target-proposal-review")).toBeVisible();
  await pause(page);
};

const acceptIndividual = async (page: Page) => {
  await page.locator("#target-proposal-accept").click();
  await expect(page.getByText("Accepted by you")).toBeVisible();
  await pause(page);
};

test("teaches address correction and completes a separate case without agent assistance", async ({ page, context }, testInfo: TestInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await resetWorkspace(page);
  await startTutorial(page, "Teach me the address correction tutorial.", "Address correction");
  await page.getByRole("button", { name: "Dismiss tutorial" }).focus();
  await expect(page.getByRole("button", { name: "Dismiss tutorial" })).toBeFocused();
  await expect(page.locator("html")).toHaveCSS("scroll-behavior", "auto");

  await page.locator("#target-order-BB-1042").evaluate((element) => element.remove());
  await expect(page.getByText("The next step is not visible. Return to Work and open the requested order from the list.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "0");

  await page.locator("#target-order-BB-1042").click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "1");
  await pause(page);
  await context.setOffline(true);
  await expect(page.getByTestId("connection-status")).toContainText("Offline");
  await context.setOffline(false);
  await expect(page.getByTestId("connection-status")).toContainText("Connected", { timeout: 10_000 });
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "1");
  await page.reload();
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "1");
  await expect(page.getByTestId("order-list")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`recovery-order-list-${testInfo.project.name}.png`), fullPage: true });
  await page.locator("#target-order-BB-1042").click();
  await expect(page.locator("#target-order-BB-1042-evidence")).toBeVisible();
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "1");
  await page.getByRole("button", { name: "Dismiss tutorial" }).click();
  await expect(coach(page)).toHaveCount(0);
  await startTutorial(page, "Teach me the address correction tutorial.", "Address correction");
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "1");

  await page.getByRole("button", { name: "Review change" }).click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "2");
  await pause(page);
  await page.screenshot({ path: testInfo.outputPath(`actual-address-tutorial-${testInfo.project.name}.png`), fullPage: true });
  await acceptIndividual(page);
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "3");
  await page.reload();
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await page.locator("#target-order-BB-1102").click();
  await page.getByRole("button", { name: "Review change" }).click();
  await acceptIndividual(page);
  await page.locator("#target-receipt-back").click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "3");
  await page.getByRole("button", { name: "Continue tutorial receipt" }).click();
  await expect(page.getByText("BB-1042", { exact: true })).toBeVisible();
  await page.locator("#target-receipt-back").click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-phase", "practice");

  await reviewIndividual(page, "BB-1072");
  await acceptIndividual(page);
  await page.locator("#target-receipt-back").click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-phase", "complete");
  await expect(coach(page)).toContainText("Practice complete. You corrected a second address from evidence to receipt.");
  await page.getByRole("button", { name: "Dismiss tutorial" }).click();
  await expect(coach(page)).toHaveCount(0);
});

test("teaches substitution review, survives navigation and cancellation, and reset clears guidance", async ({ page }) => {
  await resetWorkspace(page);
  await startTutorial(page, "Teach me the substitution tutorial.", "Substitution review");

  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.getByText("The next step is not visible. Return to Work and open the requested order from the list.")).toBeVisible();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "0");

  const composer = page.getByPlaceholder("Message...");
  await composer.fill("Slow turn, show BB-1042.");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(/^Cancelled\./)).toBeVisible();
  await expect(page.getByLabel("Substitution review tutorial")).toBeVisible();

  await reviewIndividual(page, "BB-1051");
  await acceptIndividual(page);
  await page.locator("#target-receipt-back").click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-phase", "practice");
  await reviewIndividual(page, "BB-1104");
  await acceptIndividual(page);
  await page.locator("#target-receipt-back").click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-phase", "complete");

  await page.getByRole("button", { name: "Dismiss tutorial" }).click();
  await page.locator("#target-receipt-back").click();
  await startTutorial(page, "Teach me the substitution tutorial.", "Substitution review");
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByText("Fresh workspace ready")).toBeVisible();
  await expect(coach(page)).toHaveCount(0);
});

test("teaches two distinct batch approvals while preserving explicit human acceptance", async ({ page }) => {
  await resetWorkspace(page);
  await startTutorial(page, "Teach me the batch approval tutorial.", "Batch approval");

  await page.getByRole("button", { name: /^Ready / }).click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-step", "1");
  await pause(page);
  await page.locator("#target-batch-review").click();
  await expect(page.getByRole("heading", { name: "Review 3 changes" })).toBeVisible();
  await expect(page.getByLabel("Orders left out")).toContainText("Outside this tutorial group.");
  await expect(page.getByText("Accepted by you")).toHaveCount(0);
  await pause(page);
  await page.locator("#target-proposal-accept").click();
  await expect(page.getByText("Accepted by you")).toBeVisible();
  await pause(page);
  await page.locator("#target-receipt-back").click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-phase", "practice");

  await page.getByRole("button", { name: /^Ready / }).click();
  await page.locator("#target-batch-review").click();
  await expect(page.getByRole("heading", { name: "Review 3 changes" })).toBeVisible();
  await expect(page.getByText("Accepted by you")).toHaveCount(0);
  await page.locator("#target-proposal-accept").click();
  await expect(page.getByText("Accepted by you")).toBeVisible();
  await page.locator("#target-receipt-back").click();
  await expect(coach(page)).toHaveAttribute("data-tutorial-phase", "complete");
  await expect(coach(page)).toContainText("Practice complete. You reviewed and approved a separate ready group.");
  await pause(page);
  await page.getByRole("button", { name: "Dismiss tutorial" }).click();
  await page.locator("#target-receipt-back").click();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await page.getByRole("button", { name: "Reset my demo" }).click();
  await expect(page.getByText("Fresh workspace ready")).toBeVisible();
});
