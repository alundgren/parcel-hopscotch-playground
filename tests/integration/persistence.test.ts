import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ServerConfig } from "../../src/server/config";
import { resolveIdentity } from "../../src/server/identity";
import {
  runWithWorkspaceRepository,
  WorkspaceRepository,
} from "../../src/server/persistence";

const paths: Array<string> = [];
const config: ServerConfig = {
  environment: "production",
  host: "127.0.0.1",
  port: 0,
  publicOrigin: "https://parcel.example.test",
  databasePath: ":memory:",
  allowDevelopmentIdentity: false,
  developmentEmail: null,
  agentMode: "unavailable",
  openRouterApiKey: null,
};

const identity = (email: string) =>
  Effect.runSync(
    resolveIdentity(["Cf-Access-Authenticated-User-Email", email], config),
  );

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("personal workspace persistence", () => {
  it("seeds 24 deterministic orders once and preserves them across a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parcel-hopscotch-store-"));
    paths.push(directory);
    const filename = join(directory, "workspace.sqlite");
    const user = identity("restart@example.test");

    const first = await runWithWorkspaceRepository(
      filename,
      Effect.flatMap(WorkspaceRepository, (repository) =>
        repository.snapshot(user, Date.parse("2026-09-21T09:00:00.000Z")),
      ),
    );
    const second = await runWithWorkspaceRepository(
      filename,
      Effect.flatMap(WorkspaceRepository, (repository) =>
        repository.snapshot(user, Date.parse("2026-09-21T09:00:00.000Z")),
      ),
    );

    expect(first.orders).toHaveLength(24);
    expect(second).toEqual(first);
    expect(first.orders.slice(0, 4).map((order) => order.id)).toEqual([
      "BB-1051",
      "BB-1063",
      "BB-1042",
      "BB-1088",
    ]);
    expect(first.orders.filter((order) => order.status === "ready").length).toBeGreaterThanOrEqual(4);
    expect(first.orders.some((order) => order.id === "BB-1102" && order.family === "address")).toBe(true);
    expect(first.orders.some((order) => order.id === "BB-1104" && order.family === "substitution")).toBe(true);
  });

  it("scopes every workspace read to the authenticated internal user", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parcel-hopscotch-users-"));
    paths.push(directory);
    const filename = join(directory, "workspace.sqlite");
    const firstUser = identity("first@example.test");
    const secondUser = identity("second@example.test");

    await runWithWorkspaceRepository(
      filename,
      Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        yield* repository.snapshot(firstUser);
        yield* repository.snapshot(secondUser);
      }),
    );

    const database = new DatabaseSync(filename);
    database
      .prepare("UPDATE orders SET issue = ? WHERE user_id = ? AND order_id = ?")
      .run("Only the first user sees this.", firstUser.id, "BB-1042");
    database.close();

    const snapshots = await runWithWorkspaceRepository(
      filename,
      Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        return yield* Effect.all([
          repository.snapshot(firstUser),
          repository.snapshot(secondUser),
        ]);
      }),
    );
    const firstIssue = snapshots[0].orders.find((order) => order.id === "BB-1042")?.issue;
    const secondIssue = snapshots[1].orders.find((order) => order.id === "BB-1042")?.issue;
    expect(firstIssue).toBe("Only the first user sees this.");
    expect(secondIssue).toBe("Street number needs checking.");
  });
});
