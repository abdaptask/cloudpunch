import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PeopleTable } from './PeopleTable.js';

const mocks = vi.hoisted(() => ({
  adminPeople: vi.fn(),
  adminPeopleSearch: vi.fn(),
  adminPeopleSetRoles: vi.fn(),
  adminEmployees: vi.fn(),
  adminSetManager: vi.fn(),
  adminShifts: vi.fn(),
  adminSetShift: vi.fn(),
  adminActiveDevice: vi.fn(),
  adminWelcomePreview: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: mocks }));

const DAY = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', tz_iana: 'Asia/Kolkata' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminPeople.mockResolvedValue({
    people: [
      { oid: 'o-priya', name: 'Priya Shah', roles: ['Manager'], has_employee_record: true },
      { oid: 'o-hr', name: 'Hema R', roles: ['HR'], has_employee_record: true },
      { oid: 'o-roshni', name: 'Roshni Sahani', roles: ['Employee'], has_employee_record: true },
    ],
  });
  mocks.adminEmployees.mockResolvedValue({
    employees: [
      {
        id: 'e-priya',
        name: 'Priya Shah',
        email: 'priya@aptask.com',
        reporting_manager_id: null,
        oid: 'o-priya',
      },
      { id: 'e-hr', name: 'Hema R', email: null, reporting_manager_id: 'e-priya', oid: 'o-hr' },
      {
        id: 'e-roshni',
        name: 'Roshni Sahani',
        email: 'roshni@aptask.com',
        reporting_manager_id: null,
        oid: 'o-roshni',
      },
    ],
  });
  mocks.adminShifts.mockResolvedValue({
    people: [
      { employee_id: 'e-priya', name: 'Priya Shah', shift: DAY },
      { employee_id: 'e-hr', name: 'Hema R', shift: DAY },
      { employee_id: 'e-roshni', name: 'Roshni Sahani', shift: null },
    ],
  });
  mocks.adminSetManager.mockResolvedValue({ id: 'e-roshni', reporting_manager_id: 'e-priya' });
  mocks.adminActiveDevice.mockResolvedValue(null);
  mocks.adminWelcomePreview.mockResolvedValue({
    from: 'cloudpunch@aptask.com',
    to: 'new@aptask.com',
    cc: [],
    subject: 'Welcome',
  });
});

const bodyRows = (): string[] =>
  within(screen.getByRole('table', { name: 'people-table' }))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('button')[0]?.textContent ?? '');

