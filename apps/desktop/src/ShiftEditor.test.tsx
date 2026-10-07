import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockInPrompt } from './ClockInPrompt.js';
import { ShiftEditor, daysText, shiftText } from './ShiftEditor.js';
import { statusText } from './teamModel.js';

const mocks = vi.hoisted(() => ({
  adminShifts: vi.fn(),
  adminSetShift: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: mocks }));

beforeEach(() => {
  mocks.adminShifts.mockReset();
  mocks.adminSetShift.mockReset();
});

describe('shift words', () => {
  it('names the days and the hours', () => {
    expect(daysText([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(daysText([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(daysText([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
    expect(
      shiftText({ days: [1, 2, 3, 4, 5], start: '17:30', end: '02:30', tz_iana: 'Asia/Kolkata' }),
    ).toBe('Mon–Fri · 17:30–02:30 (next day) · India (IST)');
    expect(shiftText(null)).toBe('No shift');
  });
});

describe('ShiftEditor', () => {
  it('sets a shift for someone and shows it', async () => {
    mocks.adminShifts.mockResolvedValue({
      people: [{ employee_id: 'e1', name: 'Roshni Sahani', shift: null }],
    });
    mocks.adminSetShift.mockResolvedValue({
      shift: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:30', tz_iana: 'America/New_York' },
    });
    const user = userEvent.setup();
    render(<ShiftEditor />);
    expect(await screen.findByLabelText('shift of Roshni Sahani')).toHaveTextContent('No shift');
    await user.click(screen.getByRole('button', { name: 'Set shift' }));
    await user.type(screen.getByLabelText('shift-start'), '08:00');
    await user.type(screen.getByLabelText('shift-end'), '17:30');
    await user.selectOptions(screen.getByLabelText('shift-zone'), 'America/New_York');
    await user.click(screen.getByRole('button', { name: 'Save shift' }));
    expect(mocks.adminSetShift).toHaveBeenCalledWith('e1', {
      days: [1, 2, 3, 4, 5],
      start: '08:00',
      end: '17:30',
      tzIana: 'America/New_York',
    });
    expect(await screen.findByLabelText('shift of Roshni Sahani')).toHaveTextContent(
      'Mon–Fri · 08:00–17:30 · US Eastern',
    );
  });
});

describe('Copy to…', () => {
  const night = { days: [1, 2, 3, 4, 5], start: '17:30', end: '02:30', tz_iana: 'Asia/Kolkata' };
  const people = [
    { employee_id: 'e1', name: 'Roshni Sahani', shift: night },
    { employee_id: 'e2', name: 'Farheen Khan', shift: null },
    { employee_id: 'e3', name: 'Nilesh Patil', shift: null },
  ];

  it('gives one person’s shift to everyone ticked', async () => {
    mocks.adminShifts.mockResolvedValue({ people });
    mocks.adminSetShift.mockResolvedValue({ shift: night });
    const user = userEvent.setup();
    render(<ShiftEditor />);
    await user.click(await screen.findByRole('button', { name: 'Copy to…' }));
    await user.click(screen.getByLabelText('copy to Farheen Khan'));
    await user.click(screen.getByLabelText('copy to Nilesh Patil'));
    await user.click(screen.getByRole('button', { name: 'Copy to 2 people' }));
    const body = { days: [1, 2, 3, 4, 5], start: '17:30', end: '02:30', tzIana: 'Asia/Kolkata' };
    expect(mocks.adminSetShift).toHaveBeenCalledWith('e2', body);
    expect(mocks.adminSetShift).toHaveBeenCalledWith('e3', body);
    expect(await screen.findByLabelText('shift of Nilesh Patil')).toHaveTextContent(
      'Mon–Fri · 17:30–02:30 (next day) · India (IST)',
    );
    expect(screen.queryByLabelText('copy shift of Roshni Sahani')).not.toBeInTheDocument();
  });

  it('keeps anyone it could not copy to ticked, and says who', async () => {
    mocks.adminShifts.mockResolvedValue({ people });
    mocks.adminSetShift.mockImplementation((id: string) =>
      id === 'e3' ? Promise.reject(new Error('offline')) : Promise.resolve({ shift: night }),
    );
    const user = userEvent.setup();
    render(<ShiftEditor />);
    await user.click(await screen.findByRole('button', { name: 'Copy to…' }));
    await user.click(screen.getByLabelText('Everyone'));
    await user.click(screen.getByRole('button', { name: 'Copy to 2 people' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Not copied to Nilesh Patil/);
    expect(screen.getByLabelText('copy to Nilesh Patil')).toBeChecked();
    expect(screen.getByLabelText('copy to Farheen Khan')).not.toBeChecked();
    expect(screen.getByLabelText('shift of Farheen Khan')).toHaveTextContent('Mon–Fri');
  });
});

describe('the clock-in popup with a shift', () => {
  it('offers "Not working today" only when given', async () => {
    const onNotWorking = vi.fn();
    const user = userEvent.setup();
    const props = {
      signedInAt: null,
      onClockInFrom: () => undefined,
      onClockInNow: () => undefined,
      onNotNow: () => undefined,
    };
    const { rerender } = render(<ClockInPrompt {...props} />);
    expect(screen.queryByRole('button', { name: 'Not working today' })).not.toBeInTheDocument();
    rerender(<ClockInPrompt {...props} onNotWorking={onNotWorking} />);
    await user.click(screen.getByRole('button', { name: 'Not working today' }));
    expect(onNotWorking).toHaveBeenCalledOnce();
  });
});

describe('Team statuses for shifts', () => {
  const p = {
    employee_id: 'e',
    name: 'R',
    kind: null,
    back_by: null,
    worked_ms: 0,
  };
  it('says who hasn’t started their shift, and who said they aren’t working', () => {
    expect(
      statusText({ ...p, status: 'shift_not_started', since: '2026-10-07T12:00:00.000Z' }),
    ).toMatch(/^Not clocked in · shift started /);
    expect(statusText({ ...p, status: 'not_working', since: null })).toBe('Said not working today');
  });
});
