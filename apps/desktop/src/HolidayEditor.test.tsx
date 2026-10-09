import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HolidayEditor, holidayDateText } from './HolidayEditor.js';
import { startsText, statusText } from './teamModel.js';

const mocks = vi.hoisted(() => ({
  holidays: vi.fn(),
  setHoliday: vi.fn(),
  removeHoliday: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: mocks }));

beforeEach(() => {
  mocks.holidays.mockReset();
  mocks.setHoliday.mockReset();
  mocks.removeHoliday.mockReset();
});

describe('holiday words', () => {
  it('shows the day of the date itself, in any zone', () => {
    expect(holidayDateText('2026-11-09')).toBe('Mon, 9 Nov 2026');
  });

  it('Team says whose shift is a holiday', () => {
    const p = {
      employee_id: 'e1',
      name: 'Roshni Sahani',
      status: 'holiday' as const,
      kind: null,
      since: null,
      back_by: null,
      worked_ms: 0,
      holiday: 'Diwali',
    };
    expect(statusText(p)).toBe('Holiday: Diwali');
  });

  it('Team says how often someone missed the start (ADR-0037 §4)', () => {
    const p = {
      employee_id: 'e1',
      name: 'Roshni Sahani',
      status: 'clocked_out' as const,
      kind: null,
      since: null,
      back_by: null,
      worked_ms: 0,
    };
    expect(startsText(p)).toBeNull();
    expect(
      startsText({ ...p, starts: { missed: 4, not_working: 1, days: 30, regular: true } }),
    ).toBe('Missed starts: 4 in 30 days · Not working today: 1');
    expect(
      startsText({ ...p, starts: { missed: 1, not_working: 0, days: 30, regular: false } }),
    ).toBe('Missed starts: 1 in 30 days');
  });
});

describe('HolidayEditor', () => {
  it('lists, adds in date order, and removes holidays', async () => {
    mocks.holidays.mockResolvedValue({ holidays: [{ date: '2026-12-25', name: 'Christmas' }] });
    mocks.setHoliday.mockResolvedValue({ date: '2026-11-09', name: 'Diwali' });
    mocks.removeHoliday.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<HolidayEditor />);
    expect(await screen.findByText('Christmas')).toBeTruthy();

    const add = screen.getByRole('button', { name: 'Add holiday' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('holiday date'), '2026-11-09');
    await user.type(screen.getByLabelText('holiday name'), ' Diwali ');
    await user.click(add);
    expect(mocks.setHoliday).toHaveBeenCalledWith('2026-11-09', 'Diwali');
    const names = (await screen.findAllByRole('listitem')).map((li) => li.textContent);
    expect(names[0]).toContain('Diwali');
    expect(names[1]).toContain('Christmas');

    await user.click(screen.getByRole('button', { name: 'remove Christmas' }));
    expect(mocks.removeHoliday).toHaveBeenCalledWith('2026-12-25');
    expect(screen.queryByText('Christmas')).toBeNull();
  });

  it('says why a change was refused', async () => {
    mocks.holidays.mockResolvedValue({ holidays: [] });
    mocks.setHoliday.mockRejectedValue('forbidden');
    const user = userEvent.setup();
    render(<HolidayEditor />);
    expect(await screen.findByText('No holidays coming up.')).toBeTruthy();
    await user.type(screen.getByLabelText('holiday date'), '2026-11-09');
    await user.type(screen.getByLabelText('holiday name'), 'Diwali');
    await user.click(screen.getByRole('button', { name: 'Add holiday' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only HR or an Administrator can change holidays.',
    );
  });
});
