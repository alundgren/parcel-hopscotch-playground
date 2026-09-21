import { rm } from "node:fs/promises";

for (const suffix of ["", "-shm", "-wal"]) {
  await rm(`.tmp/playwright.sqlite${suffix}`, { force: true });
}
