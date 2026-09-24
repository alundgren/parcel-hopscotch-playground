import { afterEach, test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { generatePacket, initialize, main, repositoryRoot } from '../../scripts/qa.mjs';
import { loadRun, promoteMemory, updateRun } from '../../tools/qa-loop/core.mjs';

const temporaryPaths = [];
const databases = [];
afterEach(async () => {
  try { for (const database of databases.splice(0)) database.close(); }
  finally { await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); }
});

async function fixture() {
  const tempParent = path.join(repositoryRoot, '.tmp');
  await mkdir(tempParent, { recursive: true });
  const directory = await mkdtemp(path.join(tempParent, 'qa-wrapper-'));
  temporaryPaths.push(directory);
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'qa-wrapper-runs-'));
  temporaryPaths.push(runRoot);
  const config = JSON.parse(await readFile(path.join(repositoryRoot, 'qa/config.json'), 'utf8'));
  config.memoryFile = path.relative(repositoryRoot, path.join(directory, 'memory.json'));
  config.expectations = path.relative(repositoryRoot, path.join(directory, 'expected.json'));
  await writeFile(path.join(directory, 'memory.json'), JSON.stringify({ version: 1, lessons: [], regressions: [] }));
  await writeFile(path.join(directory, 'expected.json'), JSON.stringify({ hiddenCriterion: 'verifier-only-value-8763' }));
  await writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
  return {
    directory, runRoot, config,
    options: { mode: 'offline', root: runRoot, config: path.relative(repositoryRoot, path.join(directory, 'config.json')) },
  };
}

test('wrapper gives a fresh explorer the selected mission without verifier expectations', async () => {
  const data = await fixture();
  const first = await initialize(data.options);
  assert.deepEqual(first.run.scenarios.map((scenario) => scenario.id), [
    'queue-triage', 'address-correction', 'replacement-consent', 'recovery', 'accepted-resolution-packing',
  ]);
  assert.equal(first.run.settings.budgetUsd, 0.1);
  assert.match(first.run.persona.digest, /^[a-f0-9]{64}$/);
  const explorer = await generatePacket(first.runDir, 'explorer', 'queue-triage');
  assert.equal(explorer.role, 'explorer');
  assert.equal(explorer.run, undefined);
  assert.equal(explorer.expected, undefined);
  assert.equal(JSON.stringify(explorer).includes('verifier-only-value-8763'), false);
});

test('second run cites inspected learning only in coordinator and verifier packets', async () => {
  const data = await fixture();
  const first = await initialize(data.options);
  await updateRun({ runDir: first.runDir, event: {
    type: 'observation.add', observation: {
      id: 'observed-example', scenarioId: 'queue-triage', at: new Date().toISOString(),
      action: 'Inspect a synthetic queue', result: 'A recorded queue case needs a follow-up.', durationMs: 15, evidence: null,
    },
  } });
  const selected = {
    id: 'queue-follow-up', personaId: 'new-operator', scenarioId: 'queue-triage',
    sourceRevision: first.run.revision, summary: 'Retest the recorded exclusion explanation on a different synthetic order.',
    sourceObservationId: 'observed-example', sourceFindingId: null,
    reviewedBy: 'fixture-verifier', reviewedAt: new Date().toISOString(), synthetic: true,
  };
  await promoteMemory({ runDir: first.runDir, memoryFile: path.join(data.directory, 'memory.json'), lessons: [selected] });
  const second = await initialize(data.options);
  assert.equal(second.run.consumedLessons[0].id, selected.id);
  const secondExplorer = await generatePacket(second.runDir, 'explorer', 'queue-triage');
  assert.equal(JSON.stringify(secondExplorer).includes(selected.summary), false);
  assert.equal(JSON.stringify(secondExplorer).includes(selected.id), false);
  const coordinator = await generatePacket(second.runDir, 'coordinator');
  assert.equal(coordinator.run.consumedLessons[0].summary, selected.summary);
  assert.equal(coordinator.expected.hiddenCriterion, 'verifier-only-value-8763');
  assert.equal((await loadRun({ runDir: second.runDir })).currentScenarioId, 'queue-triage');
});

test('wrapper rejects an unknown mission request', async () => {
  const data = await fixture();
  const created = await initialize(data.options);
  await assert.rejects(generatePacket(created.runDir, 'explorer', 'invented-mission'), /configured mission/);
});

test('wrapper rejects a changed recorded persona definition', async () => {
  const data = await fixture();
  const created = await initialize(data.options);
  const file = path.join(created.runDir, 'context.json');
  const context = JSON.parse(await readFile(file, 'utf8'));
  context.persona.summary = 'Changed after initialization';
  await writeFile(file, JSON.stringify(context), { mode: 0o600 });
  await assert.rejects(generatePacket(created.runDir, 'explorer', 'queue-triage'), /recorded versions/);
});

test('wrapper requires an explicit provider mode', async () => {
  const data = await fixture();
  await assert.rejects(initialize({ ...data.options, mode: undefined }), /explicitly/);
});

test('wrapper keeps raw runs outside the repository', async () => {
  const data = await fixture();
  await assert.rejects(initialize({ ...data.options, root: path.join(repositoryRoot, '.tmp', 'raw-qa') }), /outside the repository/);
});

