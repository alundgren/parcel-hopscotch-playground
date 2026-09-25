import { test } from "./support";
import { expect, type Page } from "@playwright/test";

const openWorkspace = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
};
const trail = (page: Page) => page.getByRole("complementary", { name: "Task trail" });
const notes = (page: Page) => page.getByRole("complementary", { name: "Notes on work" });

test("procedural Ready help opens and points to the review control without preparing a preview", async ({ page }) => {
  await openWorkspace(page);
  await page.getByPlaceholder("Message...").fill("can you help me out with how to approve the ones in ready?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: /^Ready \d+$/ })).toHaveAttribute("aria-pressed", "true");
  const review = page.getByRole("button", { name: "Review ready orders" });
  await expect(review).toHaveClass(/agent-highlight/);
  await expect(review).toBeFocused();
  await expect(page.getByText("I've opened Ready and pointed to Review ready orders.")).toBeVisible();
  await expect(page.locator(".proposal-screen")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
});

test("explains a changed item, asks before moving, and returns for a fresh human review", async ({ page, context }) => {
  await openWorkspace(page);
  const second = await context.newPage();
  try {
    await openWorkspace(second);
    await page.getByRole("button", { name: /^Ready \d+$/ }).click();
    await page.getByRole("button", { name: "Review ready orders" }).click();
    await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toBeVisible();

    await second.locator("#target-order-BB-1051").click();
    await second.getByRole("button", { name: "Review change" }).click();
    await second.getByRole("button", { name: "Accept 1 change", exact: true }).click();
    await expect(second.getByText("Accepted by you")).toBeVisible();

    await page.getByRole("button", { name: /Accept \d+ changes/ }).click();
    await expect(page.getByRole("status")).toContainText("BB-1051 changed after review. Nothing was applied.");
    await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show me", exact: true })).toBeVisible();
    await expect(trail(second)).toHaveCount(0);

    await page.getByPlaceholder("Message...").fill("It says one item changed after review. What do I need to do?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByPlaceholder("Message...")).toBeEnabled();
    await expect(page.locator('[data-chat-role="assistant"]').last()).not.toHaveText("The proposal is ready for your review. Nothing changes until you accept it.");
    await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toBeVisible();

    await page.getByRole("button", { name: "Show me", exact: true }).click();
    await expect(page.locator(".detail-heading .order-id")).toHaveText("BB-1051");
    await expect(notes(page)).toBeVisible();
    await expect(notes(page)).toContainText(/already|resolved/i);
    await expect(page.getByRole("button", { name: "Review change", exact: true })).toBeDisabled();
    await expect(trail(second)).toHaveCount(0);

    await page.getByRole("button", { name: "Return to work", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Ready \d+$/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toHaveCount(0);
    await expect(page.getByText("Accepted by you")).toHaveCount(0);
    await page.getByRole("button", { name: "Review ready orders" }).click();
    await expect(page.getByRole("heading", { name: /Review \d+ changes/ })).toBeVisible();
    await page.getByRole("button", { name: /Accept \d+ changes/ }).click();
    await expect(page.getByText("Accepted by you")).toBeVisible();
  } finally { await second.close(); }
});

test("keeps stock recovery local, pauses on reload, and waits for a human command", async ({ page, context }) => {
  await openWorkspace(page);
  const second = await context.newPage();
  try {
    await openWorkspace(second);
    await page.getByRole("button", { name: "Review ready orders" }).click();
    await second.getByRole("button", { name: "Advance stock scenario" }).click();
    await expect(second.getByRole("status")).toContainText("Scenario advanced");
    await page.getByRole("button", { name: /Accept \d+ changes/ }).click();
    await expect(page.getByRole("status")).toContainText("Nothing was applied.");
    await page.getByRole("button", { name: "Show me", exact: true }).click();
    await expect(notes(page)).toContainText(/stock|evidence|review/i);
    await expect(page.getByRole("button", { name: "Review change", exact: true })).toBeEnabled();
    await expect(page.getByText("Accepted by you")).toHaveCount(0);
    await expect(trail(second)).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("connection-status")).toContainText("Connected");
    await expect(trail(page)).toHaveAttribute("data-guidance-status", "paused");
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.locator(".detail-heading .order-id")).toHaveText("BB-1051");
    await expect(page.getByRole("button", { name: "Review change", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Review change", exact: true }).click();
    await expect(page.locator(".proposal-screen")).toBeVisible();
    await expect(page.getByText("Accepted by you")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("connection-status")).toContainText("Connected");
    await expect(trail(page)).toHaveAttribute("data-guidance-status", "paused");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(notes(page)).toContainText("Check the fresh proposal");
    await page.getByRole("button", { name: "Accept 1 change", exact: true }).click();
    await expect(page.getByText("Accepted by you")).toBeVisible();
    await page.getByRole("button", { name: "Return to work", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
    await expect(trail(second)).toHaveCount(0);
  } finally { await second.close(); }
});

test("runs an Audit guide through the same notes and trail and pauses on manual navigation", async ({ page }) => {
  await openWorkspace(page);
  await page.getByPlaceholder("Message...").fill("Find BB-1042, open it, and highlight the evidence.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("I found the order and showed the relevant evidence.")).toBeVisible();
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await page.getByRole("button", { name: "Explain Audit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show me", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show me", exact: true }).click();
  await expect(notes(page)).toBeVisible();
  await expect(trail(page)).toBeVisible();
  await expect(page.getByLabel("Search audit history")).toBeVisible();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(trail(page)).toHaveAttribute("data-guidance-status", "paused");
  await expect(page.locator('[data-view="work"]')).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await page.locator("[data-audit-request-id]").first().getByRole("button").click();
  await page.locator("[data-attempt-id]").first().getByRole("button").click();
  await page.getByRole("tab", { name: "Application result", exact: true }).click();
  await expect(trail(page)).toHaveAttribute("data-guidance-status", "complete");
  await page.getByRole("button", { name: "Dismiss guide", exact: true }).click();
  await expect(trail(page)).toHaveCount(0);
  await expect(notes(page)).toHaveCount(0);
});

test("explains the displayed ready proposal when another tab prepares a held proposal", async ({ page, context }) => {
  await openWorkspace(page);
  const second = await context.newPage();
  try {
    await openWorkspace(second);
    await page.getByRole("button", { name: "Review ready orders" }).click();
    await second.getByRole("button", { name: "Advance stock scenario" }).click();
    await expect(second.getByRole("status")).toContainText("Scenario advanced");
    await page.getByRole("button", { name: /Accept \d+ changes/ }).click();
    await page.getByRole("button", { name: "Show me", exact: true }).click();
    await page.getByRole("button", { name: "Review change", exact: true }).click();
    await expect(page.getByRole("button", { name: "Accept 1 change", exact: true })).toBeEnabled();
    await expect(trail(page)).toHaveAttribute("data-guidance-step", "2");

    await second.locator("#target-order-BB-1076").click();
    await second.getByRole("button", { name: "Review change", exact: true }).click();
    await expect(second.getByRole("button", { name: "Held", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Accept 1 change", exact: true })).toBeEnabled();

    await page.getByPlaceholder("Message...").fill("Explain the action on this review.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(notes(page)).toContainText("The earlier proposal is stale. Nothing was applied.");
    await expect(page.getByPlaceholder("Message...")).toBeEnabled();
    await expect(trail(page)).toHaveAttribute("data-guidance-step", "2");
    await page.getByRole("button", { name: "Accept 1 change", exact: true }).click();
    await expect(page.getByText("Accepted by you")).toBeVisible();
    await page.getByRole("button", { name: "Return to work", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
    await expect(trail(page)).toHaveAttribute("data-guidance-status", "complete");
    await expect(second.getByRole("button", { name: "Held", exact: true })).toBeDisabled();
  } finally { await second.close(); }
});
