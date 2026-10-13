import type { DeviceConnection } from '../db/index.js';

/** Cloudflare's codes for "unknown" and Tor: not places. */
export const NOT_A_COUNTRY = new Set(['XX', 'T1']);

/** "Pune, Maharashtra", or "Austin, Texas (US)" outside India: as the app shows it. */
export function placeOf(c: Pick<DeviceConnection, 'city' | 'region' | 'country'>): string {
  const parts = [c.city, c.region].filter((p): p is string => !!p);
  const country = c.country && !NOT_A_COUNTRY.has(c.country) ? c.country : null;
  if (parts.length > 0) {
    return country && country !== 'IN' ? `${parts.join(', ')} (${country})` : parts.join(', ');
  }
  return country ?? 'Location unknown';
}
