import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { closeRun, createRun, loadMemory, loadRun, packetFor, promoteMemory, runDecision, updateRun, validateRun } from './core.mjs';

const start = '2026-09-23T12:00:00.000Z';
const base = {
  revision: 'abc123',
  settings: { durationMinutes: 120, budgetUsd: 0.10 },
  model: { coordinator: 'sol-high', explorer: 'sol-high' },
  persona: { id: 'new-operator', version: '1', digest: 'persona-digest' },
  scenarios: [{ id: 'queue', version: '1', digest: 'queue-digest' }, { id: 'address', version: '2', digest: 'address-digest' }],
  now: start,
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qa-loop-test-'));
  const created = await createRun({ ...base, rootDir: path.join(root, 'runs') });
  return { root, ...created };
}
const usage = (cost, requests = 1, unknown = 0) => ({ knownCostUsd: cost, unknownCostRequests: unknown, inputTokens: 20 * requests, outputTokens: 10 * requests, requestCount: requests });
const observation = (id = 'obs-1') => ({ id, scenarioId: 'queue', at: start, action: 'Opened the queue', result: 'A blocked order was visible', durationMs: 430, evidence: 'local screenshot reference' });
const notRun = () => ({ status: 'not-run', evidence: null, at: null });
const finding = () => ({
  id: 'f-1', scenarioId: 'queue', kind: 'defect', status: 'confirmed', title: 'Queue count is stale',
  reproduction: 'Open queue after acceptance', consequence: 'Operator may miss an order',
  expected: { result: 'Queue count updates', source: 'Product acceptance note' },
  diagnosis: { status: 'unknown', hypothesis: null, evidence: null }, correctionStatus: 'not-started',
  verification: { original: notRun(), adjacent: notRun() }, observationIds: ['obs-1'],
});

test('one run persists multiple scenarios and resumes an unfinished paid turn', async () => {
  const { runDir } = await fixture();
  await updateRun({ runDir, event: { type: 'scenario.start', scenarioId: 'queue' }, now: start });
  await updateRun({ runDir, event: { type: 'turn.start', scenarioId: 'queue', id: 'turn-1' }, now: start });
  const resumed = await loadRun({ runDir });
  assert.equal(resumed.currentScenarioId, 'queue');
  assert.equal(resumed.inFlight.id, 'turn-1');
  assert.equal(runDecision(resumed, { now: '2026-09-23T12:01:00.000Z' }).reason, 'turn-in-flight');
  await assert.rejects(closeRun({ runDir, reason: 'done' }), /in-flight/);
  await updateRun({ runDir, event: { type: 'turn.finish', id: 'turn-1', usage: usage(0.04) }, now: '2026-09-23T12:02:00.000Z' });
  await updateRun({ runDir, event: { type: 'scenario.start', scenarioId: 'address' }, now: '2026-09-23T12:03:00.000Z' });
  const closed = await closeRun({ runDir, reason: 'operator stopped', now: '2026-09-23T12:04:00.000Z' });
  assert.equal(closed.usage.knownCostUsd, 0.04);
  assert.equal(closed.currentScenarioId, 'address');
  assert.equal((await loadRun({ runDir })).status, 'closed');
  await assert.rejects(updateRun({ runDir, event: { type: 'scenario.start', scenarioId: 'queue' } }), /closed/);
});

test('time, threshold, unknown cost, and busy state block new paid turns', async () => {
  const { runDir, run } = await fixture();
  assert.deepEqual(runDecision(run, { now: '2026-09-23T14:00:00.000Z' }), { allowNewTurn: false, reason: 'time-limit' });
  assert.equal(runDecision(run, { usage: usage(0.1), now: start }).reason, 'spending-threshold');
  assert.equal(runDecision(run, { usage: usage(0.02, 1, 1), now: start }).reason, 'unknown-cost');
  assert.equal(runDecision(run, { adapterBusy: true, now: start }).reason, 'turn-in-flight');
  await updateRun({ runDir, event: { type: 'usage.record', usage: usage(0.02, 1, 1) }, now: start });
  await assert.rejects(updateRun({ runDir, event: { type: 'turn.start', scenarioId: 'queue', id: 'second' }, now: start }), /unknown-cost/);
  await assert.rejects(updateRun({ runDir, event: { type: 'usage.record', usage: usage(0.02, 1, 0) }, now: start }), /cannot decrease/);
  assert.equal((await loadRun({ runDir })).usage.unknownCostRequests, 1);
});

test('invalid records and transitions never replace the last valid file', async () => {
  const { runDir, run } = await fixture();
  await assert.rejects(updateRun({ runDir, event: { type: 'finding.add', finding: finding() }, now: start }), /unknown observation/);
  await updateRun({ runDir, event: { type: 'observation.add', observation: observation() }, now: start });
  await updateRun({ runDir, event: { type: 'finding.add', finding: finding() }, now: start });
  const bad = finding();
  bad.status = 'resolved';
  await assert.rejects(updateRun({ runDir, event: { type: 'finding.update', findingId: 'f-1', finding: bad }, now: start }), /passing checks/);
  const current = await loadRun({ runDir });
  assert.equal(current.findings[0].status, 'confirmed');
  assert.equal(current.findings[0].diagnosis.status, 'unknown');
  assert.throws(() => validateRun({ ...run, version: 99 }), /unsupported/);
  assert.throws(() => validateRun({ ...run, fakeField: true }), /not allowed/);
});

