import type { AsnResponse } from 'maxmind';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { DbIpProviderLookup, RETRY_OPEN_MS, type AsnReader } from './provider.js';

const log = pino({ level: 'silent' });

// What DB-IP's file answers (checked against the 2026-10 file).
const TABLE: Record<string, AsnResponse> = {
  '58.84.61.202': {
    autonomous_system_number: 134674,
    autonomous_system_organization: 'Tata Play Broadband Private Limited',
  },
  '173.63.249.136': {
    autonomous_system_number: 701,
    autonomous_system_organization: 'Verizon Business',
  },
};
const fake: AsnReader = {
  get: (ip: string) => {
    if (ip === 'not-an-ip') throw new Error('invalid');
    return TABLE[ip] ?? null;
  },
};

describe('DbIpProviderLookup', () => {
  it('names the provider and network number', async () => {
    const p = new DbIpProviderLookup('x.mmdb', log, Date.now, () => Promise.resolve(fake));
    expect(await p.lookup('58.84.61.202')).toEqual({
      asn: 134674,
      provider: 'Tata Play Broadband Private Limited',
    });
  });

  it('answers none for an address it has no row for, or cannot read', async () => {
    const p = new DbIpProviderLookup('x.mmdb', log, Date.now, () => Promise.resolve(fake));
    expect(await p.lookup('10.0.0.1')).toEqual({ asn: null, provider: null });
    expect(await p.lookup('not-an-ip')).toEqual({ asn: null, provider: null });
  });

  it('opens the file once', async () => {
    let opens = 0;
    const p = new DbIpProviderLookup('x.mmdb', log, Date.now, () => {
      opens++;
      return Promise.resolve(fake);
    });
    await Promise.all([p.lookup('58.84.61.202'), p.lookup('173.63.249.136')]);
    await p.lookup('58.84.61.202');
    expect(opens).toBe(1);
  });

  it('without the file: no provider, and tries again after 10 minutes', async () => {
    let t = 0;
    let present = false;
    let opens = 0;
    const p = new DbIpProviderLookup(
      'missing.mmdb',
      log,
      () => t,
      () => {
        opens++;
        return present ? Promise.resolve(fake) : Promise.reject(new Error('ENOENT'));
      },
    );
    expect(await p.lookup('58.84.61.202')).toEqual({ asn: null, provider: null });
    present = true;
    t = RETRY_OPEN_MS - 1;
    expect((await p.lookup('58.84.61.202')).provider).toBeNull();
    expect(opens).toBe(1);
    t = RETRY_OPEN_MS;
    expect((await p.lookup('58.84.61.202')).asn).toBe(134674);
    expect(opens).toBe(2);
  });
});
