#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readAccounting } from './accounting.mjs';

const index = process.argv.indexOf('--run-dir');
const supplied = index < 0 ? null : process.argv[index + 1];
if (!supplied || !isAbsolute(supplied)) throw new Error('--run-dir must be an absolute path.');
const directory = resolve(supplied);
const session = JSON.parse(await readFile(join(directory, 'parcel-session.json'), 'utf8'));
const database = new DatabaseSync(join(directory, 'parcel-workspace.sqlite'), { readOnly: true });
try {
  database.exec('PRAGMA busy_timeout = 5000');
  const rows = (sql) => database.prepare(sql).all();
  const result = {
    mode: session.mode,
    startedAt: session.startedAt,
    deadlineAt: session.deadlineAt,
    usage: readAccounting(join(directory, 'parcel-workspace.sqlite'), session.mode),
    queue: rows('SELECT order_id, status, family, issue, version, completed, resolved, state_json FROM orders ORDER BY order_id'),
    proposals: rows('SELECT id, generation, status, payload_json, created_at FROM proposals ORDER BY created_at'),
    receipts: rows('SELECT id, generation, proposal_id, payload_json, committed_at, undone_by FROM receipts ORDER BY committed_at'),
    inventory: rows('SELECT sku, quantity, version FROM inventory ORDER BY sku'),
    turns: rows('SELECT id, generation, status, started_at, finished_at, complete_duration_ms, measurement, server_duration_ms, server_measurement FROM agent_turns ORDER BY started_at'),
    audit: rows('SELECT kind, label, outcome, request_id, turn_id, proposal_id, receipt_id, completed_at FROM audit_records ORDER BY completed_at'),
    attempts: rows('SELECT id, turn_id, mode, kind, outcome, cost_usd, input_tokens, output_tokens, started_at, completed_at, error_code FROM provider_attempts ORDER BY started_at'),
  };
  console.log(JSON.stringify(result));
} finally {
  database.close();
}
