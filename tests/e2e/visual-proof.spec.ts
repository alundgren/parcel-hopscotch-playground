import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

type MainView = "Work" | "Explore" | "Audit";

const capture = async (page: Page, path: string) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, animations: "disabled" });
};

const comparison = async (
  browser: Browser,
  testInfo: TestInfo,
  view: MainView,
  referencePath: string,
  actualPath: string,
) => {
  const viewport = testInfo.project.use.viewport ?? { width: 1440, height: 1000 };
  const captionHeight = viewport.width <= 560 ? 64 : 32;
  const [reference, actual] = await Promise.all([readFile(referencePath), readFile(actualPath)]);
  const context = await browser.newContext({ viewport: { width: viewport.width * 2 + 48, height: viewport.height + captionHeight + 32 } });
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html>
      <html><head><style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 16px; background: #d9ddd8; color: #334e5b; font: 600 16px system-ui, sans-serif; }
        main { display: grid; grid-template-columns: ${viewport.width}px ${viewport.width}px; gap: 16px; }
        figure { margin: 0; }
        figcaption { height: ${captionHeight}px; padding: 4px 8px; }
        img { display: block; width: ${viewport.width}px; height: ${viewport.height}px; object-fit: cover; object-position: top left; }
      </style></head><body><main>
        <figure><figcaption>Approved reference · ${view} · ${viewport.width}×${viewport.height}</figcaption><img src="data:image/png;base64,${reference.toString("base64")}"></figure>
        <figure><figcaption>Actual implementation · ${view} · ${viewport.width}×${viewport.height}</figcaption><img src="data:image/png;base64,${actual.toString("base64")}"></figure>
      </main></body></html>`);
    const path = testInfo.outputPath(`comparison-${view.toLowerCase()}-${testInfo.project.name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await testInfo.attach(`${view} ${testInfo.project.name} comparison`, { path, contentType: "image/png" });
  } finally {
    await context.close();
  }
};

test("captures approved and actual Work, Explore, and Audit at the project viewport", async ({ page, context, browser }, testInfo) => {
  const viewport = testInfo.project.use.viewport ?? { width: 1440, height: 1000 };
  await context.setExtraHTTPHeaders({
    "Cf-Access-Authenticated-User-Email": `visual-proof-${testInfo.project.name}@example.test`,
  });
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await expect(page.getByRole("button", { name: "All 24" })).toBeVisible();
  await page.getByPlaceholder("Message...").fill("What needs my attention?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("I grouped the current queue and opened Work so you can review what is ready and what still needs a decision.")).toBeVisible();

  const actualPaths = new Map<MainView, string>();
  const workPath = testInfo.outputPath(`actual-work-${testInfo.project.name}.png`);
  await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
  await capture(page, workPath);
  actualPaths.set("Work", workPath);

  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Explore" })).toBeVisible();
  await expect(page.getByText("16 tools", { exact: true })).toBeVisible();
  const explorePath = testInfo.outputPath(`actual-explore-${testInfo.project.name}.png`);
  await capture(page, explorePath);
  actualPaths.set("Explore", explorePath);

  await page.getByRole("button", { name: "View in Audit: Test a judgement" }).click();
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await expect(page.locator(".audit-summary").first()).toBeVisible();
  await expect(page.getByLabel("Search audit history")).not.toHaveValue("");
  await expect(page.getByRole("tab", { name: "Application result" })).toHaveAttribute("aria-selected", "true");
  const auditPath = testInfo.outputPath(`actual-audit-${testInfo.project.name}.png`);
  await capture(page, auditPath);
  actualPaths.set("Audit", auditPath);

  const referenceContext = await browser.newContext({ viewport });
  const referencePage = await referenceContext.newPage();
  const prototypeUrl = pathToFileURL(resolve("docs/design/approved-prototype.html")).href;
  try {
    for (const view of ["Work", "Explore", "Audit"] as const) {
      await referencePage.goto(prototypeUrl);
      if (view === "Audit") {
        await referencePage.getByRole("button", { name: "Explore", exact: true }).click();
        await referencePage.getByRole("button", { name: "View in Audit: Test a judgement" }).click();
        await expect(referencePage.getByLabel("Filter audit requests")).toHaveValue("BB-1076");
        await expect(referencePage.getByRole("tab", { name: "Application result" })).toHaveAttribute("aria-selected", "true");
      } else {
        await referencePage.getByRole("button", { name: view, exact: true }).click();
      }
      await expect(referencePage.getByRole("button", { name: view, exact: true })).toHaveAttribute("aria-current", "page");
      const referencePath = testInfo.outputPath(`reference-${view.toLowerCase()}-${testInfo.project.name}.png`);
      await capture(referencePage, referencePath);
      await comparison(browser, testInfo, view, referencePath, actualPaths.get(view)!);
      await testInfo.attach(`${view} ${testInfo.project.name} reference`, { path: referencePath, contentType: "image/png" });
      await testInfo.attach(`${view} ${testInfo.project.name} actual`, { path: actualPaths.get(view)!, contentType: "image/png" });
    }
  } finally {
    await referenceContext.close();
  }
});
