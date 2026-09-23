#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAccounting, paidTurnDecision, isTerminalTurn, reconcileInterrupted, unavailableUsage } from './accounting.mjs';
import { installPaidTurnGate } from './browser-gate.mjs';

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const require = createRequire(join(repo, 'package.json'));
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const operation = args.shift();
const flag = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const sessionPath = (directory) => join(directory, 'parcel-session.json');
const databasePath = (directory) => join(directory, 'parcel-workspace.sqlite');
const socketPath = (directory) => join(tmpdir(), `parcel-qa-${createHash('sha256').update(directory).digest('hex').slice(0, 24)}.sock`);
const cleanText = (value, secret) => typeof value === 'string' && secret ? value.replaceAll(secret, '[redacted]') : value;

function options() {
  const directory = flag('--run-dir');
  if (!directory || !isAbsolute(directory)) throw new Error('--run-dir must be an absolute path.');
  return { directory: resolve(directory) };
}

async function saveSession(directory, session) {
  const temporary = `${sessionPath(directory)}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, sessionPath(directory));
}

async function readSession(directory) {
  return JSON.parse(await readFile(sessionPath(directory), 'utf8'));
}

function publicStatus(session, usage, busy = false) {
  const decision = paidTurnDecision(usage, session.budgetUsd, busy);
  return {
    mode: session.mode,
    url: session.url,
    busy,
    deadlineAt: session.deadlineAt,
    stopReason: session.stopReason ?? (['unknown_cost', 'budget_reached', 'accounting_unavailable'].includes(decision.reason) ? decision.reason : null),
    budgetUsd: session.budgetUsd,
    paidTurnsAllowed: session.state === 'running' && decision.allowed,
    usage,
  };
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitForHealth(origin, child) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`The application exited before health check, code ${child.exitCode}.`);
    try { if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Still starting. */ }
    await pause(100);
  }
  throw new Error('The application did not become healthy within 30 seconds.');
}

async function buildApp() {
  const child = spawn('vp', ['run', 'build'], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errorText = '';
  child.stderr.on('data', (chunk) => { errorText = `${errorText}${chunk}`.slice(-2000); });
  await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Application build failed: ${errorText}`))); });
}

function makeLocator(page, request) {
  const { locator } = request;
  if (!locator || typeof locator !== 'object') throw new Error('A visible locator is required.');
  let target;
  if (locator.by === 'role' && typeof locator.role === 'string' && typeof locator.name === 'string') target = page.getByRole(locator.role, { name: locator.name, exact: locator.exact !== false });
  else if (locator.by === 'text' && typeof locator.text === 'string') target = page.getByText(locator.text, { exact: locator.exact !== false });
  else if (locator.by === 'placeholder' && typeof locator.placeholder === 'string') target = page.getByPlaceholder(locator.placeholder, { exact: locator.exact !== false });
  else if (locator.by === 'testId' && /^[a-zA-Z0-9_-]+$/.test(locator.testId ?? '')) target = page.getByTestId(locator.testId);
  else if (locator.by === 'id' && /^[a-zA-Z][a-zA-Z0-9_-]+$/.test(locator.id ?? '')) target = page.locator(`#${locator.id}`);
  else throw new Error('Unsupported locator. Use role, text, placeholder, testId, or id.');
  return target;
}

