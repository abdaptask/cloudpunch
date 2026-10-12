import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminConsole } from './AdminConsole.js';

// Today's screens stand in as labels: this tests the console, not them.
vi.mock('./PeopleTable.js', () => ({ PeopleTable: () => <p>people screen</p> }));
vi.mock('../ReportingLines.js', () => ({ ReportingLines: () => <p>reporting lines</p> }));
vi.mock('./ShiftsPage.js', () => ({ ShiftsPage: () => <p>shift editor</p> }));
vi.mock('../HolidayEditor.js', () => ({ HolidayEditor: () => <p>holiday editor</p> }));
vi.mock('./RulesPage.js', () => ({
  RulesPage: ({
    canEditCompany,
    onDirtyChange,
  }: {
    canEditCompany: boolean;
    onDirtyChange: (d: boolean) => void;
  }) => (
    <p>
      rules {canEditCompany ? 'company' : 'department'}
      <button type="button" onClick={() => onDirtyChange(true)}>
        make a change
      </button>
    </p>
  ),
}));
vi.mock('../VersionsScreen.js', () => ({ VersionsScreen: () => <p>versions screen</p> }));
vi.mock('../ConnectionsView.js', () => ({
  EveryoneConnections: () => <p>connections screen</p>,
}));

const ADMIN = [
  'admin.role.assign',
  'admin.shift.write',
  'hr.holiday.write',
  'admin.policy.write',
  'admin.device.read',
  'admin.connection.read',
];
const HR = ['hr.employee.write', 'hr.holiday.write', 'hr.policy.write'];

const nav = (): string[] =>
  screen
    .getAllByRole('button')
    .filter((b) => b.closest('nav'))
    .map((b) => b.textContent ?? '');

beforeEach(() => {
  window.localStorage.clear();
});

describe('AdminConsole (ADR-0038 §1)', () => {
  it('offers an Administrator every section and opens People first', () => {
    render(<AdminConsole capabilities={ADMIN} onClose={() => undefined} />);
    expect(nav()).toEqual([
      'People',
      'Managers',
      'Shifts',
      'Holidays',
      'Rules',
      'Computers',
      'Connections',
    ]);
    expect(screen.getByText('people screen')).toBeTruthy();
    expect(screen.queryByText('reporting lines')).toBeNull();
    expect(screen.getByRole('button', { name: 'People' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('reporting lines have their own Managers page', async () => {
    render(<AdminConsole capabilities={ADMIN} onClose={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Managers' }));
    expect(screen.getByText('reporting lines')).toBeTruthy();
    expect(screen.queryByText('people screen')).toBeNull();
  });

  it('switches section from the sidebar and remembers it', async () => {
    const { unmount } = render(<AdminConsole capabilities={ADMIN} onClose={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Shifts' }));
    expect(screen.getByText('shift editor')).toBeTruthy();
    expect(screen.queryByText('people screen')).toBeNull();
    unmount();
    render(<AdminConsole capabilities={ADMIN} onClose={() => undefined} />);
    expect(screen.getByText('shift editor')).toBeTruthy();
  });

  it('HR gets People, Holidays and Rules for a department', async () => {
    render(<AdminConsole capabilities={HR} onClose={() => undefined} />);
    expect(nav()).toEqual(['People', 'Managers', 'Holidays', 'Rules']);
    await userEvent.click(screen.getByRole('button', { name: 'Rules' }));
    expect(screen.getByText('rules department')).toBeTruthy();
  });

  it('a remembered section the role lacks falls back to the first', () => {
    window.localStorage.setItem('cloudpunch.admin.section', 'connections');
    render(<AdminConsole capabilities={HR} onClose={() => undefined} />);
    expect(screen.getByText('people screen')).toBeTruthy();
  });

  it('says so when the role has no admin screens', () => {
    render(<AdminConsole capabilities={['team.timeline.read']} onClose={() => undefined} />);
    expect(screen.getByText('Your CloudPunch role has no admin screens.')).toBeTruthy();
  });

  it('leaving Rules with unsaved changes asks first', async () => {
    const user = userEvent.setup();
    render(<AdminConsole capabilities={ADMIN} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Rules' }));
    await user.click(screen.getByRole('button', { name: 'make a change' }));
    await user.click(screen.getByRole('button', { name: 'People' }));
    expect(screen.getByRole('alertdialog', { name: 'leave-with-changes' })).toBeTruthy();
    expect(screen.getByText(/rules company/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'People' }));
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByText('people screen')).toBeTruthy();
  });
});
