import { isIPv4, isIPv6 } from 'node:net';

/**
 * What the server can tell about a request's connection (ADR-0029 §3):
 * the address it came from and, behind Cloudflare, the approximate
 * place. Nothing here comes from the laptop.
 */
export interface ConnectionSeen {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
}

/** The parts of a Fastify request this reads. */
export interface RequestLike {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * `req.ip` is already the visitor's address: Fastify's `trustProxy`
 * takes `X-Forwarded-For` only from 127.0.0.1, which is cloudflared or
 * Caddy (ADR-0019). The location headers are only believed when
 * `cf-ray` shows the request came through Cloudflare. On the office
 * path through Caddy they're left out.
 */
export function connectionFromRequest(req: RequestLike): ConnectionSeen {
  const ip = unmapIPv4(req.ip);
  if (!header(req, 'cf-ray')) return { ip, city: null, region: null, country: null };
  const country = header(req, 'cf-ipcountry')?.toUpperCase() ?? null;
  return {
    ip,
    city: text(header(req, 'cf-ipcity'), 100),
    region: text(header(req, 'cf-region'), 100),
    country: country && /^[A-Z0-9]{2}$/.test(country) ? country : null,
  };
}

/** Whether Cloudflare's location headers are on this request (for a one-time log). */
export function hasLocationHeaders(req: RequestLike): boolean {
  return header(req, 'cf-ipcity') !== undefined || header(req, 'cf-region') !== undefined;
}

/**
 * Two addresses with the same key are the same connection (ADR-0029
 * amendment): IPv4 exactly, IPv6 by its /64, so a laptop's rotating
 * IPv6 privacy address doesn't count as a new network.
 */
export function networkKey(ip: string): string {
  const addr = unmapIPv4(ip);
  if (isIPv4(addr) || !isIPv6(addr)) return addr;
  return `${expandIPv6(addr).slice(0, 4).join(':')}::/64`;
}

function unmapIPv4(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}

/** The eight groups of an IPv6 address, lower case, without leading zeros. */
function expandIPv6(ip: string): string[] {
  const bare = ip.split('%')[0] ?? ip; // drop a zone id
  const [head = '', tail] = bare.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => g.replace(/^0+(?=.)/, ''));
}

function header(req: RequestLike, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s.trim() === '' ? undefined : s;
}

/**
 * Node reads header bytes as latin1; Cloudflare sends UTF-8 (city names
 * like "Bengaluru" are ASCII, but not every one is). Re-decode, drop
 * control characters and cap the length.
 */
function text(raw: string | undefined, max: number): string | null {
  if (raw === undefined) return null;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  const clean = (decoded.includes('�') ? raw : decoded)
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, max);
  return clean === '' ? null : clean;
}
