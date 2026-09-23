#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  closeRun, createRun, loadRun, packetFor, promoteMemory, runDecision, updateRun,
} from '../tools/qa-loop/core.mjs';

const exec = promisify(execFile);
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roles = new Set(['coordinator', 'explorer', 'investigator', 'verifier']);
const maximumInputBytes = 1024 * 1024;

function parseArguments(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || rest[index + 1] === undefined || Object.hasOwn(options, flag.slice(2))) {
      throw new Error('Use unique --name value options.');
    }
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

async function jsonFile(file) {
  if ((await stat(file)).size > maximumInputBytes) throw new Error('JSON input exceeds one MiB.');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function inputJson(options) {
  if (options.input && options.input !== '-') return jsonFile(path.resolve(options.input));
  if (!options.input) throw new Error('--input FILE or --input - is required.');
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > maximumInputBytes) throw new Error('JSON input exceeds one MiB.');
  }
  return JSON.parse(text);
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text.`);
  return value;
}

function numeric(value, fallback, label) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label} must be positive.`);
  return result;
}

async function repositoryFile(relative) {
  text(relative, 'Repository path');
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Repository paths must stay within the checkout.');
  const resolved = await realpath(path.join(repositoryRoot, relative));
  if (!resolved.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('Repository path leaves the checkout.');
  return resolved;
}

function reference(definition) {
  return {
    id: text(definition.id, 'Definition id'),
    version: text(definition.version, 'Definition version'),
    digest: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
}

async function privateJson(file, value) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); }
  finally { await handle.close(); }
}

