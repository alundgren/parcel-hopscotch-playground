import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const RECORD_VERSION = 1;
export const defaultRoot = path.join(os.homedir(), '.local', 'state', 'qa-loop', 'runs');
const kinds = new Set(['defect', 'ux-concern', 'product-question', 'environment-failure', 'tester-failure']);
const findingStatuses = new Set(['open', 'investigating', 'confirmed', 'dismissed', 'resolved']);
const correctionStatuses = new Set(['not-started', 'prepared', 'applied', 'verified', 'deferred']);
const checkStatuses = new Set(['not-run', 'pass', 'fail', 'blocked']);
const diagnosisStatuses = new Set(['unknown', 'hypothesis', 'confirmed']);
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const own = (value, key) => Object.hasOwn(value, key);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function string(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} must be nonempty text of at most ${max} characters`);
  return value;
}
function optionalString(value, label, max = 2000) {
  if (value === undefined || value === null) return null;
  return string(value, label, max);
}
function number(value, label, min = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error(`${label} must be a finite number >= ${min}`);
  return value;
}
function integer(value, label, min = 0) {
  number(value, label, min);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}
function oneOf(value, choices, label) {
  if (!choices.has(value)) throw new Error(`${label} is invalid`);
  return value;
}
function exact(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}.${key} is not allowed`);
  return value;
}
function ref(value, label) {
  exact(value, ['id', 'version', 'digest'], label);
  string(value.id, `${label}.id`, 100);
  string(value.version, `${label}.version`, 100);
  optionalString(value.digest, `${label}.digest`, 128);
  return value;
}
function usage(value) {
  exact(value, ['knownCostUsd', 'unknownCostRequests', 'inputTokens', 'outputTokens', 'requestCount'], 'usage');
  number(value.knownCostUsd, 'usage.knownCostUsd');
  for (const key of ['unknownCostRequests', 'inputTokens', 'outputTokens', 'requestCount']) integer(value[key], `usage.${key}`);
  if (value.unknownCostRequests > value.requestCount) throw new Error('unknown requests exceed request count');
  return value;
}
function observation(value) {
  exact(value, ['id', 'scenarioId', 'at', 'action', 'result', 'durationMs', 'evidence'], 'observation');
  string(value.id, 'observation.id', 100); string(value.scenarioId, 'observation.scenarioId', 100);
  if (!iso(value.at)) throw new Error('observation.at is invalid');
  string(value.action, 'observation.action'); string(value.result, 'observation.result');
  number(value.durationMs, 'observation.durationMs');
  optionalString(value.evidence, 'observation.evidence', 500);
  return value;
}
function check(value, label) {
  exact(value, ['status', 'evidence', 'at'], label);
  oneOf(value.status, checkStatuses, `${label}.status`);
  if (value.status !== 'not-run') {
    string(value.evidence, `${label}.evidence`);
    if (!iso(value.at)) throw new Error(`${label}.at is invalid`);
  } else if (value.evidence != null || value.at != null) throw new Error(`${label} has evidence without a result`);
  return value;
}
function finding(value) {
  exact(value, ['id', 'scenarioId', 'kind', 'status', 'title', 'reproduction', 'consequence', 'expected', 'diagnosis', 'correctionStatus', 'verification', 'observationIds'], 'finding');
  string(value.id, 'finding.id', 100); string(value.scenarioId, 'finding.scenarioId', 100);
  oneOf(value.kind, kinds, 'finding.kind'); oneOf(value.status, findingStatuses, 'finding.status');
  string(value.title, 'finding.title', 200); string(value.reproduction, 'finding.reproduction');
  string(value.consequence, 'finding.consequence');
  exact(value.expected, ['result', 'source'], 'finding.expected');
  string(value.expected.result, 'finding.expected.result'); string(value.expected.source, 'finding.expected.source', 500);
  exact(value.diagnosis, ['status', 'hypothesis', 'evidence'], 'finding.diagnosis');
  oneOf(value.diagnosis.status, diagnosisStatuses, 'finding.diagnosis.status');
  if (value.diagnosis.status === 'unknown') {
    if (value.diagnosis.hypothesis != null || value.diagnosis.evidence != null) throw new Error('unknown diagnosis cannot assert a cause');
  } else {
    string(value.diagnosis.hypothesis, 'finding.diagnosis.hypothesis');
    string(value.diagnosis.evidence, 'finding.diagnosis.evidence');
  }
  oneOf(value.correctionStatus, correctionStatuses, 'finding.correctionStatus');
  exact(value.verification, ['original', 'adjacent'], 'finding.verification');
  check(value.verification.original, 'finding.verification.original');
  check(value.verification.adjacent, 'finding.verification.adjacent');
  if (value.status === 'resolved' || value.correctionStatus === 'verified') {
    if (value.verification.original.status !== 'pass' || value.verification.adjacent.status !== 'pass') throw new Error('resolved findings require original and adjacent passing checks');
  }
  if (!Array.isArray(value.observationIds) || !value.observationIds.length) throw new Error('finding.observationIds must name observations');
  value.observationIds.forEach((id) => string(id, 'finding.observationIds entry', 100));
  return value;
}
function coverage(value) {
  exact(value, ['scenarioId', 'at', 'outcome', 'evidence'], 'coverage');
  string(value.scenarioId, 'coverage.scenarioId', 100);
  if (!iso(value.at)) throw new Error('coverage.at is invalid');
  oneOf(value.outcome, new Set(['attempted', 'completed', 'blocked']), 'coverage.outcome');
  string(value.evidence, 'coverage.evidence');
  return value;
}
function unique(items, label) {
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates`);
}
export function validateRun(value) {
  exact(value, ['version', 'id', 'status', 'createdAt', 'updatedAt', 'closedAt', 'closeReason', 'revision', 'settings', 'model', 'persona', 'scenarios', 'currentScenarioId', 'consumedLessons', 'usage', 'inFlight', 'observations', 'findings', 'coverage'], 'run');
  if (value.version !== RECORD_VERSION) throw new Error('unsupported run version');
  string(value.id, 'run.id', 100); oneOf(value.status, new Set(['active', 'closed']), 'run.status');
  if (!iso(value.createdAt) || !iso(value.updatedAt)) throw new Error('run timestamps are invalid');
  if (value.status === 'closed') {
    if (!iso(value.closedAt)) throw new Error('closedAt is required');
    string(value.closeReason, 'closeReason', 500);
  } else if (value.closedAt !== null || value.closeReason !== null) throw new Error('active run cannot have close fields');
  string(value.revision, 'revision', 128);
  exact(value.settings, ['durationMinutes', 'budgetUsd'], 'settings');
  number(value.settings.durationMinutes, 'settings.durationMinutes', 1);
  number(value.settings.budgetUsd, 'settings.budgetUsd', 0.001);
  object(value.model, 'model');
  for (const [key, val] of Object.entries(value.model)) string(val, `model.${key}`, 200);
  ref(value.persona, 'persona');
  if (!Array.isArray(value.scenarios) || !value.scenarios.length) throw new Error('scenarios must be a nonempty array');
  value.scenarios.forEach((item) => ref(item, 'scenario'));
  unique(value.scenarios.map((item) => item.id), 'scenarios');
  if (value.currentScenarioId !== null && !value.scenarios.some((item) => item.id === value.currentScenarioId)) throw new Error('currentScenarioId is unknown');
  if (!Array.isArray(value.consumedLessons)) throw new Error('consumedLessons must be an array');
  value.consumedLessons.forEach((item) => {
    exact(item, ['id', 'sourceRevision', 'summary'], 'consumed lesson');
    string(item.id, 'lesson.id', 100); string(item.sourceRevision, 'lesson.sourceRevision', 128); string(item.summary, 'lesson.summary');
  });
  unique(value.consumedLessons.map((item) => item.id), 'consumedLessons');
  usage(value.usage);
  if (value.inFlight !== null) {
    exact(value.inFlight, ['id', 'startedAt', 'scenarioId'], 'inFlight');
    string(value.inFlight.id, 'inFlight.id', 100);
    if (!iso(value.inFlight.startedAt)) throw new Error('inFlight.startedAt is invalid');
    if (!value.scenarios.some((item) => item.id === value.inFlight.scenarioId)) throw new Error('inFlight.scenarioId is unknown');
  }
  if (!Array.isArray(value.observations) || !Array.isArray(value.findings) || !Array.isArray(value.coverage)) throw new Error('run history arrays are required');
  value.observations.forEach(observation); value.findings.forEach(finding); value.coverage.forEach(coverage);
  unique(value.observations.map((item) => item.id), 'observations');
  unique(value.findings.map((item) => item.id), 'findings');
  const scenarioIds = new Set(value.scenarios.map((item) => item.id));
  for (const item of [...value.observations, ...value.findings, ...value.coverage]) if (!scenarioIds.has(item.scenarioId)) throw new Error('history refers to an unknown scenario');
  const observationIds = new Set(value.observations.map((item) => item.id));
  for (const item of value.findings) for (const id of item.observationIds) if (!observationIds.has(id)) throw new Error('finding refers to an unknown observation');
  return value;
}

function safeAbsolute(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.split(path.sep).includes('..')) throw new Error(`${label} must be an absolute path without parent traversal`);
  return path.resolve(input);
}
async function ensureDirectory(dir, create = false, privateLeaf = false) {
  const target = safeAbsolute(dir, 'directory');
  if (privateLeaf && target === path.parse(target).root) throw new Error('run directory cannot be a filesystem root');
  const parts = target.split(path.sep).filter(Boolean);
  let current = path.parse(target).root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await mkdir(current, { mode: 0o700 });
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe directory: ${current}`);
    if (privateLeaf && current === target && (stat.mode & 0o077) !== 0) throw new Error(`run directory is not private: ${current}`);
  }
  return target;
}
async function readJson(file, privateFile = true) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || privateFile && (stat.mode & 0o077) !== 0) throw new Error(`unsafe record file: ${file}`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
async function writeJson(file, value) {
  const dir = await ensureDirectory(path.dirname(file), true);
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try {
    try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe record file: ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
async function withLock(runDir, action) {
  const lock = path.join(runDir, '.lock');
  const handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { return await action(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}
export async function createRun({ rootDir = defaultRoot, revision, settings = { durationMinutes: 120, budgetUsd: 0.10 }, model = {}, persona, scenarios, memoryFile, now = new Date().toISOString() }) {
  await ensureDirectory(rootDir, true, true);
  if (!iso(now)) throw new Error('now is invalid');
  const id = `${now.replace(/[:.]/g, '-')}-${randomUUID()}`;
  const runDir = path.join(rootDir, id);
  const memory = memoryFile ? await loadMemory(memoryFile) : { version: RECORD_VERSION, lessons: [], regressions: [] };
  const consumedLessons = selectLessons(memory, { personaId: persona?.id, scenarioIds: scenarios?.map((item) => item.id), revision });
  const run = validateRun({ version: RECORD_VERSION, id, status: 'active', createdAt: now, updatedAt: now, closedAt: null, closeReason: null, revision, settings, model, persona, scenarios, currentScenarioId: null, consumedLessons, usage: { knownCostUsd: 0, unknownCostRequests: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 }, inFlight: null, observations: [], findings: [], coverage: [] });
  await mkdir(runDir, { mode: 0o700 });
  await writeJson(path.join(runDir, 'run.json'), run);
  return { runDir, run };
}
export async function loadRun({ runDir }) {
  await ensureDirectory(runDir, false, true);
  return validateRun(await readJson(path.join(runDir, 'run.json')));
}
export function runDecision(run, { now = new Date().toISOString(), usage: currentUsage = run.usage, adapterBusy = false } = {}) {
  validateRun(run); usage(currentUsage);
  if (!iso(now)) throw new Error('now is invalid');
  for (const key of Object.keys(run.usage)) if (currentUsage[key] < run.usage[key]) throw new Error(`usage.${key} cannot decrease`);
  if (run.status !== 'active') return { allowNewTurn: false, reason: 'closed' };
  if (run.inFlight || adapterBusy) return { allowNewTurn: false, reason: 'turn-in-flight' };
  if (Date.parse(now) >= Date.parse(run.createdAt) + run.settings.durationMinutes * 60_000) return { allowNewTurn: false, reason: 'time-limit' };
  if (currentUsage.unknownCostRequests > 0) return { allowNewTurn: false, reason: 'unknown-cost' };
  if (currentUsage.knownCostUsd >= run.settings.budgetUsd) return { allowNewTurn: false, reason: 'spending-threshold' };
  return { allowNewTurn: true, reason: null };
}
export async function updateRun({ runDir, event, now = new Date().toISOString() }) {
  await ensureDirectory(runDir, false, true);
  return withLock(runDir, async () => {
    const run = await loadRun({ runDir });
    if (run.status !== 'active') throw new Error('run is closed');
    if (!iso(now)) throw new Error('now is invalid');
    object(event, 'event');
    const eventFields = {
      'scenario.start': ['type', 'scenarioId'],
      'observation.add': ['type', 'observation'],
      'finding.add': ['type', 'finding'],
      'finding.update': ['type', 'findingId', 'finding'],
      'coverage.add': ['type', 'scenarioId', 'outcome', 'evidence', 'at'],
      'usage.record': ['type', 'usage'],
      'turn.start': ['type', 'scenarioId', 'id'],
      'turn.finish': ['type', 'id', 'usage'],
    };
    if (!own(eventFields, event.type)) throw new Error('unknown event type');
    exact(event, eventFields[event.type], 'event');
    const next = structuredClone(run);
    switch (event.type) {
      case 'scenario.start':
        if (!next.scenarios.some((item) => item.id === event.scenarioId)) throw new Error('unknown scenario');
        if (next.inFlight) throw new Error('turn is in flight');
        next.currentScenarioId = event.scenarioId;
        break;
      case 'observation.add': next.observations.push(observation(event.observation)); break;
      case 'finding.add': next.findings.push(finding(event.finding)); break;
      case 'finding.update': {
        const index = next.findings.findIndex((item) => item.id === event.findingId);
        if (index < 0) throw new Error('unknown finding');
        if (event.finding.id !== event.findingId || event.finding.scenarioId !== next.findings[index].scenarioId) throw new Error('finding identity cannot change');
        next.findings[index] = finding(event.finding);
        break;
      }
      case 'coverage.add': next.coverage.push(coverage({ scenarioId: event.scenarioId, at: event.at ?? now, outcome: event.outcome, evidence: event.evidence })); break;
      case 'usage.record': {
        usage(event.usage);
        for (const key of Object.keys(next.usage)) if (event.usage[key] < next.usage[key]) throw new Error(`usage.${key} cannot decrease`);
        next.usage = event.usage;
        break;
      }
      case 'turn.start': {
        const decision = runDecision(next, { now });
        if (!decision.allowNewTurn) throw new Error(`new paid turn stopped: ${decision.reason}`);
        if (!next.scenarios.some((item) => item.id === event.scenarioId)) throw new Error('unknown scenario');
        string(event.id, 'turn.id', 100);
        next.inFlight = { id: event.id, startedAt: now, scenarioId: event.scenarioId };
        break;
      }
      case 'turn.finish':
        if (!next.inFlight || next.inFlight.id !== event.id) throw new Error('turn id mismatch');
        usage(event.usage);
        for (const key of Object.keys(next.usage)) if (event.usage[key] < next.usage[key]) throw new Error(`usage.${key} cannot decrease`);
        next.usage = event.usage;
        next.inFlight = null;
        break;
      default: throw new Error('unknown event type');
    }
    next.updatedAt = now;
    validateRun(next);
    await writeJson(path.join(runDir, 'run.json'), next);
    return next;
  });
}
export async function closeRun({ runDir, reason, now = new Date().toISOString() }) {
  await ensureDirectory(runDir, false, true);
  return withLock(runDir, async () => {
    const run = await loadRun({ runDir });
    if (run.status === 'closed') return run;
    if (run.inFlight) throw new Error('finish or account for the in-flight turn before closing');
    string(reason, 'close reason', 500);
    if (!iso(now)) throw new Error('now is invalid');
    const next = validateRun({ ...run, status: 'closed', closeReason: reason, closedAt: now, updatedAt: now });
    await writeJson(path.join(runDir, 'run.json'), next);
    return next;
  });
}

export function packetFor(run, role, input = {}) {
  validateRun(run);
  oneOf(role, new Set(['explorer', 'coordinator', 'investigator', 'verifier']), 'role');
  if (role === 'explorer') {
    exact(input, ['persona', 'mission', 'browserProcedure'], 'explorer input');
    return { version: RECORD_VERSION, role, persona: string(input.persona, 'persona', 8000), mission: string(input.mission, 'mission', 8000), browserProcedure: string(input.browserProcedure, 'browserProcedure', 8000) };
  }
  return { version: RECORD_VERSION, role, run, source: input.source ?? null, expected: input.expected ?? null };
}

const secretPattern = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|rk|pk)-(?:or-|proj-)?[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|(?:^|[\s])(?:\/|\.\.\/|[A-Za-z]:\\)|\b(?:user|assistant|system)\s*:)/i;
function safeText(value, label, max = 2000) {
  string(value, label, max);
  if (secretPattern.test(value) || /[<>]/.test(value)) throw new Error(`${label} contains sensitive text or a path`);
  return value;
}
function memoryRecord(value) {
  exact(value, ['version', 'lessons', 'regressions'], 'memory');
  if (value.version !== RECORD_VERSION || !Array.isArray(value.lessons) || !Array.isArray(value.regressions)) throw new Error('invalid memory version or arrays');
  for (const item of value.lessons) {
    exact(item, ['id', 'personaId', 'scenarioId', 'sourceRevision', 'summary', 'sourceObservationId', 'sourceFindingId', 'reviewedBy', 'reviewedAt', 'synthetic'], 'lesson');
    safeText(item.id, 'lesson.id', 100); safeText(item.personaId, 'lesson.personaId', 100);
    safeText(item.scenarioId, 'lesson.scenarioId', 100); safeText(item.sourceRevision, 'lesson.sourceRevision', 128);
    safeText(item.summary, 'lesson.summary'); safeText(item.sourceObservationId, 'lesson.sourceObservationId', 100);
    if (item.sourceFindingId !== null) safeText(item.sourceFindingId, 'lesson.sourceFindingId', 100);
    safeText(item.reviewedBy, 'lesson.reviewedBy', 100);
    if (!iso(item.reviewedAt) || item.synthetic !== true) throw new Error('lesson needs synthetic and review provenance');
  }
  for (const item of value.regressions) {
    exact(item, ['id', 'personaId', 'scenarioId', 'sourceRevision', 'findingId', 'setup', 'action', 'expected', 'reviewedBy', 'reviewedAt', 'synthetic'], 'regression');
    for (const key of ['id', 'personaId', 'scenarioId', 'sourceRevision', 'findingId', 'setup', 'action', 'expected', 'reviewedBy']) safeText(item[key], `regression.${key}`, key === 'id' ? 100 : 2000);
    if (!iso(item.reviewedAt) || item.synthetic !== true) throw new Error('regression needs synthetic and review provenance');
  }
  unique(value.lessons.map((item) => item.id), 'memory lessons');
  unique(value.regressions.map((item) => item.id), 'memory regressions');
  return value;
}
export async function loadMemory(memoryFile) {
  const file = safeAbsolute(memoryFile, 'memoryFile');
  await ensureDirectory(path.dirname(file));
  try { return memoryRecord(await readJson(file, false)); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: RECORD_VERSION, lessons: [], regressions: [] };
    throw error;
  }
}
export function selectLessons(memory, { personaId, scenarioIds, revision }) {
  memoryRecord(memory);
  if (!Array.isArray(scenarioIds)) throw new Error('scenarioIds must be an array');
  const scenarios = new Set(scenarioIds);
  return memory.lessons.filter((item) => item.personaId === personaId && scenarios.has(item.scenarioId)).sort((a, b) => Number(b.sourceRevision === revision) - Number(a.sourceRevision === revision)).map((item) => ({ id: item.id, sourceRevision: item.sourceRevision, summary: item.summary }));
}
export async function promoteMemory({ runDir, memoryFile, lessons = [], regressions = [] }) {
  const run = await loadRun({ runDir });
  if (!Array.isArray(lessons) || !Array.isArray(regressions) || !lessons.length && !regressions.length) throw new Error('select at least one structured record');
  const memory = await loadMemory(memoryFile);
  const observations = new Map(run.observations.map((item) => [item.id, item]));
  for (const lesson of lessons) {
    if (lesson.sourceRevision !== run.revision || lesson.personaId !== run.persona.id || !run.scenarios.some((item) => item.id === lesson.scenarioId) || observations.get(lesson.sourceObservationId)?.scenarioId !== lesson.scenarioId) throw new Error('lesson provenance does not match this run');
    if (lesson.sourceFindingId !== null) {
      const finding = run.findings.find((item) => item.id === lesson.sourceFindingId);
      if (!finding || finding.scenarioId !== lesson.scenarioId || finding.status !== 'resolved' || !finding.observationIds.includes(lesson.sourceObservationId)) throw new Error('finding lesson needs a resolved source');
    }
  }
  for (const regression of regressions) {
    const finding = run.findings.find((item) => item.id === regression.findingId);
    if (!finding || finding.scenarioId !== regression.scenarioId || regression.personaId !== run.persona.id || regression.sourceRevision !== run.revision || finding.status !== 'resolved' || finding.kind !== 'defect') throw new Error('regression needs a resolved defect in this run');
  }
  const next = memoryRecord({ version: RECORD_VERSION, lessons: [...memory.lessons, ...lessons], regressions: [...memory.regressions, ...regressions] });
  await writeJson(safeAbsolute(memoryFile, 'memoryFile'), next);
  return next;
}
