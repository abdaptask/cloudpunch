import { describe, expect, it } from 'vitest';
import {
  BREAK_DEFAULTS,
  breakIssues,
  formFrom,
  formIssues,
  overrideWith,
} from './settingsModel.js';

describe('settings form (ADR-0018 §5)', () => {
  const policy = {
    idle: { threshold_seconds: 180, grace_seconds: 45, max_idle_minutes: null },
    reminders: {
      clock_in_prompt_at: null,
      clock_in_prompt_tz: 'Asia/Kolkata',
      long_day_hours: 9,
      long_shift_hours: 10,
    },
  };

  it('reads a resolved policy in plain units, including off switches', () => {
    expect(formFrom(policy)).toEqual({
      idlePromptMinutes: 3,
      promptWaitSeconds: 45,
      idleCapMinutes: null,
      presenceCheck: false,
      clockInPromptAt: null,
      clockInPromptTz: 'Asia/Kolkata',
      longDayHours: 9,
      longShiftHours: 10,
      breaks: BREAK_DEFAULTS,
      offerTraining: true,
    });
    // Missing values fall back to the schema defaults.
    expect(formFrom({})).toMatchObject({
      idlePromptMinutes: 2,
      idleCapMinutes: 120,
      clockInPromptAt: '08:00',
    });
  });

  it('checks the schema ranges', () => {
    const ok = formFrom(policy);
    expect(formIssues(ok)).toEqual({});
    expect(
      Object.keys(
        formIssues({
          ...ok,
          idlePromptMinutes: 0,
          promptWaitSeconds: 5,
          idleCapMinutes: 10,
          clockInPromptAt: '8am',
          longDayHours: 3,
          longShiftHours: Number.NaN,
        }),
      ).sort(),
    ).toEqual([
      'clockInPromptAt',
      'idleCapMinutes',
      'idlePromptMinutes',
      'longDayHours',
      'longShiftHours',
      'promptWaitSeconds',
    ]);
  });

  it('writes the form into the override and keeps everything else', () => {
    const current = { idle: { prompt_options: ['still_working', 'end_shift'] }, away: { x: 1 } };
    const written = overrideWith(current, formFrom(policy));
    expect(written['break']).toMatchObject({
      rest: { enabled: true, label: 'Tea break', pay: 'paid_up_to_limit', max_minutes: 15 },
      other: { enabled: false, max_minutes: null },
    });
    expect({ ...written, break: undefined }).toEqual({
      break: undefined,
      away: { x: 1, offer_training: true },
      idle: {
        prompt_options: ['still_working', 'end_shift'],
        threshold_seconds: 180,
        grace_seconds: 45,
        max_idle_minutes: null,
        input_pattern_check: { enabled: false },
      },
      reminders: {
        clock_in_prompt_at: null,
        clock_in_prompt_tz: 'Asia/Kolkata',
        long_day_hours: 9,
        long_shift_hours: 10,
      },
    });
  });

  describe('breaks (ADR-0023 §5)', () => {
    const resolved = {
      break: {
        bio: { enabled: true, label: 'Bio break', pay: 'paid_up_to_limit', max_minutes: 10 },
        meal: {
          enabled: false,
          label: 'Lunch',
          pay: 'unpaid',
          max_minutes: 45,
          min_minutes_before_prompt: 240,
        },
        rest: { enabled: true, label: 'Chai break', pay: 'paid', max_minutes: 20 },
        personal: { enabled: true, label: 'Personal', pay: 'unpaid', max_minutes: 30 },
        other: { enabled: true, label: 'Other break', pay: 'unpaid', max_minutes: null },
      },
      away: { offer_training: false },
    };

    it('reads each type and Training', () => {
      const f = formFrom(resolved);
      expect(f.breaks.map((b) => [b.id, b.enabled, b.label, b.pay, b.maxMinutes])).toEqual([
        ['bio', true, 'Bio break', 'paid_up_to_limit', 10],
        ['meal', false, 'Lunch', 'unpaid', 45],
        ['rest', true, 'Chai break', 'paid', 20],
        ['personal', true, 'Personal', 'unpaid', 30],
        ['other', true, 'Other break', 'unpaid', null],
      ]);
      expect(f.offerTraining).toBe(false);
    });

    it('checks names, limits, and that one type stays on', () => {
      const f = formFrom(resolved);
      expect(formIssues(f)).toEqual({});
      const edit = (id: string, patch: object) => ({
        ...f,
        breaks: f.breaks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      });
      expect(breakIssues(edit('rest', { label: '   ' }))).toEqual({
        rest: 'A name of 1 to 30 characters',
      });
      expect(breakIssues(edit('rest', { label: 'x'.repeat(31) }))['rest']).toBeDefined();
      expect(breakIssues(edit('bio', { maxMinutes: 4 }))['bio']).toMatch(/5 and 180/);
      expect(breakIssues(edit('bio', { maxMinutes: null }))['bio']).toMatch(/5 and 180/);
      expect(breakIssues(edit('other', { maxMinutes: null }))).toEqual({});
      expect(formIssues(edit('bio', { maxMinutes: 181 })).breaks).toMatch(/marked below/);
      const allOff = { ...f, breaks: f.breaks.map((b) => ({ ...b, enabled: false })) };
      expect(formIssues(allOff).breaks).toBe('Keep at least one break type on');
    });

    it('writes the breaks and keeps other settings in each entry', () => {
      const f = formFrom(resolved);
      const doc = overrideWith(
        {
          break: { meal: { min_minutes_before_prompt: 240 } },
          away: { require_note: { meeting: true } },
        },
        { ...f, breaks: f.breaks.map((b) => (b.id === 'rest' ? { ...b, label: '  Tea  ' } : b)) },
      );
      expect((doc['break'] as Record<string, unknown>)['meal']).toEqual({
        min_minutes_before_prompt: 240,
        enabled: false,
        label: 'Lunch',
        pay: 'unpaid',
        max_minutes: 45,
      });
      expect((doc['break'] as Record<string, Record<string, unknown>>)['rest']?.['label']).toBe(
        'Tea',
      );
      expect(doc['away']).toEqual({ require_note: { meeting: true }, offer_training: false });
    });
  });
});
