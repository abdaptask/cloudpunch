import { describe, expect, it } from 'vitest';
import { osOf, placeOf, providerOf, seenOf } from './connectionsModel.js';

describe('connections on screen (ADR-0029)', () => {
  it('names the place, leaving out India and the unknown codes', () => {
    expect(placeOf({ city: 'Pune', region: 'Maharashtra', country: 'IN' })).toBe(
      'Pune, Maharashtra',
    );
    expect(placeOf({ city: 'Newark', region: 'New Jersey', country: 'US' })).toBe(
      'Newark, New Jersey (US)',
    );
    expect(placeOf({ city: null, region: null, country: 'IN' })).toBe('IN');
    expect(placeOf({ city: null, region: null, country: 'XX' })).toBe('Location unknown');
    expect(placeOf({ city: null, region: null, country: null })).toBe('Location unknown');
  });

  it('shortens company suffixes in provider names', () => {
    expect(providerOf({ provider: 'Tata Play Broadband Private Limited' })).toBe(
      'Tata Play Broadband',
    );
    expect(providerOf({ provider: 'Teleglobal Communications Pvt Ltd' })).toBe(
      'Teleglobal Communications',
    );
    expect(providerOf({ provider: 'Verizon Business' })).toBe('Verizon Business');
    expect(providerOf({ provider: null })).toBe('Provider unknown');
  });

  it('names the computer', () => {
    expect(osOf({ device_os: 'windows' })).toBe('Windows');
    expect(osOf({ device_os: 'macos' })).toBe('Mac');
    expect(osOf({ device_os: null })).toBeNull();
  });

  it('says when it was seen', () => {
    const now = new Date(2026, 9, 1, 18, 0).getTime();
    const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();
    expect(seenOf({ first_seen_at: at(1, 9, 14), last_seen_at: at(1, 17, 40) }, now)).toBe(
      'Today 09:14–17:40',
    );
    expect(seenOf({ first_seen_at: at(1, 9, 14), last_seen_at: at(1, 9, 14) }, now)).toBe(
      'Today 09:14',
    );
    expect(seenOf({ first_seen_at: at(0, 21, 5), last_seen_at: at(1, 1, 10) }, now)).toBe(
      'Yesterday 21:05 – Today 01:10',
    );
  });
});
