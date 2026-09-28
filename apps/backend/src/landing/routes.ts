import { createReadStream, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * The service address in a browser (owner request): a friendly CloudPunch
 * page with the real logo, a **Download for Windows** button for the
 * newest published installer, what's new in it, and earlier versions
 * (ADR-0019 §9).
 *
 * - Rendered here, with no scripts and nothing about the user, under a
 *   CSP that allows only its own inline styles and same-site images.
 * - `/download/windows` serves the newest installer. Cloudflare Access in
 *   front of `/download*` limits it to ApTask accounts; the app's `/v1`
 *   traffic is not behind Access.
 * - Releases live in `<DOWNLOADS_DIR>/windows/releases.json`, newest
 *   first; `scripts/publish-installer.sh` adds to it.
 */

export interface LandingOptions {
  /** Where published installers live; unset means no download button. */
  downloadsDir?: string | undefined;
}

export interface Release {
  version: string;
  file: string;
  size: number;
  sha256: string;
  published_at: string;
  /** What's new, one line each. */
  notes: string[];
}

const isRelease = (r: Partial<Release>): r is Release =>
  typeof r.version === 'string' &&
  /^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(r.version) &&
  typeof r.file === 'string' &&
  /^[\w.-]+\.exe$/.test(r.file) &&
  typeof r.size === 'number' &&
  typeof r.sha256 === 'string' &&
  /^[0-9a-f]{64}$/.test(r.sha256) &&
  typeof r.published_at === 'string' &&
  Array.isArray(r.notes) &&
  r.notes.every((n) => typeof n === 'string');

/** Published releases, newest first; only well-formed entries. */
export async function readReleases(downloadsDir: string | undefined): Promise<Release[]> {
  if (!downloadsDir) return [];
  try {
    const raw = JSON.parse(
      await readFile(join(downloadsDir, 'windows', 'releases.json'), 'utf8'),
    ) as unknown;
    return Array.isArray(raw) ? (raw as Partial<Release>[]).filter(isRelease) : [];
  } catch {
    return [];
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;
/** "28 Sep 2026" from an ISO time; the raw text if it isn't one. */
const day = (iso: string): string => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};
const notesList = (notes: string[]): string =>
  notes.length > 0 ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';

/** How many earlier versions the page lists. */
const HISTORY = 5;

export function page(releases: Release[]): string {
  const [latest, ...earlier] = releases;
  const download = latest
    ? `<a class="btn" href="/download/windows">Download for Windows</a>
  <p class="meta">Version ${esc(latest.version)} · ${esc(day(latest.published_at))} · ${esc(mb(latest.size))} · ApTask account required</p>
  <p class="meta">Windows may say "unknown publisher" for this pilot build: choose <b>More info → Run anyway</b>.</p>
  ${latest.notes.length > 0 ? `<h2>What's new in ${esc(latest.version)}</h2>${notesList(latest.notes)}` : ''}
  <details><summary>Check the file</summary>
    <p class="meta">SHA-256 <code>${esc(latest.sha256)}</code></p>
    <p class="meta">In PowerShell: <code>Get-FileHash .\\${esc(latest.file)}</code></p>
  </details>
  ${
    earlier.length > 0
      ? `<details><summary>Earlier versions</summary>${earlier
          .slice(0, HISTORY)
          .map(
            (r) =>
              `<h3>${esc(r.version)} <span class="when">· ${esc(day(r.published_at))}</span></h3>${notesList(r.notes)}`,
          )
          .join('')}</details>`
      : ''
  }`
    : `<p class="meta">Ask your manager or HR for the CloudPunch app.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>CloudPunch · ApTask</title>
<link rel="icon" href="/favicon.ico">
<style>
  :root { color-scheme: light dark; --bg: #f4f6fb; --card: #ffffff; --text: #0f1b33; --muted: #5d6675; --accent: #018afe; --navy: #012456; --line: #e3e8f0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --card: #141d2e; --text: #eaf2ff; --muted: #9aa8bf; --navy: #eaf2ff; --line: #26324a; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
         background: var(--bg); color: var(--text);
         font: 15px/1.55 "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif; }
  main { max-width: 480px; width: 100%; background: var(--card); border-radius: 18px; padding: 30px 28px;
         box-shadow: 0 10px 40px rgba(1, 36, 86, 0.10); }
  .logo { display: block; height: 64px; width: auto; margin: 0 0 16px; }
  p { margin: 0 0 14px; color: var(--muted); }
  ol, ul { margin: 0 0 16px; padding-left: 20px; color: var(--muted); }
  li { margin: 3px 0; }
  h2 { margin: 18px 0 6px; font-size: 14px; color: var(--navy); }
  h3 { margin: 12px 0 4px; font-size: 13px; color: var(--text); }
  .when { font-weight: 400; color: var(--muted); }
  .btn { display: inline-block; margin: 2px 0 10px; padding: 12px 18px; border-radius: 10px; background: var(--accent);
         color: #fff; font-weight: 600; text-decoration: none; }
  .btn:hover { filter: brightness(1.08); }
  .meta { font-size: 12.5px; margin-bottom: 8px; }
  details { margin: 0 0 10px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); }
  summary { cursor: pointer; margin-bottom: 6px; }
  code { font: 11.5px/1.4 ui-monospace, Consolas, monospace; word-break: break-all; }
  .ok { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); margin-top: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
  footer { margin-top: 16px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <picture>
    <source srcset="/brand/logo-reversed.png" media="(prefers-color-scheme: dark)">
    <img class="logo" src="/brand/logo.png" alt="CloudPunch" width="120" height="64">
  </picture>
  <p>ApTask's time and attendance app. This address is the service behind it.</p>
  <ol>
    <li>Install the CloudPunch app.</li>
    <li>Sign in with your ApTask Microsoft account.</li>
    <li>Clock in from the app.</li>
  </ol>
  ${download}
  <span class="ok"><span class="dot" aria-hidden="true"></span>Service is running</span>
  <footer>Questions? Ask your manager or HR.</footer>
</main>
</body>
</html>
`;
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Brand images, bundled with the backend (from docs/brand/). */
function asset(name: string): Buffer {
  return readFileSync(new URL(`../../assets/brand/${name}`, import.meta.url));
}

const landingRoutesImpl: FastifyPluginAsync<LandingOptions> = async (app, opts) => {
  const images: Record<string, [Buffer, string]> = {
    '/brand/logo.png': [asset('logo.png'), 'image/png'],
    '/brand/logo-reversed.png': [asset('logo-reversed.png'), 'image/png'],
    '/favicon.ico': [asset('favicon.ico'), 'image/x-icon'],
  };
  for (const [path, [body, type]] of Object.entries(images)) {
    app.get(path, async (_req, reply) =>
      reply
        .code(200)
        .type(type)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'public, max-age=86400')
        .send(body),
    );
  }

  app.get('/', async (_req, reply) =>
    reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('content-security-policy', CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache')
      .send(page(await readReleases(opts.downloadsDir))),
  );

  app.get('/download', async (_req, reply) => reply.redirect('/download/windows'));

  app.get('/download/windows', async (_req, reply) => {
    const [latest] = await readReleases(opts.downloadsDir);
    if (!latest || !opts.downloadsDir) {
      return reply.code(404).type('text/plain').send('No installer is published yet.');
    }
    const path = join(opts.downloadsDir, 'windows', latest.file);
    const info = await stat(path).catch(() => null);
    if (!info || info.size !== latest.size) {
      return reply
        .code(503)
        .type('text/plain')
        .send('The installer is being updated. Try again shortly.');
    }
    return reply
      .code(200)
      .type('application/vnd.microsoft.portable-executable')
      .header('content-disposition', `attachment; filename="${latest.file}"`)
      .header('content-length', String(info.size))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('x-checksum-sha256', latest.sha256)
      .send(createReadStream(path));
  });
};

export const landingRoutes = fp(landingRoutesImpl, { name: 'cloudpunch-landing', fastify: '4.x' });
export default landingRoutes;
