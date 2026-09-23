import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cumulativeUsage, generatePacket, initialize, main, repositoryRoot } from '../../scripts/qa.mjs';
import { loadRun, promoteMemory, updateRun } from '../../tools/qa-loop/core.mjs';

async function fixture(t) {
  const tempParent = path.join(repositoryRoot, '.tmp');
  await mkdir(tempParent, { recursive: true });
  const directory = await mkdtemp(path.join(tempParent, 'qa-wrapper-'));
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'qa-wrapper-runs-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(runRoot, { recursive: true, force: true });
  });
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

test('wrapper keeps fresh explorer knowledge separate while a second run cites inspected learning', async (t) => {
  const data = await fixture(t);
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

test('wrapper rejects altered mission definitions and unknown mission requests', async (t) => {
  const data = await fixture(t);
  const created = await initialize(data.options);
  await assert.rejects(generatePacket(created.runDir, 'explorer', 'invented-mission'), /configured mission/);
  const file = path.join(created.runDir, 'context.json');
  const context = JSON.parse(await readFile(file, 'utf8'));
  context.persona.summary = 'Changed after initialization';
  await writeFile(file, JSON.stringify(context), { mode: 0o600 });
  await assert.rejects(generatePacket(created.runDir, 'explorer', 'queue-triage'), /recorded versions/);
});

test('wrapper requires an explicit provider mode and keeps raw runs outside the repo', async (t) => {
  const data = await fixture(t);
  await assert.rejects(initialize({ ...data.options, mode: undefined }), /explicitly/);
  await assert.rejects(initialize({ ...data.options, root: path.join(repositoryRoot, '.tmp', 'raw-qa') }), /outside the repository/);
});

test('promotion JSON cannot replace the selected run or memory destination', async (t) => {
  const data = await fixture(t);
  const created = await initialize(data.options);
  const input = path.join(data.directory, 'selection.json');
  await writeFile(input, JSON.stringify({ runDir: '/tmp/another-run', memoryFile: '/tmp/other-memory', lessons: [] }));
  await assert.rejects(main(['promote', '--run', created.runDir, '--input', input]), /only selected lessons and regressions/);
});

test('accounting integration keeps cumulative cost and tokens separate from adapter activity fields', () => {
  const usage = { knownCostUsd: 0.01, unknownCostRequests: 1, inputTokens: 90, outputTokens: 12, requestCount: 2 };
  assert.deepEqual(cumulativeUsage({ usage: { ...usage, runningRequests: 0, activeTurns: 0, accountingMode: 'live provider audit' } }), usage);
  assert.throws(() => cumulativeUsage({}), /cumulative app usage/);
});
