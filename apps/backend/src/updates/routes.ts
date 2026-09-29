import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { requireAuth } from '../auth/require.js';
import { readReleases, type Platform, type Release } from '../landing/routes.js';

/** The updater's platform names to download folders. */
const PLATFORMS: Record<string, Platform> = { windows: 'windows', darwin: 'macos' };

/** The file the updater downloads, and its size. */
const updateOf = (r: Release): { file: string; size: number } =>
  r.update_file !== undefined && r.update_size !== undefined
    ? { file: r.update_file, size: r.update_size }
    : { file: r.file, size: r.size };

/**
 * Desktop auto-update (ADR-0022 §3), for the Tauri updater plugin.
 *
 * - `GET /v1/desktop/update/:platform/:current` (`windows` or `darwin`,
 *   ADR-0026) answers the newest signed release as a Tauri update
 *   manifest, or 204 when the caller is up to date.
 * - `GET /v1/desktop/update/files/:platform/:file` serves that update:
 *   the Windows installer, or the macOS `.app.tar.gz`.
 * - Both need the app's normal bearer token: `/v1` is not behind
 *   Cloudflare Access, which the desktop can't sign in to.
 * - Only releases with a `signature` are offered; the app refuses
 *   anything not signed with the key built into it.
 */

export interface UpdateRoutesOptions {
  /** Where published installers live; unset means never an update. */
  downloadsDir?: string | undefined;
  /** The public address the download URL is built on. */
  siteUrl: string;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** a > b for plain `x.y.z` versions; anything else is never newer. */
export function isNewer(a: string, b: string): boolean {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** The newest signed release, if any. */
function latestSigned(releases: Release[]): (Release & { signature: string }) | undefined {
  return releases.find((r): r is Release & { signature: string } => !!r.signature);
}

const updateRoutesImpl: FastifyPluginAsync<UpdateRoutesOptions> = async (app, opts) => {
  app.get<{ Params: { platform: string; current: string } }>(
    '/v1/desktop/update/:platform/:current',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const platform = PLATFORMS[req.params.platform];
      if (!platform) return reply.code(204).send();
      const latest = latestSigned(await readReleases(opts.downloadsDir, platform));
      if (!latest || !isNewer(latest.version, req.params.current)) {
        return reply.code(204).send();
      }
      const base = opts.siteUrl.replace(/\/+$/, '');
      return reply
        .code(200)
        .header('cache-control', 'no-store')
        .send({
          version: latest.version,
          notes: latest.notes.join('\n'),
          pub_date: latest.published_at,
          url: `${base}/v1/desktop/update/files/${req.params.platform}/${encodeURIComponent(updateOf(latest).file)}`,
          signature: latest.signature,
        });
    },
  );

  app.get<{ Params: { platform: string; file: string } }>(
    '/v1/desktop/update/files/:platform/:file',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const platform = PLATFORMS[req.params.platform];
      const releases = platform ? await readReleases(opts.downloadsDir, platform) : [];
      // Only a listed, signed file: never a path from the request.
      const release = releases.find((r) => r.signature && updateOf(r).file === req.params.file);
      if (!release || !opts.downloadsDir || !platform) {
        return reply
          .code(404)
          .type('application/problem+json')
          .send({ code: 'not_found', message: 'no such update' });
      }
      const update = updateOf(release);
      const path = join(opts.downloadsDir, platform, update.file);
      const info = await stat(path).catch(() => null);
      if (!info || info.size !== update.size) {
        return reply
          .code(503)
          .type('application/problem+json')
          .send({ code: 'updating', message: 'the update is being published; try later' });
      }
      return reply
        .code(200)
        .type(
          platform === 'macos'
            ? 'application/gzip'
            : 'application/vnd.microsoft.portable-executable',
        )
        .header('content-length', String(info.size))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(createReadStream(path));
    },
  );
};

export const updateRoutes = fp(updateRoutesImpl, {
  name: 'cloudpunch-desktop-update',
  fastify: '4.x',
});
export default updateRoutes;