async function runBrowserAction(page, request, directory) {
  if (!request || typeof request !== 'object') throw new Error('The browser request must be an object.');
  const action = request.action;
  if (action === 'snapshot') {
    return { title: await page.title(), url: page.url(), accessibility: (await page.locator('body').ariaSnapshot()).slice(0, 24000), visibleText: (await page.locator('body').innerText()).slice(0, 24000) };
  }
  if (action === 'screenshot') {
    const label = request.label ?? 'checkpoint';
    if (typeof label !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(label)) throw new Error('Screenshot label must contain only letters, numbers, dashes, or underscores.');
    const path = join(directory, 'screenshots', `${label}-${Date.now()}.png`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((image) => image.decode().catch(() => {}))); });
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    return { path };
  }
  if (action === 'reload') { await page.reload({ waitUntil: 'domcontentloaded' }); return { url: page.url() }; }
  if (action === 'viewport') {
    const { width, height } = request;
    if (!Number.isInteger(width) || width < 300 || width > 1920 || !Number.isInteger(height) || height < 400 || height > 1200) throw new Error('Viewport must be 300–1920 pixels wide and 400–1200 pixels high.');
    await page.setViewportSize({ width, height });
    return { width, height };
  }
  if (action === 'chat') {
    if (typeof request.text !== 'string' || request.text.trim().length === 0 || request.text.length > 2000) throw new Error('Chat text must contain 1–2000 characters.');
    await page.getByRole('button', { name: 'Work', exact: true }).click();
    await page.getByPlaceholder('Message...').fill(request.text);
    await page.getByRole('button', { name: 'Send message' }).click();
    return { sent: true };
  }
  if (action === 'click' || action === 'fill' || action === 'press') {
    const target = makeLocator(page, request);
    if (await target.count() !== 1 || !await target.isVisible()) throw new Error('Locator must identify exactly one visible element.');
    if (action === 'click') { await target.click(); return { clicked: true }; }
    if (action === 'fill') {
      if (typeof request.text !== 'string' || request.text.length > 2000) throw new Error('Fill text must be at most 2000 characters.');
      await target.fill(request.text); return { filled: true };
    }
    if (typeof request.key !== 'string' || !/^(Tab|Shift\+Tab|Escape|Enter|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace)$/.test(request.key)) throw new Error('Unsupported key.');
    await target.press(request.key); return { pressed: request.key };
  }
  throw new Error('Unsupported browser action.');
}

async function appendEvent(directory, event, secret) {
  const file = await open(join(directory, 'parcel-events.jsonl'), 'a', 0o600);
  try { await file.writeFile(cleanText(JSON.stringify(event), secret) + '\n'); } finally { await file.close(); }
}

