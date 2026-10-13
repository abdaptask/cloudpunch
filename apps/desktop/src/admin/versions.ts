import type { DeviceRow } from '../api.js';

/** a > b for `x.y.z` versions; anything unparseable sorts first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** "0.1.4 × 3 · 0.1.2 × 1", newest first. */
export function versionSummary(devices: readonly DeviceRow[]): string {
  const counts = new Map<string, number>();
  for (const d of devices) counts.set(d.app_version, (counts.get(d.app_version) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => compareVersions(b, a))
    .map(([v, n]) => `${v} × ${n}`)
    .join(' · ');
}
