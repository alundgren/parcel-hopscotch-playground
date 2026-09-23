import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";

const allocatePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("Could not allocate a Playwright server port."));
      server.close();
      return;
    }
    server.close(() => resolve(address.port));
  });
});
const port = process.env.PARCEL_E2E_PORT === undefined
  ? await allocatePort()
  : Number(process.env.PARCEL_E2E_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Playwright server port.");
// Playwright workers load this config again and must use the same server port.
process.env.PARCEL_E2E_PORT = String(port);
const origin = `http://127.0.0.1:${port}`;
if (process.env.PARCEL_E2E_DATABASE_PATH === undefined) {
  throw new Error("Start Playwright with vp run test:e2e or scripts/run-e2e.mjs.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: origin,
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
      testMatch: /(?:workspace|tutorials)\.spec\.ts/,
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
        `vp run build && NODE_ENV=test AGENT_PROVIDER_MODE=scripted ENABLE_DEV_IDENTITY=true DEV_USER_EMAIL=playwright@example.test PUBLIC_ORIGIN=${origin} DATABASE_PATH="$PARCEL_E2E_DATABASE_PATH" HOST=127.0.0.1 PORT=${port} vp run start`,
      url: `${origin}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
