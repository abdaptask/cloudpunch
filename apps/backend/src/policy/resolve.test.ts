import { describe, expect, it } from 'vitest';
import {
  PolicyInvalidError,
  mergePolicy,
  policyIssues,
  policyVersion,
  resolvePolicy,
  schemaDefaults,
} from './resolve.js';

describe('schemaDefaults', () => {
  const d = schemaDefaults() as Record<string, Record<string, unknown>>;

  it('matches the documented defaults (docs/policy/idle-policy-defaults.md)', () => {
    expect(d['idle']?.['threshold_seconds']).toBe(300);
    expect(d['idle']?.['grace_seconds']).toBe(30);
    expect(d['idle']?.['max_silent_call_minutes']).toBe(30);
    expect((d['break'] as Record<string, Record<string, unknown>>)['bio']?.['max_minutes']).toBe(
      10,
    );
    expect(d['away']?.['require_note']).toEqual({
      working_away: true,
      phone_call: false,
      meeting: false,
      other: true,
    });
    expect(d['reminders']?.['on_clock_minutes']).toBe(30);
    expect(d['notifications']?.['quiet_hours_start']).toBe('22:00');
    expect(d['idle']?.['call_type_ignored']).toEqual(['ace dialer.exe']);
  });

  it('is itself a valid policy', () => {
    expect(policyIssues(schemaDefaults())).toEqual([]);
  });

  it('is a fresh copy each time', () => {
    const a = schemaDefaults() as { idle: { prompt_options: string[] } };
    a.idle.prompt_options.pop();
    const b = schemaDefaults() as { idle: { prompt_options: string[] } };
    expect(b.idle.prompt_options).toHaveLength(6);
  });
});

describe('mergePolicy', () => {
  it('merges objects per leaf and replaces arrays and nulls whole', () => {
    const base = {
      idle: { threshold_seconds: 300, grace_seconds: 30, prompt_options: ['a', 'b', 'c'] },
      break: { bio: { max_minutes: 10 }, meal: { max_minutes: 60 } },
    };
    const merged = mergePolicy(base, {
      idle: { threshold_seconds: 600, prompt_options: ['a', 'b'], max_silent_call_minutes: null },
      break: { meal: { max_minutes: 45 } },
    });
    expect(merged).toEqual({
      idle: {
        threshold_seconds: 600,
        grace_seconds: 30,
        prompt_options: ['a', 'b'],
        max_silent_call_minutes: null,
      },
      break: { bio: { max_minutes: 10 }, meal: { max_minutes: 45 } },
    });
    // Inputs are untouched.
    expect(base.idle.threshold_seconds).toBe(300);
  });
});

describe('resolvePolicy', () => {
  it('applies layers least to most specific', () => {
    const p = resolvePolicy([
      { idle: { threshold_seconds: 600, grace_seconds: 60 } },
      { idle: { threshold_seconds: 900 } },
      { idle: { threshold_seconds: 1200 } },
    ]) as { idle: Record<string, unknown> };
    expect(p.idle['threshold_seconds']).toBe(1200);
    expect(p.idle['grace_seconds']).toBe(60);
    expect(p.idle['suppress_prompt_when_media_active']).toBe(true);
  });

  it('rejects an out-of-range or unknown setting instead of falling back', () => {
    expect(() => resolvePolicy([{ idle: { threshold_seconds: 5 } }])).toThrow(PolicyInvalidError);
    expect(() => resolvePolicy([{ idle: { made_up: 1 } }])).toThrow(/unknown setting "made_up"/);
  });

  it('accepts partial overrides and a disabled silent-call cap', () => {
    expect(policyIssues({ idle: { max_silent_call_minutes: null } })).toEqual([]);
    expect(policyIssues({ reminders: { on_clock_minutes: 60 } })).toEqual([]);
  });

  it('validates call-app entries', () => {
    expect(
      policyIssues({ idle: { call_type_apps: [{ process: 'webex.exe', call_type: 'other' }] } }),
    ).toEqual([]);
    expect(
      policyIssues({ idle: { call_type_apps: [{ process: 'x.exe', call_type: 'skype' }] } }),
    ).not.toEqual([]);
    expect(policyIssues({ idle: { call_type_ignored: ['../evil'] } })).not.toEqual([]);
  });
});

describe('policyVersion', () => {
  it('depends only on content, not key order', () => {
    const a = policyVersion({ idle: { threshold_seconds: 300, grace_seconds: 30 } });
    const b = policyVersion({ idle: { grace_seconds: 30, threshold_seconds: 300 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(policyVersion({ idle: { threshold_seconds: 301, grace_seconds: 30 } })).not.toBe(a);
  });
});
