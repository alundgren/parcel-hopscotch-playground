import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { paidTurnDecision, readAccounting, reconcileInterrupted } from './accounting.mjs';

const exec = promisify(execFile);
const adapter = fileURLToPath(new URL('./adapter.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('./verify.mjs', import.meta.url));
const run = async (script, flags, environment = process.env) => {
  const { stdout } = await exec(process.execPath, [script, ...flags], { env: environment, maxBuffer: 3_000_000, timeout: 140_000 });
  return JSON.parse(stdout);
};

test('ledger includes every attempt and stops on unknown cost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-ledger-'));
  const path = join(directory, 'ledger.sqlite');
  try {
    const database = new DatabaseSync(path);
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
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test('shutdown marks unfinished calls as unknown liability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-interrupted-'));
  const path = join(directory, 'ledger.sqlite');
  try {
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE provider_attempts (mode TEXT, outcome TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, completed_at TEXT, error_code TEXT); CREATE TABLE agent_turns (status TEXT, finished_at TEXT, error_message TEXT); INSERT INTO provider_attempts (mode,outcome,cost_usd) VALUES ('live','running',NULL); INSERT INTO agent_turns (status) VALUES ('running')");
    reconcileInterrupted(path);
    assert.equal(database.prepare('SELECT outcome FROM provider_attempts').get().outcome, 'interrupted');
    assert.equal(database.prepare('SELECT status FROM agent_turns').get().status, 'interrupted');
    const usage = readAccounting(path, 'live');
    assert.equal(usage.unknownCostRequests, 1);
    assert.equal(paidTurnDecision(usage, 0.1, null).reason, 'unknown_cost');
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('offline browser actions, verifier facts, gate, and cleanup', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-browser-'));
  let started = false;
  try {
    const initial = await run(adapter, ['serve', '--run-dir', directory, '--mode', 'offline', '--budget-usd', '0.1', '--duration-minutes', '3']);
    started = true;
    assert.equal(initial.mode, 'offline');
    assert.equal(initial.usage.accountingMode, 'scripted fixture; no paid inference');
    const command = (request) => run(adapter, ['command', '--run-dir', directory, '--request', JSON.stringify(request)]);
    const snapshot = await command({ action: 'snapshot' });
    assert.match(snapshot.accessibility, /button "All 24"/);
    await command({ action: 'click', locator: { by: 'id', id: 'target-order-BB-1042' } });
    await command({ action: 'click', locator: { by: 'role', role: 'button', name: 'Review change' } });
    await command({ action: 'click', locator: { by: 'role', role: 'button', name: 'Accept 1 change' } });
    const facts = await run(verifier, ['--run-dir', directory]);
    assert.equal(facts.queue.find((order) => order.order_id === 'BB-1042').status, 'ready');
    assert.match(facts.queue.find((order) => order.order_id === 'BB-1042').state_json, /41 Willow Lane/);
    assert.equal(facts.receipts.length, 1);
    assert.ok(facts.audit.some((record) => record.kind === 'receipt'));
    await command({ action: 'chat', text: 'Show me the orders that need review.' });
    const deadline = Date.now() + 10_000;
    let status;
    do {
      status = await run(adapter, ['status', '--run-dir', directory]);
      if (!status.busy && status.usage.requestCount > 0) break;
      await new Promise((done) => setTimeout(done, 100));
    } while (Date.now() < deadline);
    assert.ok(status.usage.requestCount > 0);
    assert.equal(status.usage.knownCostUsd, 0);
    const database = new DatabaseSync(join(directory, 'parcel-workspace.sqlite'));
    database.prepare("UPDATE provider_attempts SET mode = 'live', cost_usd = NULL WHERE id = (SELECT id FROM provider_attempts LIMIT 1)").run();
    database.close();
    const count = status.usage.requestCount;
    await assert.rejects(command({ action: 'chat', text: 'Check BB-1076.' }), /blocked: unknown_cost/);
    await command({ action: 'click', locator: { by: 'role', role: 'button', name: 'Explore' } });
    await assert.rejects(command({ action: 'click', locator: { by: 'role', role: 'button', name: 'View in Audit: Test a judgement' } }), /blocked: unknown_cost/);
    status = await run(adapter, ['status', '--run-dir', directory]);
    assert.equal(status.usage.requestCount, count);
    assert.equal(status.stopReason, 'unknown_cost');
    const stopped = await run(adapter, ['stop', '--run-dir', directory]);
    started = false;
    assert.equal(stopped.stopReason, 'manual_stop');
    assert.equal(stopped.usage.requestCount, count);
    assert.equal((await run(adapter, ['stop', '--run-dir', directory])).usage.requestCount, count);
    assert.equal((await run(adapter, ['status', '--run-dir', directory])).deadlineAt, initial.deadlineAt);
    await assert.rejects(fetch(`${initial.url}/api/health`, { signal: AbortSignal.timeout(1000) }));
    await assert.rejects(run(adapter, ['serve', '--run-dir', directory, '--mode', 'offline']), /already has a Parcel session/);
  } finally {
    if (started) await run(adapter, ['stop', '--run-dir', directory]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
