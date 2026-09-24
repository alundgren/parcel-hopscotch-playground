import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const databasePath = resolve(".tmp", `playwright-${process.pid}-${randomUUID()}.sqlite`);
await mkdir(dirname(databasePath), { recursive: true });

const child = spawn("vp", ["exec", "playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, PARCEL_E2E_DATABASE_PATH: databasePath },
});
const forwardInterrupt = () => { child.kill("SIGINT"); };
const forwardTermination = () => { child.kill("SIGTERM"); };
process.on("SIGINT", forwardInterrupt);
process.on("SIGTERM", forwardTermination);

try {
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  process.exitCode = result.code ?? 1;
} finally {
  process.off("SIGINT", forwardInterrupt);
  process.off("SIGTERM", forwardTermination);
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    await rm(`${databasePath}${suffix}`, { force: true });
  }
}