async function daemon(directory, mode, budgetUsd, durationMinutes) {
  process.umask(0o077);
  const secret = mode === 'live' ? process.env.PARCEL_QA_API_KEY?.trim() : undefined;
  if (mode === 'live' && !secret) throw new Error('PARCEL_QA_API_KEY is required for live mode.');
  const socket = socketPath(directory);
  const startedAt = new Date();
  const session = { mode, budgetUsd, startedAt: startedAt.toISOString(), deadlineAt: new Date(startedAt.getTime() + durationMinutes * 60_000).toISOString(), url: null, socket, state: 'starting', stopReason: null };
  let app;
  let browser;
  let listener;
  let page;
  let pendingTurn = null;
  let stopping = false;
  let tail = Promise.resolve();
  const persist = async () => saveSession(directory, session);
  const finish = async (reason, connection = null) => {
    if (stopping) return;
    stopping = true;
    await browser?.close().catch(() => {});
    if (app && app.exitCode === null) {
      app.kill('SIGTERM');
      await Promise.race([new Promise((done) => app.once('exit', done)), pause(3000)]);
      if (app.exitCode === null) app.kill('SIGKILL');
    }
    try { reconcileInterrupted(databasePath(directory)); } catch { /* The database may not exist after startup failure. */ }
    session.stopReason = reason;
    session.state = 'stopped';
    await persist();
    let finalStatus;
    try { finalStatus = publicStatus(session, readAccounting(databasePath(directory), mode), false); }
    catch { finalStatus = publicStatus(session, unavailableUsage(), false); }
    if (connection) connection.end(JSON.stringify({ ok: true, result: finalStatus }) + '\n');
    await new Promise((done) => listener?.close(done) ?? done());
    await rm(socket, { force: true });
    return finalStatus;
  };
  const current = () => {
    const usage = readAccounting(databasePath(directory), mode);
    if (pendingTurn && isTerminalTurn(databasePath(directory), pendingTurn)) pendingTurn = null;
    return { usage, decision: paidTurnDecision(usage, budgetUsd, pendingTurn), busy: Boolean(pendingTurn || usage.activeTurns || usage.runningRequests) };
  };
  const currentForStatus = () => {
    try { return current(); }
    catch {
      const usage = unavailableUsage();
      return { usage, decision: paidTurnDecision(usage, budgetUsd, pendingTurn), busy: Boolean(pendingTurn) };
    }
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await persist();
    await buildApp();
    if (Date.now() >= Date.parse(session.deadlineAt)) throw new Error('The QA deadline passed during application build.');
    const port = await availablePort();
    session.url = `http://127.0.0.1:${port}`;
    const appLog = await open(join(directory, 'parcel-app.log'), 'a', 0o600);
    app = spawn(process.execPath, [join(repo, 'dist/server/server/main.js')], {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(),
        NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: session.url,
        DATABASE_PATH: databasePath(directory), ENABLE_DEV_IDENTITY: 'true', DEV_USER_EMAIL: 'qa-operator@example.test',
        AGENT_PROVIDER_MODE: mode === 'offline' ? 'scripted' : 'live',
        ...(mode === 'live' ? { OPENROUTER_API_KEY: secret } : {}),
      },
      stdio: ['ignore', appLog.fd, appLog.fd],
    });
    await appLog.close();
    await waitForHealth(session.url, app);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'UTC' });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === String(port)) return route.continue();
      return route.abort();
    });
    page = await context.newPage();
    await page.addInitScript(installPaidTurnGate);
    await page.goto(session.url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('connection-status').filter({ hasText: 'Connected' }).waitFor({ timeout: 15_000 });
    listener = createServer((connection) => {
      let input = '';
      connection.on('data', (chunk) => {
        input += chunk;
        if (input.length > 40_000) connection.destroy();
        if (!input.endsWith('\n')) return;
        const line = input.trim(); input = '';
        tail = tail.then(async () => {
          let command;
          try {
            command = JSON.parse(line);
            if (command.operation === 'stop') {
              await finish('manual_stop', connection);
              return;
            }
            if (command.operation === 'status') {
              const before = currentForStatus();
              connection.end(JSON.stringify({ ok: true, result: publicStatus(session, before.usage, before.busy) }) + '\n');
              return;
            }
            if (command.operation !== 'command') throw new Error('Unsupported adapter operation.');
            const before = current();
            if (Date.now() >= Date.parse(session.deadlineAt)) throw new Error('The QA deadline has passed.');
            if (typeof command.request?.text === 'string' && secret && command.request.text.includes(secret)) throw new Error('Application key cannot be entered into the browser.');
            const gateBefore = await page.evaluate(() => window.__parcelQaGate.state());
            if (before.decision.allowed) await page.evaluate(() => window.__parcelQaGate.grant());
            let result;
            try { result = await runBrowserAction(page, command.request, directory); }
            finally {
              const gateAfter = await page.evaluate(() => window.__parcelQaGate.revoke());
              if (gateAfter.sentTurnId && gateAfter.sentTurnId !== gateBefore.sentTurnId) pendingTurn = gateAfter.sentTurnId;
              if (gateAfter.blocked > gateBefore.blocked) throw new Error(`A paid application turn was blocked: ${before.decision.reason ?? 'authorization was not granted'}.`);
            }
            const after = current();
            await appendEvent(directory, { at: new Date().toISOString(), request: command.request, result, usage: after.usage }, secret);
            connection.end(JSON.stringify({ ok: true, result, status: publicStatus(session, after.usage, after.busy) }) + '\n');
          } catch (error) {
            const message = cleanText(error instanceof Error ? error.message : String(error), secret);
            await appendEvent(directory, { at: new Date().toISOString(), request: command?.request, error: message }, secret).catch(() => {});
            connection.end(JSON.stringify({ ok: false, error: message }) + '\n');
          }
        }).catch(() => {});
      });
    });
    await rm(socket, { force: true });
    await new Promise((done, reject) => { listener.once('error', reject); listener.listen(socket, done); });
    await chmod(socket, 0o600);
    session.state = 'running';
    await persist();
    const remaining = Date.parse(session.deadlineAt) - Date.now();
    if (remaining <= 0) await finish('deadline');
    else setTimeout(() => { void finish('deadline').finally(() => process.exit(0)); }, remaining).unref();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void finish(`signal_${signal}`).finally(() => process.exit(0)); });
    app.once('exit', () => { if (!stopping) void finish('application_exited').finally(() => process.exit(1)); });
    browser.once('disconnected', () => { if (!stopping) void finish('browser_disconnected').finally(() => process.exit(1)); });
  } catch (error) {
    await writeFile(join(directory, 'parcel-start-error.txt'), cleanText(error instanceof Error ? error.message : String(error), secret), { mode: 0o600 });
    await finish(Date.now() >= Date.parse(session.deadlineAt) ? 'deadline' : 'startup_failed');
    throw error;
  }
}