export async function initialize(options = {}) {
  if (!['live', 'offline'].includes(options.mode)) throw new Error('Choose --mode live or --mode offline explicitly.');
  const config = await jsonFile(await repositoryFile(options.config ?? 'qa/config.json'));
  if (config.schemaVersion !== 1 || !Array.isArray(config.scenarios) || !config.scenarios.length) throw new Error('Unsupported QA config.');
  const persona = await jsonFile(await repositoryFile(config.persona));
  const scenarios = await Promise.all(config.scenarios.map(async (file) => jsonFile(await repositoryFile(file))));
  const expectations = await jsonFile(await repositoryFile(config.expectations));
  const memoryFile = await repositoryFile(config.memoryFile);
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const rootDir = options.root ? path.resolve(options.root) : undefined;
  if (rootDir === repositoryRoot || rootDir?.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('Raw QA runs must be stored outside the repository.');
  const created = await createRun({
    ...(rootDir ? { rootDir } : {}),
    revision,
    settings: {
      durationMinutes: numeric(options.minutes, config.defaults.durationMinutes, 'Minutes'),
      budgetUsd: numeric(options.budget, config.defaults.budgetUsd, 'Budget'),
    },
    model: {
      explorerRequested: `${config.defaults.explorerModel}/${config.defaults.explorerEffort}`,
      actual: 'Record runtime-reported roles in the session evidence; a requested model is not proof of the actual model.',
      providerMode: options.mode,
    },
    persona: reference(persona), scenarios: scenarios.map(reference), memoryFile,
  });
  await privateJson(path.join(created.runDir, 'context.json'), {
    schemaVersion: 1, repositoryRoot, config, mode: options.mode, persona, scenarios, expectations,
  });
  return { ...created, mode: options.mode, next: `node scripts/qa.mjs serve --run ${created.runDir}` };
}

async function contextFor(runDir) {
  const run = await loadRun({ runDir });
  const handle = await open(path.join(runDir, 'context.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let context;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > maximumInputBytes) throw new Error('Unsafe QA context file.');
    context = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  if (context.schemaVersion !== 1 || context.repositoryRoot !== repositoryRoot || !['live', 'offline'].includes(context.mode)) {
    throw new Error('Run belongs to another checkout or has invalid context.');
  }
  if (JSON.stringify(reference(context.persona)) !== JSON.stringify(run.persona)
    || JSON.stringify(context.scenarios.map(reference)) !== JSON.stringify(run.scenarios)) {
    throw new Error('Run definitions differ from their recorded versions.');
  }
  return context;
}

async function adapterCall(runDir, command, extra = []) {
  const context = await contextFor(runDir);
  const adapter = await repositoryFile(context.config.adapter);
  const result = await exec(process.execPath, [adapter, command, '--run-dir', runDir, ...extra], {
    cwd: repositoryRoot, timeout: 240_000, maxBuffer: 4 * maximumInputBytes,
  });
  return JSON.parse(result.stdout);
}

export function cumulativeUsage(status) {
  if (!status?.usage) throw new Error('Adapter did not return cumulative app usage.');
  return Object.fromEntries(['knownCostUsd', 'unknownCostRequests', 'inputTokens', 'outputTokens', 'requestCount']
    .map((key) => [key, status.usage[key]]));
}

async function recordUsage(runDir, status) {
  const usage = cumulativeUsage(status);
  const run = await loadRun({ runDir });
  if (run.status === 'active') return updateRun({ runDir, event: { type: 'usage.record', usage } });
  return run;
}

export async function sessionStatus(runDir) {
  const adapter = await adapterCall(runDir, 'status');
  let run = await recordUsage(runDir, adapter);
  if (run.status === 'active' && run.inFlight && !adapter.busy) {
    run = await updateRun({ runDir, event: { type: 'turn.finish', id: run.inFlight.id, usage: cumulativeUsage(adapter) } });
  }
  return { run, adapter, decision: runDecision(run, { adapterBusy: adapter.busy }) };
}

export async function generatePacket(runDir, role, scenarioId) {
  if (!roles.has(role)) throw new Error('Unknown QA role.');
  const context = await contextFor(runDir);
  let run = await loadRun({ runDir });
  const instructions = await readFile(path.join(repositoryRoot, 'tools/qa-loop/skill/roles', `${role}.md`), 'utf8');
  if (role === 'explorer') {
    const scenario = context.scenarios.find((entry) => entry.id === scenarioId);
    if (!scenario) throw new Error('--scenario must identify a configured mission.');
    run = await updateRun({ runDir, event: { type: 'scenario.start', scenarioId } });
    const browserProcedure = [
      `Work in ${repositoryRoot}.`,
      `Use node scripts/qa.mjs browser --run ${runDir} --input - and provide one JSON request through stdin.`,
      'Commands: {"action":"snapshot"}, {"action":"chat","text":"your question"}, {"action":"click","locator":{"by":"role","role":"button","name":"visible name"}}, {"action":"fill","locator":{"by":"placeholder","placeholder":"visible placeholder"},"text":"value"}, {"action":"press","locator":{"by":"role","role":"textbox","name":"visible name"},"key":"Enter"}, {"action":"screenshot","label":"state"}, {"action":"viewport","width":320,"height":900}, {"action":"reload"}.',
      'Use the returned visible controls. Inspect screenshot files with the image tool. Do not read other run files or use the verify, event, packet, or direct adapter commands.',
      'Report the observation IDs returned by the browser wrapper. Stop on a time or spending limit. Budget, permission, and adapter failures are test obstacles, not proof of a product defect.',
    ].join(' ');
    return { instructions, ...packetFor(run, role, {
      persona: JSON.stringify(context.persona), mission: JSON.stringify(scenario), browserProcedure,
    }) };
  }
  return { instructions, ...packetFor(run, role, {
    source: { revision: run.revision, repositoryRoot, verifierCommand: `node scripts/qa.mjs verify --run ${runDir}` },
    expected: context.expectations,
  }) };
}

export async function browserCommand(runDir, request) {
  const run = await loadRun({ runDir });
  if (run.status !== 'active' || !run.currentScenarioId) throw new Error('Start a mission before using the browser.');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Browser request must be an object.');
  let turnId = null;
  if (request.action === 'chat') {
    const before = await sessionStatus(runDir);
    if (!before.decision.allowNewTurn) throw new Error(`New app turn stopped: ${before.decision.reason}`);
    turnId = randomUUID();
    await updateRun({ runDir, event: { type: 'turn.start', id: turnId, scenarioId: run.currentScenarioId } });
  }
  const started = performance.now();
  let response;
  let failure;
  try { response = await adapterCall(runDir, 'command', ['--request', JSON.stringify(request)]); }
  catch (error) { failure = error; }
  const durationMs = Math.round(performance.now() - started);
  let status = await adapterCall(runDir, 'status');
  const waitUntil = Math.min(Date.now() + 180_000, Date.parse(run.createdAt) + run.settings.durationMinutes * 60_000 + 5000);
  while (!failure && status.busy && Date.now() < waitUntil) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    status = await adapterCall(runDir, 'status');
  }
  await recordUsage(runDir, status);
  const currentRun = await loadRun({ runDir });
  if (currentRun.inFlight && !status.busy) {
    await updateRun({ runDir, event: { type: 'turn.finish', id: currentRun.inFlight.id, usage: cumulativeUsage(status) } });
  }
  const observationId = randomUUID();
  const evidenceName = `browser-${observationId}.json`;
  await privateJson(path.join(runDir, evidenceName), {
    request, response: response ?? null, failure: failure ? 'Adapter command failed; inspect local adapter evidence.' : null,
    adapterCommandDurationMs: durationMs, usage: status.usage,
  });
  await updateRun({ runDir, event: {
    type: 'observation.add', observation: {
      id: observationId, scenarioId: run.currentScenarioId, at: new Date().toISOString(),
      action: `Browser ${text(request.action, 'Browser action')}`,
      result: failure ? 'Adapter command failed. See local evidence; do not infer product failure.' : 'Browser command completed. See local evidence for the observed UI and outcome.',
      durationMs, evidence: evidenceName,
    },
  } });
  if (failure) throw new Error(`Adapter command failed. Observation ${observationId}; local evidence ${evidenceName}.`);
  return { observationId, response, busy: status.busy, appUsage: cumulativeUsage(status), adapterCommandDurationMs: durationMs };
}

async function serve(runDir) {
  const context = await contextFor(runDir);
  const run = await loadRun({ runDir });
  if (run.status !== 'active') throw new Error('Run is closed.');
  const remainingMinutes = (Date.parse(run.createdAt) + run.settings.durationMinutes * 60_000 - Date.now()) / 60_000;
  if (remainingMinutes <= 0) throw new Error('Run time limit has elapsed.');
  const adapter = await repositoryFile(context.config.adapter);
  const child = spawn(process.execPath, [adapter, 'serve', '--run-dir', runDir, '--mode', context.mode,
    '--budget-usd', String(run.settings.budgetUsd), '--duration-minutes', String(remainingMinutes)], {
    cwd: repositoryRoot, stdio: 'inherit', env: process.env,
  });
  const forward = (signal) => { if (child.exitCode === null) child.kill(signal); };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 || signal ? resolve() : reject(new Error(`QA adapter exited with code ${code}.`)));
    });
  } finally {
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  }
}

