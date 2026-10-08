import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeRow, Person } from './api.js';
import { ReportingLines } from './ReportingLines.js';

const mocks = vi.hoisted(() => ({
  adminPeople: vi.fn<() => Promise<{ people: Person[] }>>(),
  adminEmployees: vi.fn<() => Promise<{ employees: EmployeeRow[] }>>(),
  adminSetManager: vi.fn<() => Promise<unknown>>(),
  adminPeopleSetRoles: vi.fn<(oid: string, roles: string[], reason: string) => Promise<unknown>>(),
}));
vi.mock('./api.js', () => ({ api: mocks }));

const row = (id: string, name: string, managerId: string | null = null): EmployeeRow => ({
  id,
  name,
  email: null,
  reporting_manager_id: managerId,
  oid: `oid-${id}`,
});
const person = (id: string, name: string, roles: string[], record = true): Person => ({
  oid: `oid-${id}`,
  name,
  roles,
  has_employee_record: record,
});

const ROSHNI = row('e-roshni', 'Roshni Sahani', 'e-old');
const NILESH = row('e-nilesh', 'Nilesh D');
const FARHEEN = row('e-farheen', 'Farheen Khanam');
const PRIYA = row('e-priya', 'Priya HR');
const OLD = row('e-old', 'Old Manager');
const SHAZIYA = row('e-shaziya', 'Shaziya Syed');

const options = (name: string): string[] =>
  within(screen.getByLabelText(`manager of ${name}`))
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');

beforeEach(() => {
  mocks.adminEmployees.mockResolvedValue({
    employees: [ROSHNI, NILESH, FARHEEN, PRIYA, OLD],
  });
  mocks.adminPeople.mockResolvedValue({
    people: [
      person('e-roshni', 'Roshni Sahani', ['Employee']),
      person('e-nilesh', 'Nilesh D', ['Employee', 'Manager']),
      person('e-farheen', 'Farheen Khanam', ['Employee']),
      person('e-priya', 'Priya HR', ['HR']),
      person('e-old', 'Old Manager', ['Employee']),
      person('e-shaziya', 'Shaziya Syed', ['Manager'], false),
    ],
  });
});

describe('Reporting lines', () => {
  it('offers only Managers and HR, plus the manager someone already has', async () => {
    render(<ReportingLines />);
    await screen.findByLabelText('manager of Roshni Sahani');
    await vi.waitFor(() =>
      expect(options('Roshni Sahani')).toEqual([
        'No manager',
        'Nilesh D',
        'Priya HR',
        'Old Manager',
      ]),
    );
    expect(options('Farheen Khanam')).toEqual(['No manager', 'Nilesh D', 'Priya HR']);
    // The kept manager lacks the role: the existing warning says so.
    expect(screen.getByText(/Old Manager doesn't have the Manager role yet/)).toBeInTheDocument();
  });

  it('a Manager without a record gets one, then can be picked', async () => {
    mocks.adminPeopleSetRoles.mockResolvedValue({ changed: false });
    render(<ReportingLines />);
    const note = await screen.findByText(/Shaziya Syed has the Manager role but no CloudPunch/);
    expect(options('Roshni Sahani')).not.toContain('Shaziya Syed');
    mocks.adminEmployees.mockResolvedValue({
      employees: [ROSHNI, NILESH, FARHEEN, PRIYA, OLD, SHAZIYA],
    });
    await userEvent.click(within(note).getByRole('button', { name: "Add Shaziya Syed's record" }));
    expect(mocks.adminPeopleSetRoles).toHaveBeenCalledWith(
      'oid-e-shaziya',
      ['Manager'],
      'Record for reporting lines',
    );
    expect(
      await screen.findByText('Shaziya Syed can now be picked as a manager.'),
    ).toBeInTheDocument();
    expect(options('Roshni Sahani')).toContain('Shaziya Syed');
    expect(screen.queryByText(/has the Manager role but no CloudPunch/)).not.toBeInTheDocument();
  });

  it("if roles can't load, everyone is offered as before", async () => {
    mocks.adminPeople.mockRejectedValue('offline');
    render(<ReportingLines />);
    await screen.findByLabelText('manager of Roshni Sahani');
    expect(options('Roshni Sahani')).toContain('Farheen Khanam');
  });
});
