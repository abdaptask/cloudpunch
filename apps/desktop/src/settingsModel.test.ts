import { describe, expect, it } from 'vitest';
import { formFrom, formIssues, overrideWith } from './settingsModel.js';

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
      clockInPromptAt: null,
      clockInPromptTz: 'Asia/Kolkata',
      longDayHours: 9,
      longShiftHours: 10,
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
    expect(overrideWith(current, formFrom(policy))).toEqual({
      away: { x: 1 },
      idle: {
        prompt_options: ['still_working', 'end_shift'],
        threshold_seconds: 180,
        grace_seconds: 45,
        max_idle_minutes: null,
      },
      reminders: {
        clock_in_prompt_at: null,
        clock_in_prompt_tz: 'Asia/Kolkata',
        long_day_hours: 9,
        long_shift_hours: 10,
      },
    });
  });
});
