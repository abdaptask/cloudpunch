import type { FastifyBaseLogger } from 'fastify';
import maxmind, { type AsnResponse, type Reader } from 'maxmind';

/** The internet provider behind an address (ADR-0029 §3). */
export interface Provider {
  asn: number | null;
  provider: string | null;
}

export interface ProviderLookup {
  lookup(ip: string): Promise<Provider>;
}

/** The one call this needs from a `maxmind` reader. */
export type AsnReader = Pick<Reader<AsnResponse>, 'get'>;
export type OpenFile = (path: string) => Promise<AsnReader>;

const NONE: Provider = { asn: null, provider: null };
/** How long to wait before trying a missing file again. */
export const RETRY_OPEN_MS = 10 * 60 * 1000;

/**
 * Reads DB-IP's free "IP to ASN Lite" file on this server (CC BY 4.0),
 * so no address leaves the VM. It's GeoLite2-ASN compatible, so the
 * `maxmind` package reads it directly. The monthly job replaces the
 * file and the reader picks the new one up by itself.
 *
 * A missing or unreadable file means no provider name, never a failed
 * request: it's tried again every 10 minutes.
 */
export class DbIpProviderLookup implements ProviderLookup {
  private reader: AsnReader | null = null;
  private opening: Promise<void> | null = null;
  private retryAt = 0;
  private warned = false;

  constructor(
    private readonly path: string,
    private readonly log: FastifyBaseLogger,
    private readonly now: () => number = Date.now,
    private readonly openFile: OpenFile = (path) =>
      maxmind.open<AsnResponse>(path, {
        watchForUpdates: true,
        watchForUpdatesNonPersistent: true,
      }),
  ) {}

  async lookup(ip: string): Promise<Provider> {
    const reader = await this.open();
    if (!reader) return NONE;
    try {
      const hit = reader.get(ip);
      if (!hit) return NONE;
      const asn = hit.autonomous_system_number;
      return {
        asn: Number.isInteger(asn) && asn > 0 ? asn : null,
        provider: hit.autonomous_system_organization?.trim().slice(0, 200) || null,
      };
    } catch {
      return NONE; // not an address the file can answer for
    }
  }

  private async open(): Promise<AsnReader | null> {
    if (this.reader) return this.reader;
    if (this.now() < this.retryAt) return null;
    this.opening ??= this.openFile(this.path)
      .then((r) => {
        this.reader = r;
        this.log.info({ path: this.path }, 'connections: provider database loaded');
      })
      .catch((err: unknown) => {
        this.retryAt = this.now() + RETRY_OPEN_MS;
        if (!this.warned) {
          this.warned = true;
          this.log.warn({ err, path: this.path }, 'connections: no provider database');
        }
      })
      .finally(() => {
        this.opening = null;
      });
    await this.opening;
    return this.reader;
  }
}
