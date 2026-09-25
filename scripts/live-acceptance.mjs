#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
function parse(text) { try { return JSON.parse(text); } catch { return null; } }
function serializeAttempts(attempts) {
  return attempts.map((attempt) => ({
    id: attempt.id, kind: attempt.kind, model: attempt.actual_model, mode: attempt.mode, outcome: attempt.outcome,
    errorMessage: attempt.error_message, response: parse(attempt.response_json),
    errorCode: attempt.error_code, durationMs: attempt.duration_ms, costUsd: attempt.cost_usd,
    inputTokens: attempt.input_tokens, outputTokens: attempt.output_tokens, requestBytes: attempt.request_bytes, responseBytes: attempt.response_bytes,
    retryCount: attempt.retry_count, finishReason: parse(attempt.response_json)?.finishReason ?? null,
    providerTruncated: attempt.error_code === 'incomplete_response' || parse(attempt.response_json)?.finishReason === 'length',
    storedRequestTruncated: parse(attempt.request_json)?.truncated === true, storedResponseTruncated: parse(attempt.response_json)?.truncated === true,
  }));
}
function creditsExhausted(attempts) { return attempts.some((attempt) => attempt.errorCode === 'credits_exhausted' || attempt.outcome === 'credits_exhausted'); }
function assertSetupCompleted(turn, attempts) {
  if (creditsExhausted(attempts)) throw new Error('Prepaid credits exhausted during setup; stopping the suite.');
  if (turn.status !== 'complete' || turn.measurement !== 'complete' || attempts.length === 0 || attempts.some((attempt) => attempt.outcome !== 'success' || attempt.providerTruncated)) {
    throw new Error('The real setup turn failed or was incomplete; the dependent case was not sent.');
  }
}
function hasEvidenceHighlight(records) {
  return records.some((record) => record.kind === 'ui' && record.body?.operation?.kind === 'highlight' && record.body?.operation?.targetId === 'target-order-BB-1042-evidence' && record.body?.acknowledgement === 'applied');
}
function overviewFailures(content, orders) {
  const failures = [];
  const totals = new Map();
  const mentioned = new Set();
  const byId = new Map(orders.map((order) => [order.id, order]));
  const lines = content.split('\n').map((line) => line.trim().replace(/^[-*]\s+/, '').replaceAll('**', '')).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^-{3,}$/.test(line)) continue;
    const total = /^(ready|review|waiting):\s*(0|[1-9]\d*)[.!]?$/i.exec(line);
    if (total) {
      const status = total[1].toLowerCase();
      if (totals.has(status)) failures.push(`Overview repeats the ${status} total.`);
      totals.set(status, Number(total[2]));
      continue;
    }
    let detail = /^(BB-\d{4}):\s*(\w+),\s*(\w+)\.\s*(.+)$/i.exec(line);
    const block = /^ID:\s*(BB-\d{4}),\s*(?:status:\s*(\w+),\s*)?family:\s*(\w+)$/i.exec(line);
    if (block) {
      const issue = /^Issue:\s*(.+)$/.exec(lines[index + 1] ?? '');
      if (issue) {
        index++;
        detail = [line, block[1], block[2] ?? 'review', block[3], issue[1]];
      }
    }
    if (!detail) { failures.push(`Overview contains an unsupported line: ${line}`); continue; }
    const [, id, status, family, issue] = detail;
    const order = byId.get(id.toUpperCase());
    if (!order) { failures.push(`Overview names an unknown order: ${id}.`); continue; }
    if (mentioned.has(order.id)) failures.push(`Overview repeats ${order.id}.`);
    mentioned.add(order.id);
    if (status.toLowerCase() !== order.status || order.status !== 'review') failures.push(`Overview gives the wrong review status for ${order.id}.`);
    if (family.toLowerCase() !== order.family) failures.push(`Overview gives the wrong exception family for ${order.id}.`);
    if (issue !== order.issue) failures.push(`Overview does not quote the recorded issue for ${order.id}.`);
  }
  for (const status of ['ready', 'review', 'waiting']) {
    const expected = orders.filter((order) => order.status === status).length;
    if (totals.get(status) !== expected) failures.push(`Overview ${status} total must be ${expected}.`);
  }
  const hasReviewOrders = orders.some((order) => order.status === 'review');
  if (mentioned.size > 3 || (hasReviewOrders && mentioned.size === 0)) failures.push('Overview must give one to three distinct review orders when available.');
  return failures;
}
function openEvidenceDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}
async function acceptReceiptSetup(page) {
  await page.getByRole('button', { name: 'Accept 1 change', exact: true }).click();
  await page.locator('.receipt-state').filter({ hasText: 'Accepted by you' }).waitFor();
}
if (args.includes('--self-test')) {
  const { default: assert } = await import('node:assert/strict');
  const completed = { status: 'complete', measurement: 'complete' };
  const exhausted = serializeAttempts([{ outcome: 'credits_exhausted', error_code: 'credits_exhausted', cost_usd: null }]);
  let sent = false;
  assert.throws(() => { assertSetupCompleted({ status: 'failed' }, exhausted); sent = true; }, /credits exhausted/);
  assert.equal(sent, false);
  assert.equal(creditsExhausted(exhausted), true);
  assert.equal(exhausted[0].costUsd, null);
  const truncated = serializeAttempts([{ outcome: 'error', error_code: 'incomplete_response', response_json: '{"finishReason":"length","truncated":true}', request_json: '{"truncated":true}', response_bytes: 16000, output_tokens: 4096 }]);
  assert.throws(() => assertSetupCompleted(completed, truncated), /dependent case was not sent/);
  assert.equal(truncated[0].providerTruncated, true);
  assert.equal(truncated[0].storedRequestTruncated, true);
  assert.equal(truncated[0].storedResponseTruncated, true);
  assert.equal(truncated[0].outputTokens, 4096);
  assert.equal([...exhausted, ...truncated].filter((attempt) => attempt.providerTruncated).length, 1);
  assert.throws(() => assertSetupCompleted({ status: 'cancelled' }, serializeAttempts([{ outcome: 'interrupted' }])), /dependent case was not sent/);
  assert.doesNotThrow(() => assertSetupCompleted(completed, serializeAttempts([{ outcome: 'success', cost_usd: 0.001 }])));
  const highlight = (targetId) => [{ kind: 'ui', body: { operation: { kind: 'highlight', targetId }, acknowledgement: 'applied' } }];
  assert.equal(hasEvidenceHighlight(highlight('target-work-queue')), false);
  assert.equal(hasEvidenceHighlight(highlight('target-order-BB-1042-evidence')), true);
  const orders = [
    { id: 'BB-1042', status: 'review', family: 'address', issue: 'Street number needs checking.' },
    { id: 'BB-1076', status: 'review', family: 'substitution', issue: 'Customer consent is conditional.' },
    { id: 'BB-1051', status: 'ready', family: 'substitution', issue: 'Sage replacement agreed.' },
    { id: 'BB-1088', status: 'waiting', family: 'carrier', issue: 'Waiting for a scan.' },
  ];
  const overview = 'Ready: 1\nReview: 2\nWaiting: 1\nBB-1076: review, substitution. Customer consent is conditional.';
  assert.deepEqual(overviewFailures(overview, orders), []);
  assert.deepEqual(overviewFailures('- **Waiting: 1**\n- Review: 2\nReady: 1\nBB-1042: review, address. Street number needs checking.', orders), []);
  for (const [answer, diagnostic] of [
    [overview.replace('Ready: 1', 'Ready: 2'), /ready total/],
    [overview.replace('review, substitution', 'ready, substitution'), /wrong review status/],
    [overview.replace('review, substitution', 'review, address'), /wrong exception family/],
    [overview.replace('Customer consent is conditional.', 'Ready for replacement.'), /recorded issue/],
    [overview.replace('BB-1076', 'BB-9999'), /unknown order/],
    [overview + '\nNo urgent exceptions.', /unsupported line/],
    [overview + '\nReady: 1', /repeats the ready total/],
    [overview + '\nBB-1076: review, substitution. Customer consent is conditional.', /repeats BB-1076/],
    [overview.split('\n').slice(0, 3).join('\n'), /one to three/],
    [overview.replace('Waiting: 1\n', ''), /waiting total/],
  ]) assert.ok(overviewFailures(answer, orders).some((failure) => diagnostic.test(failure)));
  const blockOverview = 'Ready: 1\nReview: 2\nWaiting: 1\n---\nID: BB-1076, family: substitution\nIssue: Customer consent is conditional.';
  assert.deepEqual(overviewFailures(blockOverview, orders), []);
  assert.ok(overviewFailures(blockOverview.replace('family: substitution', 'status: ready, family: substitution'), orders).some((failure) => /wrong review status/.test(failure)));
  assert.ok(overviewFailures(blockOverview.replace('BB-1076', 'BB-1051'), orders).some((failure) => /wrong review status/.test(failure)));
  assert.ok(overviewFailures(blockOverview.replace('substitution', 'address'), orders).some((failure) => /wrong exception family/.test(failure)));
  assert.ok(overviewFailures(blockOverview + '\nNo urgent exceptions.', orders).some((failure) => /unsupported line/.test(failure)));
  assert.deepEqual(overviewFailures('Ready: 0\nReview: 0\nWaiting: 0', []), []);
  const directory = await mkdtemp(join(tmpdir(), 'parcel-live-lock-test-'));
  let reader;
  try {
    const path = join(directory, 'locked.sqlite');
    const writer = new DatabaseSync(path);
    writer.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('saved')");
    writer.close();
    reader = openEvidenceDatabase(path);
    const locker = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 250);
    `, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve, reject) => { locker.once('error', reject); locker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Lock fixture failed.'))); });
    await new Promise((resolve, reject) => { locker.stdout.once('data', resolve); locker.once('error', reject); locker.once('exit', () => reject(new Error('Lock fixture exited before acquiring lock.'))); });
    assert.equal(reader.prepare('SELECT value FROM evidence').get().value, 'saved');
    await exited;
  } finally { reader?.close(); await rm(directory, { recursive: true, force: true }); }
  console.log('Offline reporting, setup-stop, truncation, highlight, overview facts, and SQLite contention checks passed. No inference run.');
  process.exit(0);
}

const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const runDirectory = join(repo, 'artifacts/live', new Date().toISOString().replaceAll(':', '-'));
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
const output = join(runDirectory, 'report.json');
const check = args.includes('--check');
const samples = Number(value('--samples', '2'));
const report = { status: 'not-run', live: false, samples, cases: [], coverage: {}, summary: {}, reason: null };
const save = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (read, description, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(100); }
  throw new Error(`Timed out waiting for ${description}.`);
};
const key = process.env.PARCEL_LIVE_TEST_API_KEY?.trim();
if (!check && !key) {
  report.reason = 'Live tests were not run: PARCEL_LIVE_TEST_API_KEY is missing.';
  await save(); console.log(`${report.reason}\nReport: ${output}`); process.exit(1);
}
if (!Number.isInteger(samples) || samples < 2 || samples > 5) throw new Error('--samples must be between 2 and 5.');
const build = spawn('vp', ['run', 'build'], { cwd: repo, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, stdio: 'inherit' });
await new Promise((resolve, reject) => { build.once('error', reject); build.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Application build failed.'))); });
const require = createRequire(join(repo, 'package.json'));
const { chromium } = require('@playwright/test');
const knownTools = ['listOrders', 'getOrder', 'groupOrders', 'getAuditTrace', 'navigate', 'highlight', 'startTutorial', 'stopTutorial', 'prepareAddressCorrection', 'prepareSubstitution', 'prepareResolution', 'prepareBatch', 'prepareUndo', 'classifyNote', 'checkConsent', 'prepareReset'];
const catalogueTools = [...knownTools, 'readGuidanceContext', 'findGuides', 'offerGuide', 'showNote'];
const cases = [
  { id: 'explore-overview', button: 'Try in Work: Get your bearings', tools: [], kind: 'overview' },
  { id: 'explore-learn', button: 'Try in Work: Learn a task', tools: ['getOrder', 'startTutorial'], kind: 'tutorial' },
  { id: 'explore-batch', button: 'Try in Work: Make a batch decision', tools: ['prepareBatch'], kind: 'batch' },
  { id: 'explore-consent', button: 'View in Audit: Test a judgement', tools: ['checkConsent'], kind: 'consent' },
  { id: 'listOrders', prompt: 'List the orders that are ready for review.', tools: ['listOrders'], kind: 'list' },
  { id: 'getOrder', prompt: 'Look up BB-1042 and tell me its current address and customer evidence.', tools: ['getOrder'], kind: 'order' },
  { id: 'groupOrders', prompt: 'Group the current orders by status, including the count in each group.', tools: ['groupOrders'], kind: 'group' },
  { id: 'getAuditTrace', setup: 'trace', prompt: 'Read the audit trace for turn TURN_ID and report its completed requests.', tools: ['getAuditTrace'], kind: 'trace' },
  { id: 'navigate', prompt: 'Open the order details for BB-1042.', tools: ['navigate'], kind: 'navigate' },
  { id: 'highlight', prompt: 'Open BB-1042 and highlight its customer evidence.', tools: ['highlight'], kind: 'highlight' },
  { id: 'startTutorial', prompt: 'Teach me to correct an address using the available address-correction tutorial.', tools: ['startTutorial'], kind: 'tutorial' },
  { id: 'stopTutorial', setup: 'tutorial', prompt: 'Stop the current tutorial.', tools: ['stopTutorial'], kind: 'stop' },
  { id: 'prepareAddressCorrection', prompt: 'Prepare the address correction for BB-1042 using its customer evidence. Leave it for my review.', tools: ['prepareAddressCorrection'], kind: 'address' },
  { id: 'prepareSubstitution', prompt: 'Prepare the agreed sage replacement for BB-1051 for my review.', tools: ['prepareSubstitution'], kind: 'substitution' },
  { id: 'prepareResolution', prompt: 'Prepare the resolution for the complete bundle BB-1090 for my review.', tools: ['prepareResolution'], kind: 'resolution' },
  { id: 'prepareBatch', prompt: 'Prepare all eligible orders as a batch for me to review.', tools: ['prepareBatch'], kind: 'batch' },
  { id: 'prepareUndo', setup: 'receipt', prompt: 'Prepare an undo of this receipt for my review.', tools: ['prepareUndo'], kind: 'undo' },
  { id: 'classifyNote', prompt: 'Classify this note by exception family: Carrier missed collection and the parcel has no tracking scan.', tools: ['classifyNote'], kind: 'classify' },
  { id: 'checkConsent', prompt: 'Check whether BB-1076 customer evidence provides consent for a replacement.', tools: ['checkConsent'], kind: 'consent' },
  { id: 'prepareReset', prompt: 'Prepare a reset of my demo workspace for my review. Do not commit it.', tools: ['prepareReset'], kind: 'reset' },
];
const portServer = createServer();
await new Promise((resolve, reject) => { portServer.once('error', reject); portServer.listen(0, '127.0.0.1', resolve); });
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const databasePath = join(runDirectory, 'workspace.sqlite');
const childEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(),
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin,
  DATABASE_PATH: databasePath, ENABLE_DEV_IDENTITY: 'true', DEV_USER_EMAIL: 'live-runner@example.test',
  AGENT_PROVIDER_MODE: check ? 'unavailable' : 'live', ...(check ? {} : { OPENROUTER_API_KEY: key }) };
// Direct Node startup deliberately has no environment-file flag or inherited app configuration.
const server = spawn(process.execPath, [join(repo, 'dist/server/server/main.js')], { cwd: repo, env: childEnv, stdio: ['ignore', 'ignore', 'ignore'] });
let browser;
let db;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await browser?.close().catch(() => {});
  db?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { report.reason = `Interrupted by ${signal}`; void save().finally(() => stop()).finally(() => process.exit(130)); });
const send = async (page, prompt) => {
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByPlaceholder('Message...').fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
};
const rows = (sql, ...parameters) => db.prepare(sql).all(...parameters);
const business = (userId) => JSON.stringify({
  orders: rows('SELECT order_id,status,family,issue,version,completed,resolved,state_json FROM orders WHERE user_id=? ORDER BY order_id', userId),
  inventory: rows('SELECT sku,quantity,version FROM inventory WHERE user_id=? ORDER BY sku', userId),
  receipts: rows('SELECT id,proposal_id,undone_by FROM receipts WHERE user_id=? ORDER BY id', userId),
});
const finish = (turnId) => wait(() => {
  const turn = rows('SELECT * FROM agent_turns WHERE id=?', turnId)[0];
  return turn && ['complete', 'failed', 'cancelled', 'interrupted'].includes(turn.status) ? turn : null;
}, 'completed work or a recorded failure', 180000);
const trace = (turnId) => ({
  attempts: rows('SELECT * FROM provider_attempts WHERE turn_id=? ORDER BY started_at,rowid', turnId),
  records: rows('SELECT * FROM audit_records WHERE turn_id=? ORDER BY completed_at,rowid', turnId).map((row) => ({ ...row, body: parse(row.body_json) })),
});
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
const assertResult = (testCase, evidence, snapshot, before, after) => {
  const failures = [];
  const demand = (condition, message) => { if (!condition) failures.push(message); };
  const toolRows = evidence.records.filter((record) => record.kind === 'tool');
  const successful = toolRows.filter((record) => record.outcome === 'completed' && record.body?.result?.ok === true && record.body.result.result?.ok !== false);
  const outputFor = (name) => successful.find((record) => record.body?.tool === name)?.body?.result?.result;
  const allNames = successful.map((record) => record.body?.tool);
  for (const name of testCase.tools) demand(allNames.includes(name), `Required tool did not complete: ${name}`);
  demand(evidence.turn.status === 'complete' && evidence.turn.measurement === 'complete', 'Turn did not reach browser-confirmed completion.');
  demand(before === after, 'Business state changed outside the test setup step.');
  demand(evidence.attempts.length > 0 && evidence.attempts.every((attempt) => attempt.mode === 'live' && !String(attempt.actual_model).startsWith('scripted/')), 'Inference was missing or was not live.');
  demand(evidence.attempts.every((attempt) => attempt.outcome === 'success'), 'A provider attempt failed or was incomplete.');
  demand(toolRows.every((record) => record.outcome === 'completed' && record.body?.result?.ok !== false), 'A tool failed.');
  for (const attempt of evidence.attempts.filter((attempt) => attempt.kind === 'chat')) {
    const request = parse(attempt.request_json);
    const names = request?.tools?.map((tool) => tool.function?.name).sort();
    demand(JSON.stringify(names) === JSON.stringify([...knownTools].sort()) && request.tool_choice === 'auto', 'A model request did not offer all tools with automatic selection.');
    demand(request?.max_tokens === 4096, 'A model request did not allow 4,096 output tokens.');
  }
  const prepared = successful.map((record) => record.body?.result?.result).find((result) => typeof result?.id === 'string' && result.id.startsWith('proposal_'));
  if (['address', 'substitution', 'resolution', 'batch', 'undo', 'reset'].includes(testCase.kind)) {
    demand(prepared?.id === snapshot?.currentProposal?.id, 'Prepared proposal was not retained in the workspace.');
    demand(evidence.records.some((record) => record.kind === 'ui' && record.body?.operation?.kind === 'present_proposal' && record.body?.acknowledgement === 'applied'), 'Proposal display was not acknowledged.');
    const expectedKind = testCase.kind === 'batch' ? 'batch' : testCase.kind === 'undo' ? 'undo' : testCase.kind === 'reset' ? 'reset' : 'resolution';
    demand(prepared?.kind === expectedKind, 'Proposal kind was incorrect.');
    const ids = prepared?.changes?.map((change) => change.orderId) ?? [];
    if (testCase.kind === 'address') demand(ids.includes('BB-1042') && prepared.changes.some((change) => change.after.includes('41 Willow Lane')), 'Address correction did not use the supplied evidence.');
    if (testCase.kind === 'substitution') demand(ids.includes('BB-1051'), 'Substitution targeted the wrong order.');
    if (testCase.kind === 'resolution') demand(ids.includes('BB-1090'), 'Resolution targeted the wrong order.');
    if (testCase.kind === 'batch') demand(ids.length === 6 && prepared.omissions.length === 18 && !ids.includes('BB-1076'), 'Batch inclusions or exclusions were incorrect.');
    demand(parse(evidence.turn.history_json)?.at(-1)?.content?.includes('Nothing changes until you accept it.'), 'Application proposal acknowledgement was missing.');
  }
  if (testCase.kind === 'consent') demand(outputFor('checkConsent')?.consent === 'conditional' && outputFor('checkConsent')?.needsReview === true, 'Conditional consent was not left for human review.');
  if (testCase.kind === 'classify') demand(outputFor('classifyNote')?.category === 'carrier', 'The carrier note was classified incorrectly.');
  if (testCase.kind === 'order') demand(outputFor('getOrder')?.order?.id === 'BB-1042' && outputFor('getOrder')?.order?.evidence?.length > 0, 'Order lookup did not return the requested evidence.');
  if (testCase.kind === 'list') demand(outputFor('listOrders')?.count === 6 && outputFor('listOrders')?.orders?.every((order) => order.status === 'ready'), 'Ready-order list was incorrect.');
  if (testCase.kind === 'overview') {
    const expectedOrders = JSON.parse(before).orders.map((order) => ({ ...order, id: order.order_id }));
    failures.push(...overviewFailures(parse(evidence.turn.history_json)?.at(-1)?.content ?? '', expectedOrders));
    demand(successful.some((record) => ['listOrders', 'getOrder', 'groupOrders'].includes(record.body?.tool)), 'Overview did not read current queue data.');
  }
  if (testCase.kind === 'group') demand(outputFor('groupOrders')?.groups?.reduce((sum, group) => sum + group.count, 0) === 24, 'Queue group counts did not cover all 24 orders.');
  if (testCase.kind === 'tutorial') demand(snapshot?.tutorial?.id === 'address-correction', 'Address tutorial was not active.');
  if (testCase.kind === 'stop') demand(snapshot?.tutorial === null, 'Tutorial was not dismissed.');
  if (testCase.kind === 'trace') demand(outputFor('getAuditTrace')?.attempts?.some((attempt) => attempt.turnId === testCase.traceTurn), 'Requested trace was not returned.');
  if (testCase.kind === 'navigate') demand(evidence.records.some((record) => record.kind === 'ui' && record.body?.operation?.orderId === 'BB-1042' && record.body?.acknowledgement === 'applied'), 'Order navigation was not applied.');
  if (testCase.kind === 'highlight') demand(hasEvidenceHighlight(evidence.records), 'BB-1042 customer evidence was not highlighted.');
  return { failures, completedTools: allNames };
};
try {
  await wait(async () => {
    if (server.exitCode !== null) throw new Error('The isolated server exited during startup. Rebuild the application and run --check.');
    try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; }
  }, 'isolated local server');
  browser = await chromium.launch({ headless: true });
  db = openEvidenceDatabase(databasePath);
  report.live = !check;
  report.node = process.version;
  report.playwright = require('@playwright/test/package.json').version;
  report.limits = { cases: cases.length, samples, maximumPrimaryTurns: cases.length * samples, perTurnDeadlineMs: 180000, perRequestOutputTokens: 4096, modelRequestsPerTurn: 8, toolCallsPerRequest: 6 };
  for (let sample = 1; sample <= (check ? 1 : samples); sample++) {
    for (const original of check ? [{ id: 'preflight', tools: [] }] : cases) {
      const testCase = { ...original };
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': `live-${sample}-${testCase.id}@example.test` } });
      const caseDirectory = join(runDirectory, `${sample}-${testCase.id}`);
      await mkdir(caseDirectory);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      let snapshot;
      let catalogue;
      let observedTurn;
      let automatedPhase = false;
      let unexpectedAccept = false;
      page.on('websocket', (socket) => {
        socket.on('framesent', ({ payload }) => {
          const message = parse(String(payload));
          if (['send_agent_turn', 'run_explore_scenario'].includes(message?.type)) observedTurn = message.turnId;
          if (automatedPhase && message?.type === 'accept_proposal') unexpectedAccept = true;
        });
        socket.on('framereceived', ({ payload }) => {
          const message = parse(String(payload));
          if (message?.state?.orders) snapshot = message.state;
          if (message?.type === 'snapshot') snapshot = message.state;
          if (message?.type === 'tool_catalogue') catalogue = message.entries;
        });
      });
      const entry = { case: testCase.id, sample, status: 'failed', failures: [], attempts: [], completedTools: [] };
      try {
        await page.goto(origin);
        await page.getByTestId('connection-status').filter({ hasText: 'Connected' }).waitFor();
        await page.getByRole('button', { name: 'All 24', exact: true }).waitFor();
        await wait(() => snapshot && catalogue, 'workspace and tool catalogue');
        if (JSON.stringify(catalogue.map((tool) => tool.id).sort()) !== JSON.stringify([...catalogueTools].sort())) throw new Error('Registry changed; update this suite before running paid tests.');
        const userId = rows('SELECT id FROM users ORDER BY rowid DESC LIMIT 1')[0].id;
        business(userId);
        if (check) {
          await page.locator('#target-order-BB-1042').click();
          await page.getByRole('button', { name: 'Review change', exact: true }).click();
          await acceptReceiptSetup(page);
          await wait(() => snapshot?.latestReceipt, 'test-created receipt');
          rows('SELECT history_json FROM agent_turns LIMIT 1');
          rows('SELECT request_json,response_json,cost_usd FROM provider_attempts LIMIT 1');
          rows('SELECT body_json FROM audit_records LIMIT 1');
          entry.status = 'preflight-passed';
          report.reason = 'Live tests were not run. Browser, automated receipt setup, registry, isolated server, and read-only evidence queries passed without inference.';
          continue;
        }
        console.log(`Sample ${sample}/${samples}: ${testCase.id}`);
        if (testCase.setup === 'receipt') {
          await page.locator('#target-order-BB-1042').click();
          await page.getByRole('button', { name: 'Review change', exact: true }).click();
          await acceptReceiptSetup(page);
          await wait(() => snapshot?.latestReceipt, 'test-created receipt');
        }
        if (testCase.setup === 'tutorial' || testCase.setup === 'trace') {
          observedTurn = undefined;
          await send(page, testCase.setup === 'tutorial' ? 'Start the address-correction tutorial.' : 'Read the saved address for BB-1042 and answer with that address only. Do not navigate or highlight anything.');
          const setupTurn = await wait(() => observedTurn, 'setup turn admission');
          let setupResult;
          try { setupResult = await finish(setupTurn); }
          finally { entry.setupAttempts = serializeAttempts(trace(setupTurn).attempts); observedTurn = undefined; }
          assertSetupCompleted(setupResult, entry.setupAttempts);
          testCase.traceTurn = setupTurn;
          if (testCase.setup === 'tutorial' && snapshot?.tutorial?.id !== 'address-correction') throw new Error('The real model did not start the prerequisite tutorial.');
        }
        const before = business(userId);
        observedTurn = undefined;
        automatedPhase = true;
        const started = performance.now();
        if (testCase.button) {
          await page.getByRole('button', { name: 'Explore', exact: true }).click();
          await page.getByRole('button', { name: testCase.button, exact: true }).click();
        } else await send(page, testCase.prompt.replace('TURN_ID', testCase.traceTurn ?? ''));
        const turnId = await wait(() => observedTurn, 'turn admission');
        entry.turnId = turnId;
        let turn;
        try { turn = await finish(turnId); }
        catch (error) {
          await page.getByRole('button', { name: 'Work', exact: true }).click();
          const cancel = page.locator('.turn-progress').getByRole('button', { name: 'Cancel', exact: true });
          if (await cancel.count() === 1) { await cancel.click(); await finish(turnId).catch(() => {}); }
          throw error;
        }
        entry.observedTerminalMs = performance.now() - started;
        const evidence = { ...trace(turnId), turn };
        const checked = assertResult(testCase, evidence, snapshot, before, business(userId));
        entry.failures = checked.failures;
        entry.completedTools = checked.completedTools;
        if (unexpectedAccept) entry.failures.push('Acceptance was sent during the automated phase.');
        entry.serverCompletedMs = turn.server_duration_ms;
        entry.sendToCompletedWorkMs = turn.complete_duration_ms;
        entry.measurement = turn.measurement;
        entry.attempts = serializeAttempts(evidence.attempts);
        entry.toolResultTruncated = evidence.records.some((record) => record.body?.truncated === true || record.body?.result?.truncated === true);
        if (entry.attempts.some((attempt) => attempt.providerTruncated)) entry.failures.push('Provider output was truncated.');
        entry.status = entry.failures.length ? 'failed' : 'passed';
        if (creditsExhausted(entry.attempts)) throw new Error('Prepaid credits exhausted; stopping the suite.');
      } catch (error) {
        entry.failures.push(error instanceof Error ? error.message : 'Case failed.');
        entry.status = 'failed';
        entry.turnId ??= observedTurn;
        if (entry.turnId && entry.attempts.length === 0) entry.attempts = serializeAttempts(trace(entry.turnId).attempts);
        if (creditsExhausted([...entry.attempts, ...(entry.setupAttempts ?? [])]) || String(error?.message).startsWith('Timed out waiting for completed work')) throw error;
      } finally {
        if (entry.turnId) {
          try {
            const evidence = trace(entry.turnId);
            entry.audit = evidence.records.map(({ kind, outcome, body }) => ({ kind, outcome, body }));
            entry.turn = rows('SELECT status,measurement,error_message,history_json FROM agent_turns WHERE id=?', entry.turnId)[0];
          } catch (error) { entry.failures.push(`Evidence capture failed: ${error.message}`); entry.status = 'failed'; }
        }
        try {
          await page.screenshot({ path: join(caseDirectory, 'final.png'), fullPage: true });
          await context.tracing.stop({ path: join(caseDirectory, 'trace.zip') });
        } catch (error) { entry.failures.push(`Browser capture failed: ${error.message}`); entry.status = 'failed'; }
        report.cases.push(entry);
        await context.close();
        await save();
      }
    }
  }
  report.live = !check;
  report.status = check ? 'not-run' : report.cases.every((entry) => entry.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  report.status = check ? 'not-run' : 'failed';
  report.reason = error instanceof Error ? error.message : 'Runner failed.';
} finally {
  const attempts = report.cases.flatMap((entry) => [...entry.attempts, ...(entry.setupAttempts ?? [])]);
  const complete = report.cases.filter((entry) => entry.measurement === 'complete').map((entry) => entry.sendToCompletedWorkMs);
  report.coverage = Object.fromEntries(knownTools.map((name) => [name, report.cases.filter((entry) => entry.completedTools.includes(name)).length]));
  const billed = db ? rows('SELECT cost_usd FROM provider_attempts') : [];
  report.summary = {
    passed: report.cases.filter((entry) => entry.status === 'passed').length, failed: report.cases.filter((entry) => entry.status === 'failed').length,
    completedSamples: complete.length, p50SendToCompletedWorkMs: percentile(complete, 0.5), p95SendToCompletedWorkMs: percentile(complete, 0.95),
    knownCostUsd: billed.reduce((sum, attempt) => sum + (attempt.cost_usd ?? 0), 0), unknownCostAttempts: billed.filter((attempt) => attempt.cost_usd === null).length,
    providerAttempts: billed.length, truncations: attempts.filter((attempt) => attempt.providerTruncated).length,
  };
  if (!check && knownTools.some((name) => report.coverage[name] < samples)) { report.status = 'failed'; report.reason ??= 'Repeated coverage is incomplete for one or more tools.'; }
  await save();
  await stop();
  console.log(`${report.status}: ${output}`);
  if (report.status === 'failed' || (check && report.cases.some((entry) => entry.status === 'failed'))) process.exitCode = 1;
}
