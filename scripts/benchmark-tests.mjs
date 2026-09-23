import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { cpus, platform, arch, release } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "local" },
    runs: { type: "string", default: "3" },
    suites: { type: "string", default: "unit,integration,browser,e2e,proof" },
    output: { type: "string", default: "artifacts/test-timings" },
  },
});
const repeats = Number(values.runs);
const commands = {
  unit: ["run", "test:unit"],
  integration: ["run", "test:integration"],
  browser: ["run", "test:browser"],
  e2e: ["run", "test:e2e"],
  proof: ["run", "proof:visual"],
};
const suites = values.suites.split(",");
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10 || suites.some((suite) => !commands[suite])) {
  throw new Error("Use between 1 and 10 runs and suites from unit,integration,browser,e2e,proof.");
}
if (!/^[a-zA-Z0-9_-]+$/.test(values.label)) throw new Error("Use letters, numbers, underscores or hyphens in the label.");
const directory = resolve(values.output, values.label);
mkdirSync(directory, { recursive: true });
const read = (command, args) => spawnSync(command, args, { encoding: "utf8" }).stdout?.trim();
const report = {
  label: values.label,
  startedAt: new Date().toISOString(),
  revision: read("git", ["rev-parse", "HEAD"]),
  dirty: Boolean(read("git", ["status", "--porcelain"])),
  node: process.version,
  toolchain: read("vp", ["--version"]),
  system: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, cpuCount: cpus().length },
  runs: [],
};
for (const suite of suites) {
  for (let iteration = 1; iteration <= repeats; iteration++) {
    const log = resolve(directory, `${suite}-${iteration}.log`);
    const fd = openSync(log, "w");
    const start = performance.now();
    const result = spawnSync("vp", commands[suite], {
      stdio: ["ignore", fd, fd],
      timeout: 600_000,
    });
    closeSync(fd);
    const run = {
      suite, iteration, command: ["vp", ...commands[suite]],
      seconds: Number(((performance.now() - start) / 1000).toFixed(3)),
      exitCode: result.status, signal: result.signal, error: result.error?.message, log,
    };
    report.runs.push(run);
    writeFileSync(resolve(directory, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${suite} ${iteration}/${repeats}: ${run.seconds}s, exit ${run.exitCode}, ${log}`);
    if (result.status !== 0) process.exit(1);
  }
}
