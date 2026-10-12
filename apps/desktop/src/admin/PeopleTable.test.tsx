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
  adminBulkManager: vi.fn(),
  adminBulkRoles: vi.fn(),
  adminShiftTemplates: vi.fn(),
  adminSetNamedShift: vi.fn(),
  adminBulkShift: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: mocks }));

const DAY = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', tz_iana: 'Asia/Kolkata' };
const TEMPLATE_DAY = {
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  tz_iana: 'Asia/Kolkata',
};

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
      {
        employee_id: 'e-priya',
        name: 'Priya Shah',
        shift: DAY,
        template: { id: 't-india', name: 'India day' },
      },
      { employee_id: 'e-hr', name: 'Hema R', shift: DAY },
      { employee_id: 'e-roshni', name: 'Roshni Sahani', shift: null },
    ],
  });
  mocks.adminShiftTemplates.mockResolvedValue({
    templates: [
      {
        id: 't-india',
        name: 'India day',
        ...TEMPLATE_DAY,
        effective_from: '2026-10-01',
        retired: false,
        next: null,
        people: 2,
      },
      {
        id: 't-old',
        name: 'Old night',
        ...TEMPLATE_DAY,
        effective_from: '2026-10-01',
        retired: true,
        next: null,
        people: 0,
      },
    ],
    custom: 0,
    none: 1,
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

describe('bulk changes (ADR-0038 §5)', () => {
  it('ticks people, previews a new manager, and applies with one key, kept for a retry', async () => {
    mocks.adminBulkManager.mockRejectedValueOnce('offline').mockResolvedValueOnce({
      manager_employee_id: 'e-priya',
      changed: ['e-roshni'],
      unchanged: ['e-hr'],
    });
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    await user.click(await screen.findByRole('checkbox', { name: 'select Roshni Sahani' }));
    await user.click(screen.getByRole('checkbox', { name: 'select Hema R' }));
    const bar = screen.getByRole('toolbar', { name: 'bulk-actions' });
    expect(bar).toHaveTextContent('2 selected');
    await user.click(within(bar).getByRole('button', { name: 'Set manager' }));

    const panel = screen.getByRole('complementary', { name: 'bulk Set manager' });
    expect(within(panel).getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.type(within(panel).getByLabelText('find a manager for 2 people'), 'pri');
    await user.click(within(panel).getByRole('button', { name: 'Priya Shah' }));
    expect(within(panel).getByLabelText('bulk-preview')).toHaveTextContent(
      'This changes 1 person: Roshni Sahani gets Priya Shah as manager. 1 person already reports to Priya Shah.',
    );
    await user.type(within(panel).getByLabelText('bulk-reason'), 'new team');
    await user.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent("Can't reach CloudPunch");
    await user.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(
      await within(panel).findByText(/Done\. 1 person changed; 1 already had that manager/),
    ).toBeInTheDocument();

    const [first, second] = mocks.adminBulkManager.mock.calls;
    expect(first).toEqual([expect.any(String), ['e-roshni'], 'e-priya', 'new team']);
    // The retry is the same request, so the same key: the server answers once.
    expect(second?.[0]).toBe(first?.[0]);
  });

  it('a loop is shown before anything is sent', async () => {
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    // Hema reports to Priya: putting Priya under Hema is a loop.
    await user.click(await screen.findByRole('checkbox', { name: 'select Priya Shah' }));
    await user.click(screen.getByRole('button', { name: 'Set manager' }));
    const panel = screen.getByRole('complementary', { name: 'bulk Set manager' });
    await user.type(within(panel).getByLabelText('find a manager for 1 person'), 'hem');
    await user.click(within(panel).getByRole('button', { name: 'Hema R' }));
    expect(within(panel).getByLabelText('bulk-preview')).toHaveTextContent(
      'Priya Shah is above Hema R: that would make a reporting loop.',
    );
    expect(within(panel).getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('adds a role to everyone on the page, listing who it was not done for', async () => {
    mocks.adminBulkRoles.mockResolvedValue({
      add: ['Manager'],
      remove: [],
      results: [
        { oid: 'o-hr', outcome: 'done' },
        { oid: 'o-roshni', outcome: 'failed', code: 'directory_forbidden' },
      ],
    });
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll={false} onClose={() => undefined} />);
    await user.click(await screen.findByRole('checkbox', { name: 'select this page' }));
    expect(screen.getByRole('toolbar', { name: 'bulk-actions' })).toHaveTextContent('3 selected');
    await user.click(screen.getByRole('button', { name: 'Add role' }));
    const panel = screen.getByRole('complementary', { name: 'bulk Add role' });
    // HR: Employee and Manager only.
    expect(
      within(within(panel).getByLabelText('bulk-role'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a role', 'Employee', 'Manager']);
    await user.selectOptions(within(panel).getByLabelText('bulk-role'), 'Manager');
    expect(within(panel).getByLabelText('bulk-preview')).toHaveTextContent(
      'This changes 2 people: Hema R and Roshni Sahani get Manager. 1 person already has it.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(mocks.adminBulkRoles).toHaveBeenCalledWith(
      expect.any(String),
      ['o-hr', 'o-roshni'],
      { add: ['Manager'], remove: [] },
      '',
    );
    expect(await within(panel).findByLabelText('bulk-not-done')).toHaveTextContent(
      'Roshni Sahani: Microsoft refused',
    );
    // The table reloads after.
    expect(mocks.adminPeople).toHaveBeenCalledTimes(2);
  });
});

describe('named shifts in People (ADR-0038 §6)', () => {
  it('the table names the shift; the panel gives one by name from a date', async () => {
    mocks.adminSetNamedShift.mockResolvedValue({
      shift: DAY,
      template_id: 't-india',
      effective_from: '2026-10-19',
    });
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    const priya = (await screen.findByRole('button', { name: 'Priya Shah' })).closest('tr')!;
    expect(within(priya).getByText('India day')).toHaveAttribute(
      'title',
      expect.stringContaining('09:00–18:00'),
    );

    await user.click(screen.getByRole('button', { name: 'Roshni Sahani' }));
    const panel = screen.getByRole('complementary', { name: 'person Roshni Sahani' });
    await user.click(within(panel).getByRole('button', { name: 'Set shift' }));
    const select = within(panel).getByLabelText('shift for Roshni Sahani');
    // Retired named shifts aren't offered.
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a named shift', 'India day', 'Custom pattern…']);
    await user.selectOptions(select, 'India day');
    await user.type(within(panel).getByLabelText('shift-from'), '2026-10-19');
    await user.click(within(panel).getByRole('button', { name: 'Save shift' }));
    expect(mocks.adminSetNamedShift).toHaveBeenCalledWith('e-roshni', 't-india', '2026-10-19');
    expect(await within(panel).findByRole('status')).toHaveTextContent(
      'Roshni Sahani is on India day from 2026-10-19.',
    );
  });

  it('bulk: Set shift by name, with a preview', async () => {
    mocks.adminBulkShift.mockResolvedValue({
      template_id: 't-india',
      effective_from: '2026-10-12',
      changed: ['e-hr', 'e-roshni'],
      unchanged: ['e-priya'],
    });
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll onClose={() => undefined} />);
    await user.click(await screen.findByRole('checkbox', { name: 'select this page' }));
    await user.click(screen.getByRole('button', { name: 'Set shift' }));
    const panel = screen.getByRole('complementary', { name: 'bulk Set shift' });
    await user.selectOptions(within(panel).getByLabelText('bulk-shift'), 'India day');
    expect(within(panel).getByLabelText('bulk-preview')).toHaveTextContent(
      'This changes 2 people: Hema R and Roshni Sahani go on India day from today. 1 person is already on it.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(mocks.adminBulkShift).toHaveBeenCalledWith(
      expect.any(String),
      ['e-hr', 'e-roshni'],
      { templateId: 't-india' },
      null,
      '',
    );
    expect(
      await within(panel).findByText(/2 people changed; 1 already had that shift/),
    ).toBeInTheDocument();
  });

  it('HR: no Set shift in the bulk bar', async () => {
    mocks.adminShifts.mockRejectedValue('forbidden');
    mocks.adminShiftTemplates.mockRejectedValue('forbidden');
    const user = userEvent.setup();
    render(<PeopleTable canAssignAll={false} onClose={() => undefined} />);
    await user.click(await screen.findByRole('checkbox', { name: 'select Hema R' }));
    const bar = screen.getByRole('toolbar', { name: 'bulk-actions' });
    expect(within(bar).queryByRole('button', { name: 'Set shift' })).not.toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Set manager' })).toBeInTheDocument();
  });
});
