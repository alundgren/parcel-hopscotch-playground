import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { boundedSnapshotText } from '../../qa/parcel/snapshot.mjs';

test('long conversations preserve current work and the newest answer within the snapshot limit', () => {
  const start = 'Review 6 changes. Accept 6 changes. Cancel.\n';
  const latest = '\nLatest answer: this order is resolved and awaits packing.\nMessage. Send message.';
  const result = boundedSnapshotText(start + 'An earlier conversation.\n'.repeat(2000) + latest);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 24_000);
  assert.ok(result.text.startsWith(start));
  assert.ok(result.text.endsWith(latest));
  assert.deepEqual(boundedSnapshotText('Ready 6'), { text: 'Ready 6', truncated: false });
});