test('explorer receives only persona, mission, and browser procedure', async () => {
  const { run } = await fixture();
  run.consumedLessons = [{ id: 'lesson-1', sourceRevision: 'old', summary: 'A prior finding' }];
  const explorer = packetFor(run, 'explorer', { persona: 'New operator', mission: 'Triage queue', browserProcedure: 'Use the browser controls' });
  assert.deepEqual(Object.keys(explorer), ['version', 'role', 'persona', 'mission', 'browserProcedure']);
  assert.doesNotMatch(JSON.stringify(explorer), /lesson-1|prior finding|abc123/);
  assert.throws(() => packetFor(run, 'explorer', { persona: 'New operator', mission: 'Triage queue', browserProcedure: 'Use browser', expected: 'Known answer' }), /not allowed/);
  assert.equal(packetFor(run, 'verifier', { expected: 'Queue count updates' }).run.consumedLessons[0].id, 'lesson-1');
});

test('selected synthetic learning needs a real observation, review, and resolved defect for regression', async () => {
  const { root, runDir } = await fixture();
  const memoryFile = path.join(root, 'memory.json');
  await updateRun({ runDir, event: { type: 'observation.add', observation: observation() }, now: start });
  await updateRun({ runDir, event: { type: 'finding.add', finding: finding() }, now: start });
  const lesson = { id: 'queue-count', personaId: 'new-operator', scenarioId: 'queue', sourceRevision: 'abc123', summary: 'After accepting an order, check the queue count.', sourceObservationId: 'obs-1', sourceFindingId: 'f-1', reviewedBy: 'qa reviewer', reviewedAt: start, synthetic: true };
  const regression = { id: 'queue-count-regression', personaId: 'new-operator', scenarioId: 'queue', sourceRevision: 'abc123', findingId: 'f-1', setup: 'Seed one blocked order', action: 'Accept its proposal', expected: 'Queue count decreases by one', reviewedBy: 'qa reviewer', reviewedAt: start, synthetic: true };
  await assert.rejects(promoteMemory({ runDir, memoryFile, lessons: [lesson] }), /resolved source/);
  await assert.rejects(promoteMemory({ runDir, memoryFile, regressions: [regression] }), /resolved defect/);
  const fixed = finding();
  fixed.status = 'resolved'; fixed.correctionStatus = 'verified';
  fixed.diagnosis = { status: 'confirmed', hypothesis: 'Snapshot event omitted the count', evidence: 'Observed event payload' };
  fixed.verification = { original: { status: 'pass', evidence: 'Original case passed', at: start }, adjacent: { status: 'pass', evidence: 'Second order passed', at: start } };
  await updateRun({ runDir, event: { type: 'finding.update', findingId: 'f-1', finding: fixed }, now: start });
  const saved = await promoteMemory({ runDir, memoryFile, lessons: [lesson], regressions: [regression] });
  assert.equal(saved.lessons.length, 1);
  assert.equal(saved.regressions.length, 1);
  const next = await createRun({ ...base, rootDir: path.join(root, 'runs'), memoryFile, now: '2026-09-24T12:00:00.000Z' });
  assert.deepEqual(next.run.consumedLessons, [{ id: 'queue-count', sourceRevision: 'abc123', summary: lesson.summary }]);
  assert.doesNotMatch(JSON.stringify(packetFor(next.run, 'explorer', { persona: 'New operator', mission: 'Triage queue', browserProcedure: 'Use browser' })), /queue-count/);
  assert.equal((await loadMemory(memoryFile)).regressions[0].id, regression.id);
});

test('promotion rejects secrets, transcript content, extra fields, and unsafe paths', async () => {
  const { root, runDir } = await fixture();
  await updateRun({ runDir, event: { type: 'observation.add', observation: observation() }, now: start });
  const lesson = { id: 'safe-id', personaId: 'new-operator', scenarioId: 'queue', sourceRevision: 'abc123', summary: 'Check the count after acceptance.', sourceObservationId: 'obs-1', sourceFindingId: null, reviewedBy: 'reviewer', reviewedAt: start, synthetic: true };
  for (const summary of ['Bearer abc123secret', 'api_key: secretvalue', 'User: my order is late', '../private/file', 'Write to /etc/passwd']) {
    await assert.rejects(promoteMemory({ runDir, memoryFile: path.join(root, 'memory.json'), lessons: [{ ...lesson, summary }] }), /sensitive text or a path/);
  }
  await assert.rejects(promoteMemory({ runDir, memoryFile: path.join(root, 'memory.json'), lessons: [{ ...lesson, rawTranscript: 'hello' }] }), /not allowed/);
  await symlink(root, path.join(root, 'linked'));
  await assert.rejects(promoteMemory({ runDir, memoryFile: path.join(root, 'linked', 'memory.json'), lessons: [lesson] }), /unsafe directory/);
  await assert.rejects(promoteMemory({ runDir, memoryFile: `${root}/../memory.json`, lessons: [lesson] }), /parent traversal/);
  await assert.rejects(loadMemory(path.join(root, 'missing', 'memory.json')));
});

test('run files remain private and malformed disk records fail closed', async () => {
  const { runDir } = await fixture();
  const file = path.join(runDir, 'run.json');
  const stat = await import('node:fs/promises').then(({ lstat }) => lstat(file));
  assert.equal(stat.mode & 0o777, 0o600);
  await writeFile(file, '{"version":999}', { mode: 0o600 });
  await assert.rejects(loadRun({ runDir }), /unsupported|not allowed/);
  assert.match(await readFile(file, 'utf8'), /999/);
});
