import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { loadConfig } from "../../src/server/config";

const baseEnvironment = {
  NODE_ENV: "production",
  HOST: "0.0.0.0",
  PORT: "3000",
  PUBLIC_ORIGIN: "https://parcel.example.test",
  DATABASE_PATH: "/data/parcel.sqlite",
  ENABLE_DEV_IDENTITY: "false",
};

describe("server configuration", () => {
  it("accepts the complete production container contract", async () => {
    const config = await Effect.runPromise(loadConfig({
      ...baseEnvironment,
      AGENT_PROVIDER_MODE: "live",
      OPENROUTER_API_KEY: "local-test-key",
    }));

    expect(config).toMatchObject({
      environment: "production",
      host: "0.0.0.0",
      port: 3000,
      publicOrigin: "https://parcel.example.test",
      databasePath: "/data/parcel.sqlite",
      allowDevelopmentIdentity: false,
      developmentEmail: null,
      agentMode: "live",
      openRouterApiKey: "local-test-key",
    });
  });

  it("rejects a production development-identity fallback", async () => {
    await expect(Effect.runPromise(loadConfig({
      ...baseEnvironment,
      ENABLE_DEV_IDENTITY: "true",
      DEV_USER_EMAIL: "demo@example.test",
      AGENT_PROVIDER_MODE: "scripted",
    }))).rejects.toMatchObject({
      message: "Development identity cannot be enabled in production.",
    });
  });

  it("rejects live mode without a server key", async () => {
    await expect(Effect.runPromise(loadConfig({
      ...baseEnvironment,
      AGENT_PROVIDER_MODE: "live",
      OPENROUTER_API_KEY: "  ",
    }))).rejects.toMatchObject({
      message: "OPENROUTER_API_KEY is required when the live agent provider is enabled.",
    });
  });

  it("runs scripted local work without a paid-provider key", async () => {
    const config = await Effect.runPromise(loadConfig({
      ...baseEnvironment,
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PUBLIC_ORIGIN: "http://127.0.0.1:5173",
      DATABASE_PATH: "./data/parcel.sqlite",
      ENABLE_DEV_IDENTITY: "true",
      DEV_USER_EMAIL: "demo@example.test",
      AGENT_PROVIDER_MODE: "scripted",
    }));

    expect(config.agentMode).toBe("scripted");
    expect(config.openRouterApiKey).toBeNull();
    expect(config.allowDevelopmentIdentity).toBe(true);
  });
});
