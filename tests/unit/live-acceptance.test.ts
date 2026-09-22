import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("checks the live runner's factual assertions and failure handling without inference", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/live-acceptance.mjs", "--self-test"]);
  expect(stdout).toContain("overview facts, and SQLite contention checks passed. No inference run.");
});
