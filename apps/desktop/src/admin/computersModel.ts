import type { DeviceRow } from '../api.js';
import { csvCell } from './overviewModel.js';
import { compareVersions } from './versions.js';

/** The newest published version per system (ADR-0046 §3). */
export type Latest = { windows: string | null; macos: string | null };

/** Behind the latest published version for its system; unknown when nothing is published. */
export function behindLatest(d: DeviceRow, latest: Latest | null): boolean | null {
  const l = latest?.[d.os] ?? null;
  return l === null ? null : compareVersions(d.app_version, l) < 0;
}

/** `YYYY-MM-DD` on this computer's calendar. */
const day = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const computersCsvName = (now: Date): string => `cloudpunch-computers-${day(now)}.csv`;

/** ISO as `YYYY-MM-DD HH:MM` on this computer's clock; empty when none. */
function stamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${day(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Computers → Export CSV: the rows as shown, one line each. */
export function computersCsv(rows: readonly DeviceRow[], latest: Latest | null): string {
  const head = [
    'Person',
    'Email',
    'System',
    'CloudPunch version',
    'Latest for system',
    'Up to date',
    'First set up',
    'Last seen',
    'Status',
  ];
  const lines = rows.map((d) => {
    const behind = behindLatest(d, latest);
    return [
      d.display_name,
      d.work_email,
      d.os === 'windows' ? 'Windows' : 'macOS',
      d.app_version,
      latest?.[d.os] ?? '',
      behind === null ? 'unknown' : behind ? 'no' : 'yes',
      stamp(d.enrolled_at),
      stamp(d.last_seen_at),
      d.revoked_at ? 'signed out' : 'active',
    ]
      .map(csvCell)
      .join(',');
  });
  return [head.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}

/** One line per person behind (their computers behind, newest version asked for). */
export interface BehindPerson {
  userId: string;
  name: string;
  email: string;
  computers: { os: DeviceRow['os']; version: string }[];
}

export function peopleBehind(devices: readonly DeviceRow[], latest: Latest | null): BehindPerson[] {
  const by = new Map<string, BehindPerson>();
  for (const d of devices) {
    if (d.revoked_at !== null || behindLatest(d, latest) !== true) continue;
    const p = by.get(d.user_id) ?? {
      userId: d.user_id,
      name: d.display_name,
      email: d.work_email,
      computers: [],
    };
    p.computers.push({ os: d.os, version: d.app_version });
    by.set(d.user_id, p);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
