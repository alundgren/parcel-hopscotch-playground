import { createHash } from "node:crypto";
import { test as base, type Page, type TestInfo } from "@playwright/test";

const identityHeader = "Cf-Access-Authenticated-User-Email";

export const test = base.extend<{ testIdentity: void }>({
  testIdentity: [async ({ context }, use, testInfo) => {
    const key = `${testInfo.testId}:${testInfo.retry}:${testInfo.repeatEachIndex}`;
    const id = createHash("sha256").update(key).digest("hex").slice(0, 20);
    await context.setExtraHTTPHeaders({ [identityHeader]: `e2e-${id}@example.test` });
    await use();
  }, { auto: true }],
});

export const capture = async (page: Page, testInfo: TestInfo, filename: string) => {
  if (process.env.E2E_VISUAL_PROOF !== "true") return;
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => image.decode()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path: testInfo.outputPath(filename), fullPage: true });
};
