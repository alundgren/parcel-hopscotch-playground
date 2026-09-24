import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { paidTurnDecision, readAccounting, reconcileInterrupted, unavailableUsage } from '../../qa/parcel/accounting.mjs';

const exec = promisify(execFile);
const adapter = fileURLToPath(new URL('../../qa/parcel/adapter.mjs', import.meta.url));
const run = async (script, flags, environment = process.env) => {
  const { stdout } = await exec(process.execPath, [script, ...flags], { env: environment, maxBuffer: 3_000_000, timeout: 140_000 });
  return JSON.parse(stdout);
};

test('ledger includes every attempt and stops on unknown cost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-ledger-'));
  const path = join(directory, 'ledger.sqlite');
  let database;
  try {
    database = new DatabaseSync(path);
    database.exec('CREATE TABLE provider_attempts (mode TEXT, outcome TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER); CREATE TABLE agent_turns (status TEXT)');
    const insert = database.prepare('INSERT INTO provider_attempts VALUES (?, ?, ?, ?, ?)');
    for (let index = 0; index < 120; index++) insert.run('live', 'success', 0.001, 3, 2);
    insert.run('scripted', 'success', 0, 5, 4);
    let usage = readAccounting(path, 'live');
    assert.equal(usage.requestCount, 121);
    assert.ok(Math.abs(usage.knownCostUsd - 0.12) < 1e-9);
    assert.deepEqual(paidTurnDecision(usage, 0.1, null), { allowed: false, reason: 'budget_reached' });
    insert.run('live', 'error', null, null, null);
    usage = readAccounting(path, 'live');
    assert.equal(usage.unknownCostRequests, 1);
    assert.deepEqual(paidTurnDecision(usage, 0.1, null), { allowed: false, reason: 'unknown_cost' });
  } finally { try { database?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});

test('live mode requires its own explicit key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-no-key-'));
  try {
    const environment = { ...process.env };
    delete environment.PARCEL_QA_API_KEY;
    await assert.rejects(run(adapter, ['serve', '--run-dir', directory, '--mode', 'live'], environment), /PARCEL_QA_API_KEY is required/);
    await assert.rejects(stat(join(directory, 'parcel-session.json')), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('adapter rejects trace recording for live mode before starting a session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-trace-mode-'));
  try {
    await assert.rejects(run(adapter, ['serve', '--run-dir', directory, '--mode', 'live', '--record-trace', 'true']), /only in offline mode/);
    await assert.rejects(stat(join(directory, 'parcel-session.json')), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing accounting cannot authorize a paid turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-missing-ledger-'));
  let database;
  try {
    const path = join(directory, 'missing.sqlite');
    assert.throws(() => readAccounting(path, 'live'), /accounting is unavailable/);
    database = new DatabaseSync(path);
    database.exec('CREATE TABLE unrelated (id INTEGER)');
    assert.throws(() => readAccounting(path, 'live'), /accounting is unavailable/);
    assert.deepEqual(paidTurnDecision(unavailableUsage(), 0.1, null), { allowed: false, reason: 'accounting_unavailable' });
  } finally { try { database?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});

test('shutdown marks unfinished calls as unknown liability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-interrupted-'));
  const path = join(directory, 'ledger.sqlite');
  let database;
  try {
    database = new DatabaseSync(path);
    database.exec("CREATE TABLE provider_attempts (mode TEXT, outcome TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, completed_at TEXT, error_code TEXT); CREATE TABLE agent_turns (status TEXT, finished_at TEXT, error_message TEXT); INSERT INTO provider_attempts (mode,outcome,cost_usd) VALUES ('live','running',NULL); INSERT INTO agent_turns (status) VALUES ('running')");
    reconcileInterrupted(path);
    assert.equal(database.prepare('SELECT outcome FROM provider_attempts').get().outcome, 'interrupted');
    assert.equal(database.prepare('SELECT status FROM agent_turns').get().status, 'interrupted');
    const usage = readAccounting(path, 'live');
    assert.equal(usage.unknownCostRequests, 1);
    assert.equal(paidTurnDecision(usage, 0.1, null).reason, 'unknown_cost');
  } finally { try { database?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});
