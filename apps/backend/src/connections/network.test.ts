import { describe, expect, it } from 'vitest';
import { connectionFromRequest, hasLocationHeaders, networkKey } from './network.js';

describe('networkKey', () => {
  it('compares IPv4 exactly', () => {
    expect(networkKey('202.71.156.179')).toBe('202.71.156.179');
    expect(networkKey('202.71.156.180')).not.toBe(networkKey('202.71.156.179'));
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 one', () => {
    expect(networkKey('::ffff:58.84.61.202')).toBe('58.84.61.202');
  });

  it('groups IPv6 by /64, ignoring case, leading zeros and :: shortening', () => {
    const a = networkKey('2402:e280:3e8f:1d7:4db:8a24:7d9e:5c4');
    expect(a).toBe('2402:e280:3e8f:1d7::/64');
    expect(networkKey('2402:E280:3E8F:01D7::1')).toBe(a);
    expect(networkKey('2402:e280:3e8f:1d8::1')).not.toBe(a);
    expect(networkKey('2600:4040::1')).toBe('2600:4040:0:0::/64');
  });
});

describe('connectionFromRequest', () => {
  const cf = {
    'cf-ray': '8c1a2b3c4d5e6f70-BOM',
    'cf-ipcity': 'Mumbai',
    'cf-region': 'Maharashtra',
    'cf-ipcountry': 'in',
  };

  it('reads the place from Cloudflare headers', () => {
    expect(connectionFromRequest({ ip: '58.84.61.202', headers: cf })).toEqual({
      ip: '58.84.61.202',
      city: 'Mumbai',
      region: 'Maharashtra',
      country: 'IN',
    });
    expect(hasLocationHeaders({ ip: '', headers: cf })).toBe(true);
  });

  it('ignores location headers that did not come through Cloudflare (the office path)', () => {
    const forged = { ...cf, 'cf-ray': undefined };
    expect(connectionFromRequest({ ip: '172.16.1.5', headers: forged })).toEqual({
      ip: '172.16.1.5',
      city: null,
      region: null,
      country: null,
    });
  });

  it('re-decodes UTF-8 city names and drops control characters', () => {
    const latin1 = Buffer.from('Thāne', 'utf8').toString('latin1');
    const seen = connectionFromRequest({
      ip: '1.2.3.4',
      headers: { 'cf-ray': 'x', 'cf-ipcity': `${latin1}\u0007`, 'cf-ipcountry': 'not-a-code' },
    });
    expect(seen.city).toBe('Thāne');
    expect(seen.country).toBeNull();
  });

  it('caps the length', () => {
    const seen = connectionFromRequest({
      ip: '1.2.3.4',
      headers: { 'cf-ray': 'x', 'cf-region': 'x'.repeat(500) },
    });
    expect(seen.region).toHaveLength(100);
  });
});
