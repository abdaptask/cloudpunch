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
  adminBulkShift: vi.fn(),
  adminSetNamedShift: vi.fn(),
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

describe('giving a named shift to people (owner report, 2026-10-13)', () => {
  const DAY = { days: [1, 2, 3, 4, 5], start: '10:00', end: '19:00', tz_iana: 'Asia/Kolkata' };
  beforeEach(() => {
    mocks.adminShifts.mockResolvedValue({
      people: [
        { employee_id: 'e-masrat', name: 'Masrat Afzal', shift: null },
        { employee_id: 'e-amit', name: 'Amit Bisht', shift: null },
        { employee_id: 'e-roshni', name: 'Roshni Sahani', shift: DAY },
        {
          employee_id: 'e-nilesh',
          name: 'Nilesh Darekar',
          shift: DAY,
          template: { id: 't-india', name: 'India day' },
        },
      ],
    });
    mocks.adminBulkShift.mockResolvedValue({
      template_id: 't-india',
      effective_from: '2099-10-13',
      changed: ['e-amit', 'e-masrat'],
      unchanged: [],
    });
  });

  it('Give to people… offers those without a shift, then puts them on it', async () => {
    const user = userEvent.setup();
    render(<ShiftsPage />);
    const india = await screen.findByRole('listitem', { name: 'named shift India day' });
    await user.click(within(india).getByRole('button', { name: 'Give to people…' }));
    const give = within(india).getByRole('group', { name: 'give India day' });
    const list = await within(give).findByRole('list', { name: 'give-people' });
    expect(
      within(list)
        .getAllByRole('checkbox')
        .map((c) => c.getAttribute('aria-label')),
    ).toEqual(['give to Amit Bisht', 'give to Masrat Afzal']);
    // Roshni has a custom shift: offered on request; Nilesh is already on it.
    await user.click(
      within(give).getByRole('button', { name: 'Also show the 1 on another shift' }),
    );
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
    await user.click(within(give).getByRole('button', { name: 'Only people without a shift' }));
    await user.click(within(give).getByRole('button', { name: 'All 2 listed' }));
    await user.click(within(give).getByRole('button', { name: 'Put 2 people on India day' }));
    expect(mocks.adminBulkShift).toHaveBeenCalledWith(
      expect.any(String),
      ['e-amit', 'e-masrat'],
      { templateId: 't-india' },
      null,
      '',
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      '2 people are on India day from today.',
    );
  });

  it("each person's shift offers the named shifts, and Custom can go back", async () => {
    mocks.adminSetNamedShift.mockResolvedValue({
      shift: DAY,
      template_id: 't-india',
      effective_from: '2099-10-13',
    });
    const user = userEvent.setup();
    render(<ShiftsPage />);
    await user.click(await screen.findByRole('button', { name: /^Each person's shift/ }));
    const roshni = await screen.findByText('Roshni Sahani');
    await user.click(within(roshni.closest('li')!).getByRole('button', { name: 'Edit' }));
    const select = screen.getByLabelText('shift for Roshni Sahani');
    await user.selectOptions(select, 'Custom pattern…');
    expect(screen.getByLabelText('shift editor Roshni Sahani')).toBeInTheDocument();
    // Still there: back to a named shift in one click.
    await user.selectOptions(screen.getByLabelText('shift for Roshni Sahani'), 'India day');
    expect(screen.queryByLabelText('shift editor Roshni Sahani')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save shift' }));
    expect(mocks.adminSetNamedShift).toHaveBeenCalledWith('e-roshni', 't-india', null);
  });
});