async function stop(runDir, reason) {
  await adapterCall(runDir, 'stop');
  const status = await adapterCall(runDir, 'status');
  let run = await recordUsage(runDir, status);
  if (run.inFlight) run = await updateRun({ runDir, event: { type: 'turn.finish', id: run.inFlight.id, usage: cumulativeUsage(status) } });
  return closeRun({ runDir, reason });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  const runDir = options.run ? path.resolve(options.run) : null;
  const requireRun = () => { if (!runDir) throw new Error('--run PATH is required.'); return runDir; };
  switch (command) {
    case 'help': return {
      commands: ['init --mode live|offline [--minutes 120] [--budget 0.1]', 'serve --run PATH',
        'packet --run PATH --role explorer --scenario ID', 'packet --run PATH --role coordinator|investigator|verifier',
        'browser --run PATH --input FILE|-', 'status --run PATH', 'verify --run PATH',
        'event --run PATH --input FILE|-', 'promote --run PATH --input FILE|-',
        'resume --run PATH', 'stop --run PATH [--reason TEXT]', 'show --run PATH'],
      scope: 'Only app inference counts toward the spending threshold. Raw evidence remains local. No scheduled or automatic paid runs.',
    };
    case 'init': return initialize(options);
    case 'serve': await serve(requireRun()); return null;
    case 'packet': return generatePacket(requireRun(), options.role, options.scenario);
    case 'browser': return browserCommand(requireRun(), await inputJson(options));
    case 'status': return sessionStatus(requireRun());
    case 'show': return loadRun({ runDir: requireRun() });
    case 'verify': return adapterCall(requireRun(), 'verify');
    case 'event': return updateRun({ runDir: requireRun(), event: await inputJson(options) });
    case 'promote': {
      const context = await contextFor(requireRun());
      const selected = await inputJson(options);
      if (!selected || Object.keys(selected).some((key) => !['lessons', 'regressions'].includes(key))) {
        throw new Error('Promotion input may contain only selected lessons and regressions.');
      }
      return promoteMemory({ ...selected, runDir, memoryFile: await repositoryFile(context.config.memoryFile) });
    }
    case 'resume': {
      const { run, adapter } = await sessionStatus(requireRun());
      if (adapter.busy) throw new Error('An app turn is still running.');
      if (run.inFlight) await updateRun({ runDir, event: { type: 'turn.finish', id: run.inFlight.id, usage: cumulativeUsage(adapter) } });
      return sessionStatus(runDir);
    }
    case 'stop': return stop(requireRun(), options.reason ?? 'Session completed; unfinished findings retained.');
    default: throw new Error(`Unknown QA command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((result) => { if (result !== null) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
