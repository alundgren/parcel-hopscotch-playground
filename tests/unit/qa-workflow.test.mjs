import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { cumulativeUsage } from '../../scripts/qa.mjs';

test('accounting integration keeps cumulative cost and tokens separate from adapter activity fields', () => {
  const usage = { knownCostUsd: 0.01, unknownCostRequests: 1, inputTokens: 90, outputTokens: 12, requestCount: 2 };
  assert.deepEqual(cumulativeUsage({ usage: { ...usage, runningRequests: 0, activeTurns: 0, accountingMode: 'live provider audit' } }), usage);
  assert.throws(() => cumulativeUsage({}), /cumulative app usage/);
  assert.throws(() => cumulativeUsage({ usage: { ...usage, requestCount: null } }), /numeric cumulative app usage/);
});
