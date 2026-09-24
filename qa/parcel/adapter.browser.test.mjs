import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const adapter = fileURLToPath(new URL('./adapter.mjs', import.meta.url));
const failureArtifacts = fileURLToPath(new URL('../../artifacts/qa-adapter-failures/', import.meta.url));
const run = async (script, flags, environment = process.env) => {
  const { stdout } = await exec(process.execPath, [script, ...flags], { env: environment, maxBuffer: 3_000_000, timeout: 140_000 });
  return JSON.parse(stdout);
};
const withWorkspaceDatabase = (directory, action) => {
  const database = new DatabaseSync(join(directory, 'parcel-workspace.sqlite'));
  try { return action(database); }
  finally { database.close(); }
};

test('offline adapter connects browser and server, gates app requests, and shuts down with unreadable accounting', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-qa-browser-'));
  let passed = false;
  try {
    const initial = await run(adapter, ['serve', '--run-dir', directory, '--mode', 'offline', '--budget-usd', '0.1', '--duration-minutes', '3', '--record-trace', 'true']);
    assert.equal(initial.mode, 'offline');
    assert.equal(initial.usage.accountingMode, 'scripted fixture; no paid inference');
    const command = (request) => run(adapter, ['command', '--run-dir', directory, '--request', JSON.stringify(request)]);
    const snapshot = await command({ action: 'snapshot' });
    assert.match(snapshot.accessibility, /button "All 24"/);
    await command({ action: 'click', locator: { by: 'id', id: 'target-order-BB-1042' } });
    await command({ action: 'click', locator: { by: 'role', role: 'button', name: 'Review change' } });
    await command({ action: 'click', locator: { by: 'role', role: 'button', name: 'Accept 1 change' } });
    let facts = await run(adapter, ['verify', '--run-dir', directory]);
    const visibleDeadline = Date.now() + 5000;
    while (facts.commands.length === 0 && Date.now() < visibleDeadline) {
      await new Promise((done) => setTimeout(done, 100));
      facts = await run(adapter, ['verify', '--run-dir', directory]);
    }
    assert.equal(facts.queue.find((order) => order.order_id === 'BB-1042').status, 'ready');
    assert.match(facts.queue.find((order) => order.order_id === 'BB-1042').state_json, /41 Willow Lane/);
    assert.equal(facts.receipts.length, 1);
    assert.equal(facts.commands[0]?.receiptId, facts.receipts[0].id);
    assert.equal(facts.commands[0]?.metric, 'accept_to_visible_commit');
    assert.ok(Number.isFinite(facts.commands[0]?.durationMs) && facts.commands[0].durationMs >= 0);
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
    withWorkspaceDatabase(directory, (database) => database.prepare("UPDATE provider_attempts SET mode = 'live', cost_usd = NULL WHERE id = (SELECT id FROM provider_attempts LIMIT 1)").run());
    const count = status.usage.requestCount;
    await assert.rejects(command({ action: 'chat', text: 'Check BB-1076.' }), /blocked: unknown_cost/);
    await command({ action: 'click', locator: { by: 'role', role: 'button', name: 'Explore' } });
    await assert.rejects(command({ action: 'click', locator: { by: 'role', role: 'button', name: 'View in Audit: Test a judgement' } }), /blocked: unknown_cost/);
    status = await run(adapter, ['status', '--run-dir', directory]);
    assert.equal(status.usage.requestCount, count);
    assert.equal(status.stopReason, 'unknown_cost');
    withWorkspaceDatabase(directory, (database) => database.exec('ALTER TABLE provider_attempts RENAME TO provider_attempts_missing'));
    await assert.rejects(command({ action: 'snapshot' }), /accounting is unavailable/);
    const unavailable = await run(adapter, ['status', '--run-dir', directory]);
    assert.equal(unavailable.stopReason, 'accounting_unavailable');
    assert.equal(unavailable.usage.knownCostUsd, null);
    assert.equal(unavailable.paidTurnsAllowed, false);
    const stopped = await run(adapter, ['stop', '--run-dir', directory]);
    assert.equal(stopped.stopReason, 'manual_stop');
    assert.equal(stopped.usage.accountingAvailable, false);
    assert.equal(stopped.usage.requestCount, null);
    const trace = await stat(join(directory, 'adapter-trace.zip'));
    assert.ok(trace.size > 0);
    assert.equal(trace.mode & 0o077, 0);
    assert.equal((await run(adapter, ['stop', '--run-dir', directory])).usage.requestCount, null);
    withWorkspaceDatabase(directory, (database) => database.exec('ALTER TABLE provider_attempts_missing RENAME TO provider_attempts'));
    assert.equal((await run(adapter, ['status', '--run-dir', directory])).usage.requestCount, count);
    assert.equal((await run(adapter, ['status', '--run-dir', directory])).deadlineAt, initial.deadlineAt);
    await assert.rejects(fetch(`${initial.url}/api/health`, { signal: AbortSignal.timeout(1000) }));
    await assert.rejects(run(adapter, ['serve', '--run-dir', directory, '--mode', 'offline']), /already has a Parcel session/);
    passed = true;
  } finally {
    await run(adapter, ['stop', '--run-dir', directory]).catch(() => {});
    try {
      if (!passed) {
        const destination = join(failureArtifacts, basename(directory));
        await mkdir(destination, { recursive: true, mode: 0o700 });
        for (const name of ['adapter-trace.zip', 'adapter-trace-error.txt', 'parcel-app.log', 'parcel-start-error.txt']) {
          try {
            await copyFile(join(directory, name), join(destination, name));
            await chmod(join(destination, name), 0o600);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        console.error(`Adapter failure evidence: ${destination}`);
      }
    } catch (error) {
      console.error(`Could not retain adapter failure evidence: ${String(error)}`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
