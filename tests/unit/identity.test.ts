import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { ServerConfig } from "../../src/server/config";
import { resolveIdentity } from "../../src/server/identity";

const production: ServerConfig = {
  environment: "production",
  host: "127.0.0.1",
  port: 3000,
  publicOrigin: "https://parcel.example.test",
  databasePath: ":memory:",
  allowDevelopmentIdentity: false,
  developmentEmail: null,
  agentMode: "unavailable",
  openRouterApiKey: null,
};

const result = (headers: ReadonlyArray<string>, config = production) =>
  Effect.runPromise(Effect.result(resolveIdentity(headers, config)));

describe("request identity", () => {
  it("accepts one valid production identity without exposing the email", async () => {
    const resolved = await result([
      "Cf-Access-Authenticated-User-Email",
      "Person@Example.Test",
    ]);
    expect(resolved._tag).toBe("Success");
    if (resolved._tag === "Success") {
      expect(resolved.success.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(JSON.stringify(resolved.success)).not.toContain("person@example.test");
    }
  });

  it("rejects production requests without the trusted header", async () => {
    const resolved = await result([]);
    expect(resolved._tag).toBe("Failure");
    if (resolved._tag === "Failure") expect(resolved.failure.code).toBe("missing_identity");
  });

  it("rejects duplicate identity headers", async () => {
    const resolved = await result([
      "Cf-Access-Authenticated-User-Email",
      "one@example.test",
      "cf-access-authenticated-user-email",
      "two@example.test",
    ]);
    expect(resolved._tag).toBe("Failure");
    if (resolved._tag === "Failure") expect(resolved.failure.code).toBe("duplicate_identity");
  });

  it.each(["not-an-email", "a@example.test,b@example.test", "@example.test"])(
    "rejects malformed identity %s",
    async (email) => {
      const resolved = await result(["Cf-Access-Authenticated-User-Email", email]);
      expect(resolved._tag).toBe("Failure");
      if (resolved._tag === "Failure") expect(resolved.failure.code).toBe("malformed_identity");
    },
  );

  it("uses fallback only when development enables it", async () => {
    const disabled = await result([], { ...production, environment: "development" });
    expect(disabled._tag).toBe("Failure");
    if (disabled._tag === "Failure") {
      expect(disabled.failure.code).toBe("development_identity_disabled");
    }

    const enabled = await result([], {
      ...production,
      environment: "development",
      allowDevelopmentIdentity: true,
      developmentEmail: "developer@example.test",
    });
    expect(enabled._tag).toBe("Success");
  });
});