describe('People table (ADR-0038 §3)', () => {
  it('lists everyone with roles, manager, shift and status', async () => {
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    await screen.findByRole('table', { name: 'people-table' });
    expect(bodyRows()).toEqual(['Hema R', 'Priya Shah', 'Roshni Sahani']);
    const roshni = screen.getByRole('button', { name: 'Roshni Sahani' }).closest('tr')!;
    expect(roshni).toHaveTextContent('roshni@aptask.com');
    expect(roshni).toHaveTextContent('Employee');
    expect(within(roshni).getByText('No manager')).toBeInTheDocument();
    expect(within(roshni).getByText('No shift')).toBeInTheDocument();
    expect(screen.getByLabelText('people-pages')).toHaveTextContent('1–3 of 3');
  });

  it('needs-attention counts filter the table', async () => {
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    const attention = await screen.findByRole('group', { name: 'needs-attention' });
    const noManager = within(attention).getByRole('button', { name: '2 without a manager' });
    await user.click(noManager);
    expect(noManager).toHaveAttribute('aria-pressed', 'true');
    expect(bodyRows()).toEqual(['Priya Shah', 'Roshni Sahani']);
    await user.click(within(attention).getByRole('button', { name: '1 without a shift' }));
    expect(bodyRows()).toEqual(['Roshni Sahani']);
    expect(screen.getByLabelText('people-pages')).toHaveTextContent('1–1 of 1 (3 in all)');
  });

  it('search, role filter and sorting', async () => {
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    await screen.findByRole('table', { name: 'people-table' });
    await user.selectOptions(screen.getByLabelText('filter-role'), 'Manager');
    expect(bodyRows()).toEqual(['Priya Shah']);
    await user.selectOptions(screen.getByLabelText('filter-role'), '');
    await user.type(screen.getByLabelText('people-find'), 'aptask');
    expect(bodyRows()).toEqual(['Priya Shah', 'Roshni Sahani']);
    await user.clear(screen.getByLabelText('people-find'));
    await user.click(screen.getByRole('button', { name: /^Name/ }));
    expect(bodyRows()).toEqual(['Roshni Sahani', 'Priya Shah', 'Hema R']);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('a row opens the panel; a manager is picked by typing', async () => {
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    await user.click(await screen.findByRole('button', { name: 'Roshni Sahani' }));
    const panel = screen.getByRole('complementary', { name: 'person Roshni Sahani' });
    expect(within(panel).getByRole('checkbox', { name: 'role-Employee' })).toBeChecked();
    expect(within(panel).getByLabelText('shift of Roshni Sahani')).toHaveTextContent('No shift');

    await user.click(
      within(panel).getByRole('button', { name: 'change manager of Roshni Sahani' }),
    );
    await user.type(within(panel).getByLabelText('find a manager for Roshni Sahani'), 'h');
    expect(within(panel).queryByRole('button', { name: 'Hema R' })).not.toBeInTheDocument();
    await user.type(within(panel).getByLabelText('find a manager for Roshni Sahani'), 'a');
    // Two letters: only names with "ha" in them.
    const matches = within(panel).getByRole('list', { name: 'manager-matches' });
    expect(
      within(matches)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Priya Shah']);
    await user.type(within(panel).getByLabelText('person-reason'), 'new team');
    await user.click(within(matches).getByRole('button', { name: 'Priya Shah' }));
    expect(mocks.adminSetManager).toHaveBeenCalledWith('e-roshni', 'e-priya', 'new team');
    expect(await within(panel).findByRole('status')).toHaveTextContent(
      'Roshni Sahani now reports to Priya Shah.',
    );
    // The table reloads after a change.
    expect(mocks.adminEmployees).toHaveBeenCalledTimes(2);
  });

  it('HR: no Shift column, no shift in the panel', async () => {
    mocks.adminShifts.mockRejectedValue('forbidden');
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll={false} onClose={() => undefined} />);
    await screen.findByRole('table', { name: 'people-table' });
    expect(screen.queryByRole('columnheader', { name: /Shift/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Roshni Sahani' }));
    const panel = screen.getByRole('complementary', { name: 'person Roshni Sahani' });
    expect(within(panel).queryByLabelText('shift of Roshni Sahani')).not.toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: 'role-Administrator' })).toBeDisabled();
  });

  it('Add person opens the panel for someone new, Employee ticked', async () => {
    mocks.adminPeopleSearch.mockResolvedValue({
      users: [{ oid: 'o-new', name: 'New Joiner', email: 'new@aptask.com' }],
    });
    mocks.adminPeopleSetRoles.mockResolvedValue({ roles: ['Employee'], changed: true });
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    await screen.findByRole('table', { name: 'people-table' });
    await user.click(screen.getByRole('button', { name: 'Add person' }));
    await user.type(screen.getByLabelText('people-search'), 'new');
    await user.click(await screen.findByRole('button', { name: /New Joiner/ }, { timeout: 2000 }));
    const panel = screen.getByRole('complementary', { name: 'person New Joiner' });
    expect(within(panel).getByRole('checkbox', { name: 'role-Employee' })).toBeChecked();
    expect(within(panel).getByText(/No CloudPunch record yet/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Save roles' }));
    expect(mocks.adminPeopleSetRoles).toHaveBeenCalledWith('o-new', ['Employee'], '');
    // A new Employee: the welcome email is offered next, as today.
    expect(await within(panel).findByRole('group', { name: 'Welcome email' })).toBeInTheDocument();
    expect(mocks.adminWelcomePreview).toHaveBeenCalledWith('o-new');
  });
});
