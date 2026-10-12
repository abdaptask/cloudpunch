import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminConsole } from './AdminConsole.js';

// Today's screens stand in as labels: this tests the console, not them.
vi.mock('../PeopleScreen.js', () => ({ PeopleScreen: () => <p>people screen</p> }));
vi.mock('../ReportingLines.js', () => ({ ReportingLines: () => <p>reporting lines</p> }));
vi.mock('../ShiftEditor.js', () => ({ ShiftEditor: () => <p>shift editor</p> }));
vi.mock('../HolidayEditor.js', () => ({ HolidayEditor: () => <p>holiday editor</p> }));
vi.mock('../SettingsScreen.js', () => ({
  SettingsScreen: ({ canEditCompany }: { canEditCompany: boolean }) => (
    <p>rules {canEditCompany ? 'company' : 'department'}</p>
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
    expect(nav()).toEqual(['People', 'Shifts', 'Holidays', 'Rules', 'Computers', 'Connections']);
    expect(screen.getByText('people screen')).toBeTruthy();
    expect(screen.getByText('reporting lines')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'People' }).getAttribute('aria-current')).toBe(
      'page',
    );
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
    expect(nav()).toEqual(['People', 'Holidays', 'Rules']);
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
});
