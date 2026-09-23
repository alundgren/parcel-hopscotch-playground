export function boundedSnapshotText(value) {
  const limit = 24_000;
  if (value.length <= limit) return { text: value, truncated: false };
  const marker = '\n[Earlier page content omitted; recent content follows.]\n';
  const first = Math.floor((limit - marker.length) / 2);
  const last = limit - marker.length - first;
  return { text: value.slice(0, first) + marker + value.slice(-last), truncated: true };
}
