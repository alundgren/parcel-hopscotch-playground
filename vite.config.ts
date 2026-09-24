import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import type { BrowserCommand } from "vite-plus/test/node";

const visualProof = process.env.VISUAL_PROOF === "true";
const captureViewport: BrowserCommand<[relativePath: string]> = async (context, relativePath) => {
  if (!visualProof) throw new Error("Viewport screenshots are available only during visual proof.");
  if (context.provider.name !== "playwright") throw new Error("Viewport screenshots require the Playwright provider.");
  if (!/^(browser-desktop|browser-narrow)\/[a-z0-9-]+\.png$/.test(relativePath)) throw new Error("Invalid viewport screenshot path.");
  const outputPath = resolve("artifacts/visual/screenshots", relativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await context.page.screenshot({ path: outputPath, fullPage: false });
  return outputPath;
};

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ["react-markdown"] },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.VITE_SERVER_PORT ?? "3000"}`,
      "/ws": {
        target: `ws://127.0.0.1:${process.env.VITE_SERVER_PORT ?? "3000"}`,
        ws: true,
      },
    },
  },
  test: {
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: visualProof ? ["default", ["html", { outputDir: "artifacts/visual/report" }]] : ["default"],
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          fileParallelism: true,
          maxWorkers: Math.min(4, availableParallelism()),
          include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          fileParallelism: false,
          maxWorkers: 1,
          include: ["tests/browser/**/*.test.tsx"],
          env: { VISUAL_PROOF: visualProof ? "true" : "false" },
          browser: {
            enabled: true,
            headless: true,
            commands: { captureViewport },
            provider: playwright({ contextOptions: { locale: "en-GB", timezoneId: "UTC", reducedMotion: "reduce" } }),
            instances: [
              { browser: "chromium", name: "browser-desktop", viewport: { width: 1440, height: 1000 } },
              { browser: "chromium", name: "browser-narrow", viewport: { width: 320, height: 900 } },
            ],
            screenshotFailures: true,
            screenshotDirectory: "artifacts/visual/failures",
            traceView: { enabled: visualProof, inlineImages: true },
            trace: "retain-on-failure",
          },
        },
      },
    ],
  },
});
