import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamDay } from './api.js';
import { dayRows } from './teamModel.js';
import { EarlierDay } from './TeamScreen.js';

const mocks = vi.hoisted(() => ({
  teamDay: vi.fn(),
  requestCorrection: vi.fn(),
  personConnections: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: mocks }));

const seg = (kind: string, from: string, to: string, over: object = {}) => ({
  kind,
  started_at: `2026-10-12T${from}:00.000+05:30`,
  ended_at: `2026-10-12T${to}:00.000+05:30`,
  ...over,
});

const DAY: TeamDay = {
  date: '2026-10-12',
  sessions: [
    {
      session_id: 's1',
      device_id: 'd1',
      tz_iana: 'Asia/Kolkata',
      clock_in: '2026-10-12T09:00:00.000+05:30',
      clock_out: '2026-10-12T13:00:00.000+05:30',
      close_reason: 'user_clock_out',
      reconstructed: false,
      open: false,
      started_from_sign_in: false,
      segments: [
        seg('working', '09:00', '10:00'),
        seg('idle', '10:00', '10:40', {
          explanation: { explanation: 'meeting', note: 'standup' },
        }),
        seg('working', '10:40', '11:00'),
        seg('idle', '11:00', '11:20', { explanation: { explanation: 'idle', note: null } }),
        seg('idle', '11:20', '11:30'),
        seg('working', '11:30', '13:00'),
      ],
    },
  ],
  totals: {
    worked_ms: 0,
    calls_ms: 0,
    meetings_ms: 0,
    breaks_ms: 0,
    paid_break_ms: 0,
    unpaid_break_ms: 0,
    prompt_ms: 0,
    idle_ms: 0,
  },
  corrections: [],
} as unknown as TeamDay;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teamDay.mockResolvedValue(DAY);
});

describe('Accept explanation (ADR-0030 §4)', () => {
  it('only idle a person explained as work can be accepted, for exactly that stretch', () => {
    const rows = dayRows(DAY);
    expect(rows.map((r) => !!r.accept)).toEqual([false, true, false, false, false, false]);
    expect(rows[1]?.accept).toEqual({
      from: '2026-10-12T10:00:00.000+05:30',
      to: '2026-10-12T10:40:00.000+05:30',
      tzIana: 'Asia/Kolkata',
      reason: 'Accepted idle explanation: In a meeting (“standup”)',
    });
  });

  it('a manager sends it as a correction to worked time; a refusal is said in words', async () => {
    mocks.requestCorrection
      .mockRejectedValueOnce('overlaps_pending')
      .mockResolvedValueOnce({ correction: {} });
    const user = userEvent.setup();
    render(<EarlierDay id="e-roshni" date="2026-10-12" canCorrect />);
    const button = await screen.findByRole('button', { name: 'Accept explanation' });
    await user.click(button);
    expect(mocks.requestCorrection).toHaveBeenCalledWith({
      employeeId: 'e-roshni',
      kind: 'working',
      from: '2026-10-12T10:00:00.000+05:30',
      to: '2026-10-12T10:40:00.000+05:30',
      tzIana: 'Asia/Kolkata',
      reason: 'Accepted idle explanation: In a meeting (“standup”)',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Part of this time already has a correction waiting.',
    );
    await user.click(screen.getByRole('button', { name: 'Accept explanation' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'that idle time counts as worked once an Administrator approves it',
    );
    // The day reloads to show the correction waiting.
    expect(mocks.teamDay).toHaveBeenCalledTimes(2);
  });

  it('without the right to correct, no button', async () => {
    render(<EarlierDay id="e-roshni" date="2026-10-12" canCorrect={false} />);
    await screen.findByText(/Said: In a meeting/);
    expect(screen.queryByRole('button', { name: 'Accept explanation' })).toBeNull();
  });
});
