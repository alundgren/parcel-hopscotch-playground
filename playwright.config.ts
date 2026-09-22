import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        video: {
          mode: process.env.RECORD_VIDEO === "true" ? "on" : "off",
          size: { width: 1440, height: 1000 },
        },
      },
    },
    {
      name: "narrow",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 900 },
        video: {
          mode: process.env.RECORD_VIDEO === "true" ? "on" : "off",
          size: { width: 320, height: 900 },
        },
      },
    },
  ],
  webServer: [
    {
      command:
        "vp run build && node scripts/clean-playwright-db.mjs && NODE_ENV=test AGENT_PROVIDER_MODE=scripted ENABLE_DEV_IDENTITY=true DEV_USER_EMAIL=playwright@example.test PUBLIC_ORIGIN=http://127.0.0.1:4173 DATABASE_PATH=.tmp/playwright.sqlite HOST=127.0.0.1 PORT=4173 vp run start",
      url: "http://127.0.0.1:4173/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
