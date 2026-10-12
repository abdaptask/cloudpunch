import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShiftsPage } from './ShiftsPage.js';

const mocks = vi.hoisted(() => ({
  adminShiftTemplates: vi.fn(),
  adminCreateShiftTemplate: vi.fn(),
  adminSaveShiftTemplate: vi.fn(),
  adminRetireShiftTemplate: vi.fn(),
  adminShifts: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: mocks }));

const INDIA = {
  id: 't-india',
  name: 'India day',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  tz_iana: 'Asia/Kolkata',
  effective_from: '2026-10-01',
  retired: false,
  next: null,
  people: 14,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminShiftTemplates.mockResolvedValue({ templates: [INDIA], custom: 3, none: 2 });
  mocks.adminShifts.mockResolvedValue({ people: [] });
});

describe('Shifts page (ADR-0038 §6)', () => {
  it('lists named shifts with who is on them, and the custom count', async () => {
    render(<ShiftsPage />);
    const india = await screen.findByRole('listitem', { name: 'named shift India day' });
    expect(india).toHaveTextContent('Mon–Fri · 09:00–18:00');
    expect(within(india).getByLabelText('people on India day')).toHaveTextContent('14 people');
    expect(screen.getByLabelText('shift-counts')).toHaveTextContent(
      '3 people on a custom shift · 2 people with no shift',
    );
  });

  it('makes a named shift', async () => {
    mocks.adminCreateShiftTemplate.mockResolvedValue({ ...INDIA, id: 't-us', name: 'US Eastern' });
    const user = userEvent.setup();
    render(<ShiftsPage />);
    await user.click(await screen.findByRole('button', { name: 'New named shift' }));
    const form = screen.getByRole('group', { name: 'new named shift' });
    await user.type(within(form).getByLabelText('shift-name'), 'US Eastern');
    await user.selectOptions(within(form).getByLabelText('shift-zone'), 'America/New_York');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(mocks.adminCreateShiftTemplate).toHaveBeenCalledWith(
      {
        name: 'US Eastern',
        days: [1, 2, 3, 4, 5],
        start: '09:00',
        end: '18:00',
        tzIana: 'America/New_York',
      },
      '',
    );
    expect(await screen.findByRole('status')).toHaveTextContent('US Eastern is set up.');
    expect(mocks.adminShiftTemplates).toHaveBeenCalledTimes(2);
  });

  it('editing shows how many it changes, from the date, before Apply', async () => {
    mocks.adminSaveShiftTemplate.mockResolvedValue({ people: 14, effective_from: '2099-10-19' });
    const user = userEvent.setup();
    render(<ShiftsPage />);
    const india = await screen.findByRole('listitem', { name: 'named shift India day' });
    await user.click(within(india).getByRole('button', { name: 'Edit' }));
    const form = within(india).getByRole('group', { name: 'edit India day' });
    await user.clear(within(form).getByLabelText('shift-start'));
    await user.type(within(form).getByLabelText('shift-start'), '08:00');
    const from = within(form).getByLabelText('shift-from');
    await user.clear(from);
    await user.type(from, '2099-10-19');
    await user.click(within(form).getByRole('button', { name: 'Check' }));
    const pattern = {
      name: 'India day',
      days: [1, 2, 3, 4, 5],
      start: '08:00',
      end: '18:00',
      tzIana: 'Asia/Kolkata',
    };
    expect(mocks.adminSaveShiftTemplate).toHaveBeenLastCalledWith(
      't-india',
      pattern,
      '2099-10-19',
      '',
      true,
    );
    expect(await within(form).findByLabelText('shift-preview')).toHaveTextContent(
      'This changes the shift of 14 people from 19 Oct.',
    );
    await user.click(within(form).getByRole('button', { name: 'Apply' }));
    expect(mocks.adminSaveShiftTemplate).toHaveBeenLastCalledWith(
      't-india',
      pattern,
      '2099-10-19',
      '',
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'India day saved. 14 people get the new shift from 19 Oct.',
    );
  });

  it('retiring asks first and says people keep it', async () => {
    mocks.adminRetireShiftTemplate.mockResolvedValue({ id: 't-india', retired: true });
    const user = userEvent.setup();
    render(<ShiftsPage />);
    const india = await screen.findByRole('listitem', { name: 'named shift India day' });
    await user.click(within(india).getByRole('button', { name: 'Retire' }));
    const ask = within(india).getByRole('group', { name: 'retire India day' });
    expect(ask).toHaveTextContent('14 people keep it');
    await user.click(within(ask).getByRole('button', { name: 'Retire' }));
    expect(mocks.adminRetireShiftTemplate).toHaveBeenCalledWith('t-india', '');
    expect(await screen.findByRole('status')).toHaveTextContent('India day is retired.');
  });
});
