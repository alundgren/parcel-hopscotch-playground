import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { Effect } from "effect";
import type { ServerConfig } from "../../src/server/config";
import { resolveIdentity } from "../../src/server/identity";
import { runWithWorkspaceRepository, WorkspaceRepository } from "../../src/server/persistence";

const [filename, email, action, proposalId, gate] = process.argv.slice(2);
if (filename === undefined || email === undefined || action === undefined || proposalId === undefined || gate === undefined) process.exit(2);
const config: ServerConfig = { environment: "production", host: "127.0.0.1", port: 0, publicOrigin: "https://parcel.example.test", databasePath: filename, allowDevelopmentIdentity: false, developmentEmail: null, agentMode: "unavailable", openRouterApiKey: null };
const identity = Effect.runSync(resolveIdentity(["Cf-Access-Authenticated-User-Email", email], config));
while (!existsSync(gate)) await wait(5);
try {
  if (action === "accept") {
    const result = await runWithWorkspaceRepository(filename, Effect.flatMap(WorkspaceRepository, (repository) => repository.accept(identity, 1, proposalId, "cross-process-key")));
    process.stdout.write(JSON.stringify({ ok: true, kind: result.receipt.kind }));
  } else {
    await runWithWorkspaceRepository(filename, Effect.flatMap(WorkspaceRepository, (repository) => repository.advanceScenario(identity, 1)));
    process.stdout.write(JSON.stringify({ ok: true, kind: "scenario" }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: typeof error === "object" && error !== null && "code" in error ? error.code : "unknown" }));
}
