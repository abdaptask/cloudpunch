import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagerNoteView } from './api.js';
import { TeamScreen } from './TeamScreen.js';

const mocks = vi.hoisted(() => ({
  teamNow: vi.fn(),
  teamDay: vi.fn(),
  teamDays: vi.fn(),
  teamExceptions: vi.fn(),
  teamManagerNotes: vi.fn(),
  teamManagerNoteSeen: vi.fn(),
  adminManagerNotes: vi.fn(),
  adminSendManagerNote: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: mocks }));

const NOTE: ManagerNoteView = {
  id: '22222222-2222-4222-8222-222222222222',
  employee_id: 'e-zuhaib',
  name: 'Zuhaib Mir',
  manager_id: 'e-ravi',
  manager_name: 'Ravindra Poojari',
  sent_by: 'Abdulla Sheikh',
  sent_at: '2026-11-11T06:00:00.000Z',
  topics: ['activity', 'timings'],
  message: 'His idle time has been climbing; please check in with him.',
  summary: {
    from: '2026-10-28',
    to: '2026-11-10',
    shift_days: 10,
    on_time: 6,
    late: 3,
    missed: 1,
    worked_days: 9,
    worked_ms: 70 * 3_600_000,
    scheduled_ms: 90 * 3_600_000,
    idle_ms: 7 * 3_600_000,
    breaks_over: 0,
  },
  seen_at: null,
  seen_by: null,
  follow_up_on: '2026-11-25',
  follow_up: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teamNow.mockResolvedValue({ people: [] });
  mocks.teamDays.mockResolvedValue({ name: 'x', days: [] });
  mocks.teamDay.mockResolvedValue({
    date: '2026-11-11',
    sessions: [],
    corrections: [],
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
  });
  mocks.teamManagerNotes.mockResolvedValue({ notes: [NOTE] });
  mocks.teamManagerNoteSeen.mockResolvedValue({
    seen_at: '2026-11-11T09:00:00.000Z',
    changed: true,
  });
});

describe('Tell manager in Team (ADR-0055 §3)', () => {
  it('the manager sees the note at the top, opens the person, and marks it seen', async () => {
    const user = userEvent.setup();
    render(<TeamScreen />);
    const notes = await screen.findByRole('region', { name: 'notes for you' });
    const note = within(notes).getByRole('note', { name: 'note about Zuhaib Mir' });
    expect(note).toHaveTextContent(
      'Abdulla Sheikh asked you to keep an eye on Zuhaib Mir: activity level, start and finish times.',
    );
    expect(note).toHaveTextContent('His idle time has been climbing');
    expect(note).toHaveTextContent(
      'Their 14 days then: On time 6 of 10 shift days · 70h 00m worked of 90h 00m · idle 10% · 1 missed.',
    );
    await user.click(within(note).getByRole('button', { name: 'Open Zuhaib' }));
    expect(screen.getByRole('heading', { name: 'Zuhaib Mir' })).toBeInTheDocument();
    const onPage = screen.getByRole('note', { name: 'note about Zuhaib Mir' });
    await user.click(within(onPage).getByRole('button', { name: "Seen, I'll follow up" }));
    expect(mocks.teamManagerNoteSeen).toHaveBeenCalledWith(NOTE.id);
    expect(
      await within(onPage).findByText(/CloudPunch follows up on Wed 25 Nov/),
    ).toBeInTheDocument();
    // Back on the list, nothing is waiting any more.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('region', { name: 'notes for you' })).toBeNull();
  });

  it('no notes, no banner; a failing call shows nothing', async () => {
    mocks.teamManagerNotes.mockRejectedValue('offline');
    render(<TeamScreen />);
    await screen.findByText(/No one reports to you/);
    expect(screen.queryByRole('region', { name: 'notes for you' })).toBeNull();
  });

  it('HR and Administrators get "Tell their manager" on a person; managers do not', async () => {
    mocks.teamManagerNotes.mockResolvedValue({ notes: [] });
    mocks.teamNow.mockResolvedValue({
      people: [
        {
          employee_id: 'e-zuhaib',
          name: 'Zuhaib Mir',
          status: 'working',
          kind: 'work',
          since: '2026-11-11T04:00:00.000Z',
          worked_ms: 3_600_000,
        },
      ],
    });
    mocks.adminManagerNotes.mockResolvedValue({
      name: 'Zuhaib Mir',
      manager: { id: 'e-ravi', name: 'Ravindra Poojari' },
      blocked: null,
      summary: null,
      follow_up_days: 14,
      notes: [],
    });
    const user = userEvent.setup();
    const { unmount } = render(<TeamScreen />);
    await user.click(await screen.findByRole('button', { name: /Zuhaib Mir/ }));
    expect(screen.queryByRole('button', { name: 'Tell their manager ›' })).toBeNull();
    unmount();

    render(<TeamScreen canTellManager />);
    await user.click(await screen.findByRole('button', { name: /Zuhaib Mir/ }));
    await user.click(screen.getByRole('button', { name: 'Tell their manager ›' }));
    const part = await screen.findByRole('group', { name: 'tell manager about Zuhaib Mir' });
    expect(within(part).getByRole('button', { name: 'Send to Ravindra' })).toBeInTheDocument();
  });
});