test('promotion JSON cannot replace the selected run or memory destination', async () => {
  const data = await fixture();
  const created = await initialize(data.options);
  const input = path.join(data.directory, 'selection.json');
  await writeFile(input, JSON.stringify({ runDir: '/tmp/another-run', memoryFile: '/tmp/other-memory', lessons: [] }));
  await assert.rejects(main(['promote', '--run', created.runDir, '--input', input]), /only selected lessons and regressions/);
});

test('wrapper preserves last known usage through an unreadable ledger, restoration, and stopped final accounting', async () => {
  const data = await fixture();
  const adapterFile = path.join(data.directory, 'accounting-adapter.mjs');
  const accountingUrl = pathToFileURL(path.join(repositoryRoot, 'qa/parcel/accounting.mjs')).href;
  await writeFile(adapterFile, `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAccounting, unavailableUsage } from '${accountingUrl}';
const operation = process.argv[2];
const directory = process.argv[process.argv.indexOf('--run-dir') + 1];
const stateFile = join(directory, 'adapter-stub.json');
const stopped = (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')).stopped; } catch { return false; } })();
if (operation === 'command') throw new Error('The wrapper should reject a new turn first.');
if (operation === 'stop') writeFileSync(stateFile, JSON.stringify({ stopped: true }));
let usage;
try { usage = readAccounting(join(directory, 'parcel-workspace.sqlite'), 'live'); }
catch { usage = unavailableUsage(); }
const final = stopped || operation === 'stop';
console.log(JSON.stringify({ usage, busy: false, paidTurnsAllowed: !final && usage.accountingAvailable,
  stopReason: final ? 'manual_stop' : usage.accountingAvailable ? null : 'accounting_unavailable' }));
`);
  data.config.adapter = path.relative(repositoryRoot, adapterFile);
  await writeFile(path.join(data.directory, 'config.json'), JSON.stringify(data.config));
  const created = await initialize(data.options);
  const database = new DatabaseSync(path.join(created.runDir, 'parcel-workspace.sqlite'));
  databases.push(database);
  database.exec("CREATE TABLE provider_attempts (mode TEXT, outcome TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER); CREATE TABLE agent_turns (status TEXT)");
  database.exec("INSERT INTO provider_attempts VALUES ('live', 'complete', 0.01, 20, 10)");
  const initial = await main(['status', '--run', created.runDir]);
  assert.deepEqual(initial.run.usage, { knownCostUsd: 0.01, unknownCostRequests: 0, inputTokens: 20, outputTokens: 10, requestCount: 1 });
  await updateRun({ runDir: created.runDir, event: { type: 'scenario.start', scenarioId: 'queue-triage' } });
  await updateRun({ runDir: created.runDir, event: { type: 'turn.start', scenarioId: 'queue-triage', id: 'unreadable-turn' } });
  database.exec('ALTER TABLE provider_attempts RENAME TO unreadable_attempts');
  const unavailable = await main(['status', '--run', created.runDir]);
  assert.equal(unavailable.adapter.usage.knownCostUsd, null);
  assert.equal(unavailable.run.usage.knownCostUsd, 0.01);
  assert.equal(unavailable.run.accounting.available, false);
  assert.equal(unavailable.run.inFlight.id, 'unreadable-turn');
  assert.equal(unavailable.decision.reason, 'accounting-unavailable');
  const resumedUnavailable = await main(['resume', '--run', created.runDir]);
  assert.equal(resumedUnavailable.run.inFlight.id, 'unreadable-turn');
  const requestFile = path.join(data.directory, 'request.json');
  await writeFile(requestFile, JSON.stringify({ action: 'chat', text: 'Can I start another turn?' }));
  await assert.rejects(main(['browser', '--run', created.runDir, '--input', requestFile]), /accounting-unavailable/);
  database.exec('ALTER TABLE unreadable_attempts RENAME TO provider_attempts');
  database.exec("INSERT INTO provider_attempts VALUES ('live', 'complete', 0.02, 30, 15)");
  const restored = await main(['resume', '--run', created.runDir]);
  assert.equal(restored.run.accounting.available, true);
  assert.equal(restored.run.inFlight, null);
  assert.deepEqual(restored.run.usage, { knownCostUsd: 0.03, unknownCostRequests: 0, inputTokens: 50, outputTokens: 25, requestCount: 2 });
  assert.equal(restored.decision.allowNewTurn, true);
  await updateRun({ runDir: created.runDir, event: { type: 'turn.start', scenarioId: 'queue-triage', id: 'unfinished-final-turn' } });
  database.exec('ALTER TABLE provider_attempts RENAME TO unreadable_attempts');
  const stopped = await main(['stop', '--run', created.runDir, '--reason', 'Adapter stopped without final ledger']);
  assert.equal(stopped.status, 'closed');
  assert.equal(stopped.inFlight, null);
  assert.equal(stopped.accounting.available, false);
  assert.equal(stopped.accounting.finalUsageMissing, true);
  assert.equal(stopped.usage.knownCostUsd, 0.03);
  assert.equal((await main(['status', '--run', created.runDir])).decision.reason, 'closed');
  assert.equal((await main(['resume', '--run', created.runDir])).run.accounting.finalUsageMissing, true);
});
