import type { Connection } from './api.js';
import { dayLabel, localDateOf } from './dayHistory.js';
import { formatClock } from './timelineModel.js';

/**
 * How a connection reads on screen (ADR-0029): the place, the provider
 * and when it was seen. All of it is approximate and comes from the
 * server, never the computer.
 */

/** "Pune, Maharashtra", "Pune", the country code, or "Location unknown". */
export function placeOf(c: Pick<Connection, 'city' | 'region' | 'country'>): string {
  const parts = [c.city, c.region].filter((p): p is string => !!p);
  // Cloudflare's codes for "unknown" and Tor aren't places.
  const country = c.country && c.country !== 'XX' && c.country !== 'T1' ? c.country : null;
  if (parts.length > 0)
    return country && country !== 'IN' ? `${parts.join(', ')} (${country})` : parts.join(', ');
  return country ?? 'Location unknown';
}

/** Short provider name: "Tata Play Broadband Private Limited" → "Tata Play Broadband". */
export function providerOf(c: Pick<Connection, 'provider'>): string {
  if (!c.provider) return 'Provider unknown';
  const short = c.provider
    .replace(/\b(private|pvt\.?|limited|ltd\.?|inc\.?|llc|co\.?)(?=\s|$)/gi, '')
    .replace(/[\s,.]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return short || c.provider;
}

const OS: Record<string, string> = { windows: 'Windows', macos: 'Mac' };
export const osOf = (c: Pick<Connection, 'device_os'>): string | null =>
  c.device_os ? (OS[c.device_os] ?? c.device_os) : null;

/** "Today 09:14–17:40", "Yesterday 21:05 – Today 01:10". */
export function seenOf(c: Pick<Connection, 'first_seen_at' | 'last_seen_at'>, now: number): string {
  const today = localDateOf(now);
  const from = Date.parse(c.first_seen_at);
  const to = Date.parse(c.last_seen_at);
  const fromDay = dayLabel(localDateOf(from), today);
  const toDay = dayLabel(localDateOf(to), today);
  if (from === to) return `${fromDay} ${formatClock(from)}`;
  if (fromDay === toDay) return `${fromDay} ${formatClock(from)}–${formatClock(to)}`;
  return `${fromDay} ${formatClock(from)} – ${toDay} ${formatClock(to)}`;
}