async function requestDaemon(directory, command) {
  const session = await readSession(directory);
  if (session.state !== 'running') {
    if (command.operation === 'status' || command.operation === 'stop') {
      let usage;
      try { usage = readAccounting(databasePath(directory), session.mode); }
      catch { usage = unavailableUsage(); }
      return publicStatus(session, usage, false);
    }
    throw new Error(`Adapter stopped: ${session.stopReason ?? session.state}.`);
  }
  return new Promise((done, reject) => {
    const connection = createConnection(session.socket);
    let data = '';
    connection.setTimeout(30_000, () => connection.destroy(new Error('Adapter command timed out.')));
    connection.once('error', reject);
    connection.on('data', (chunk) => { data += chunk; });
    connection.once('end', () => {
      try {
        const reply = JSON.parse(data);
        if (!reply.ok) reject(new Error(reply.error)); else done(reply);
      } catch (error) { reject(error); }
    });
    connection.once('connect', () => connection.write(JSON.stringify(command) + '\n'));
  });
}

async function main() {
  if (!['serve', 'daemon', 'command', 'status', 'stop', 'verify'].includes(operation)) throw new Error('Use serve, command, status, stop, or verify.');
  const { directory } = options();
  if (operation === 'verify') { await import('./verify.mjs'); return; }
  if (operation === 'daemon') {
    await daemon(directory, flag('--mode'), Number(flag('--budget-usd')), Number(flag('--duration-minutes')));
    return;
  }
  if (operation === 'serve') {
    const mode = flag('--mode', 'offline');
    const budgetUsd = Number(flag('--budget-usd', '0.10'));
    const durationMinutes = Number(flag('--duration-minutes', '120'));
    if (!['offline', 'live'].includes(mode) || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || !Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1440) throw new Error('Invalid mode, budget, or duration.');
    if (mode === 'live' && !process.env.PARCEL_QA_API_KEY?.trim()) throw new Error('PARCEL_QA_API_KEY is required for live mode.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await (await open(sessionPath(directory), 'wx', 0o600)).close(); }
    catch (error) {
      if (error?.code === 'EEXIST') throw new Error('This run directory already has a Parcel session. Use a new run directory so its deadline and accounting cannot reset.');
      throw error;
    }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon', '--run-dir', directory, '--mode', mode, '--budget-usd', String(budgetUsd), '--duration-minutes', String(durationMinutes)], {
      cwd: repo, detached: true, stdio: 'ignore',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(), ...(mode === 'live' ? { PARCEL_QA_API_KEY: process.env.PARCEL_QA_API_KEY } : {}) },
    });
    child.unref();
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const session = await readSession(directory).catch(() => null);
      if (session?.state === 'running') { console.log(JSON.stringify((await requestDaemon(directory, { operation: 'status' })).result)); return; }
      if (session?.state === 'stopped') throw new Error(await readFile(join(directory, 'parcel-start-error.txt'), 'utf8').catch(() => session.stopReason));
      await pause(150);
    }
    throw new Error('Adapter did not start within 120 seconds.');
  }
  if (operation === 'command') {
    const raw = flag('--request') ?? await readFile(flag('--request-file'), 'utf8');
    const request = JSON.parse(raw);
    const reply = await requestDaemon(directory, { operation: 'command', request });
    console.log(JSON.stringify({ ...reply.result, status: reply.status }));
    return;
  }
  const reply = await requestDaemon(directory, { operation });
  console.log(JSON.stringify(reply.result ?? reply));
}

await main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
