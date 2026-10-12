import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PeopleScreen } from './PeopleScreen.js';

const mocks = vi.hoisted(() => ({
  adminPeople: vi.fn(),
  adminPeopleSearch: vi.fn(),
  adminEmployees: vi.fn(),
  adminShifts: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: mocks }));

const day = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', tz_iana: 'Asia/Kolkata' };

beforeEach(() => {
  mocks.adminPeople.mockResolvedValue({
    people: [
      { oid: 'o-priya', name: 'Priya Shah', roles: ['Manager'], has_employee_record: true },
      { oid: 'o-roshni', name: 'Roshni Sahani', roles: ['Employee'], has_employee_record: true },
      { oid: 'o-new', name: 'New Person', roles: ['Employee'], has_employee_record: false },
    ],
  });
  mocks.adminEmployees.mockResolvedValue({
    employees: [
      {
        id: 'e-priya',
        name: 'Priya Shah',
        email: null,
        reporting_manager_id: null,
        oid: 'o-priya',
      },
      {
        id: 'e-roshni',
        name: 'Roshni Sahani',
        email: null,
        reporting_manager_id: 'e-priya',
        oid: 'o-roshni',
      },
    ],
  });
  mocks.adminShifts.mockResolvedValue({
    people: [
      { employee_id: 'e-priya', name: 'Priya Shah', shift: null },
      { employee_id: 'e-roshni', name: 'Roshni Sahani', shift: day },
    ],
  });
});

const rowOf = (name: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('People: manager and shift beside each name (owner request)', () => {
  it('folds the list, then shows who is set up, with the detail on hover', async () => {
    const user = userEvent.setup();
    render(<PeopleScreen canAssignAll onClose={() => undefined} />);
    const header = await screen.findByRole('button', { name: /^With a CloudPunch role/ });
    expect(header).toHaveTextContent('3 people');
    expect(screen.queryByText('Roshni Sahani')).not.toBeInTheDocument();
    await user.click(header);

    const roshni = rowOf('Roshni Sahani');
    expect(within(roshni).getByLabelText('Reports to Priya Shah')).toHaveTextContent('✓ Manager');
    expect(
      within(roshni).getByLabelText('Shift: Mon–Fri · 09:00–18:00 · India (IST)'),
    ).toHaveAttribute('title', 'Shift: Mon–Fri · 09:00–18:00 · India (IST)');

    const priya = rowOf('Priya Shah');
    expect(within(priya).getByLabelText('No manager set')).toHaveTextContent('No manager');
    expect(within(priya).getByLabelText('No shift set')).toHaveTextContent('No shift');

    // No employee record yet: no markers.
    expect(within(rowOf('New Person')).queryByText(/Manager|Shift/)).not.toBeInTheDocument();
  });

  it('leaves the shift marker out when shifts are refused (HR)', async () => {
    mocks.adminShifts.mockRejectedValue('forbidden');
    const user = userEvent.setup();
    render(<PeopleScreen canAssignAll={false} onClose={() => undefined} />);
    await user.click(await screen.findByRole('button', { name: /^With a CloudPunch role/ }));
    const roshni = rowOf('Roshni Sahani');
    expect(within(roshni).getByText('✓ Manager')).toBeInTheDocument();
    expect(within(roshni).queryByText(/Shift/)).not.toBeInTheDocument();
  });
});
