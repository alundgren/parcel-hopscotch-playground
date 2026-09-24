import { DatabaseSync } from 'node:sqlite';

const terminal = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
export class AccountingUnavailableError extends Error {
  constructor() {
    super('Application accounting is unavailable; new browser actions are stopped.');
    this.name = 'AccountingUnavailableError';
  }
}

export const unavailableUsage = () => ({
  knownCostUsd: null, unknownCostRequests: null, inputTokens: null, outputTokens: null,
  requestCount: null, runningRequests: null, activeTurns: null,
  accountingMode: 'unavailable', accountingAvailable: false,
});

export function readAccounting(databasePath, mode, retry = 0) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 5000');
    const attempts = database.prepare('SELECT mode, outcome, cost_usd, input_tokens, output_tokens FROM provider_attempts').all();
    const activeTurns = database.prepare("SELECT COUNT(*) AS count FROM agent_turns WHERE status NOT IN ('complete','failed','cancelled','interrupted')").get().count;
    const live = attempts.filter((attempt) => attempt.mode === 'live');
    return {
      knownCostUsd: live.reduce((total, attempt) => total + (attempt.cost_usd ?? 0), 0),
      unknownCostRequests: live.filter((attempt) => attempt.outcome !== 'running' && attempt.cost_usd === null).length,
      inputTokens: attempts.reduce((total, attempt) => total + (attempt.input_tokens ?? 0), 0),
      outputTokens: attempts.reduce((total, attempt) => total + (attempt.output_tokens ?? 0), 0),
      requestCount: attempts.length,
      runningRequests: live.filter((attempt) => attempt.outcome === 'running').length,
      activeTurns,
      accountingMode: mode === 'offline' ? 'scripted fixture; no paid inference' : 'live provider audit',
      accountingAvailable: true,
    };
  } catch (error) {
    if ((error?.code === 'SQLITE_BUSY' || /database is locked/.test(error?.message ?? '')) && retry < 5) {
      const delay = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(delay, 0, 0, 100);
      return readAccounting(databasePath, mode, retry + 1);
    }
    if (error?.code === 'SQLITE_CANTOPEN' || /unable to open database file|no such table/.test(error?.message ?? '')) throw new AccountingUnavailableError();
    throw error;
  } finally {
    database?.close();
  }
}

export function paidTurnDecision(usage, budgetUsd, pendingTurn) {
  if (!usage?.accountingAvailable || !Number.isFinite(usage.knownCostUsd) || !Number.isInteger(usage.unknownCostRequests)) return { allowed: false, reason: 'accounting_unavailable' };
  if (usage.unknownCostRequests > 0) return { allowed: false, reason: 'unknown_cost' };
  if (usage.knownCostUsd >= budgetUsd) return { allowed: false, reason: 'budget_reached' };
  if (pendingTurn || usage.activeTurns > 0 || usage.runningRequests > 0) return { allowed: false, reason: 'turn_in_progress' };
  return { allowed: true, reason: null };
}

export function isTerminalTurn(databasePath, turnId) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 5000');
    const row = database.prepare('SELECT status FROM agent_turns WHERE id = ? ORDER BY started_at DESC LIMIT 1').get(turnId);
    return row !== undefined && terminal.has(row.status);
  } catch (error) {
    if (error?.code === 'SQLITE_CANTOPEN' || error?.code === 'SQLITE_BUSY' || /database is locked/.test(error?.message ?? '')) return false;
    throw error;
  } finally {
    database?.close();
  }
}

export function reconcileInterrupted(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const now = new Date().toISOString();
    database.prepare("UPDATE provider_attempts SET outcome = 'interrupted', completed_at = ?, cost_usd = NULL, error_code = 'qa_session_stopped' WHERE outcome = 'running'").run(now);
    database.prepare("UPDATE agent_turns SET status = 'interrupted', finished_at = ?, error_message = 'The QA session stopped.' WHERE status NOT IN ('complete','failed','cancelled','interrupted')").run(now);
  } finally {
    database.close();
  }
}
