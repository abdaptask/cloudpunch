import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Platform } from './routes.js';

/**
 * Short-lived download links (owner decision, 2026-10-13): the
 * installers were behind Cloudflare Access, whose free plan ran out of
 * seats. Now someone signs in with Microsoft on the web page, the API
 * (which checks the token as for everything else, invariant 6) hands out
 * a link to that platform's newest installer, and `/get/:platform`
 * serves it while the link is fresh.
 *
 * A link is `HMAC(secret, platform, file, expiry)`. The secret is made
 * when the server starts, so a restart only cuts off links not yet used.
 */

/** How long a link works. */
export const LINK_TTL_MS = 10 * 60_000;

const SECRET = randomBytes(32);

function mac(platform: Platform, file: string, expires: number, secret: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${platform}\n${file}\n${expires}`)
    .digest('base64url');
}

/** `t=<expiry>.<mac>` for the newest file of a platform. */
export function signLink(
  platform: Platform,
  file: string,
  now: number,
  secret: Buffer = SECRET,
): string {
  const expires = now + LINK_TTL_MS;
  return `${expires}.${mac(platform, file, expires, secret)}`;
}

/** Whether `token` is a fresh link for this platform's `file`. */
export function linkValid(
  platform: Platform,
  file: string,
  token: string,
  now: number,
  secret: Buffer = SECRET,
): boolean {
  const m = /^(\d{10,16})\.([\w-]{43})$/.exec(token);
  if (!m) return false;
  const expires = Number(m[1]);
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + LINK_TTL_MS) return false;
  const want = Buffer.from(mac(platform, file, expires, secret));
  const got = Buffer.from(m[2] ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}
