import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputersPage } from './ComputersPage.js';
import { ConnectionsPage } from './ConnectionsPage.js';
import { HolidaysPage } from './HolidaysPage.js';

const mocks = vi.hoisted(() => ({
  holidays: vi.fn(),
  setHoliday: vi.fn(),
  removeHoliday: vi.fn(),
  adminDevices: vi.fn(),
  teamConnections: vi.fn(),
  personConnections: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: mocks }));

const firstColumn = (table: string): string[] =>
  within(screen.getByRole('table', { name: table }))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]?.textContent ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.holidays.mockResolvedValue({
    holidays: [
      { date: '2099-10-20', name: 'Diwali' },
      { date: '2099-12-25', name: 'Christmas' },
    ],
  });
  mocks.setHoliday.mockImplementation(async (date: string, name: string) => ({ date, name }));
  mocks.removeHoliday.mockResolvedValue(null);
});

describe('Holidays page (ADR-0038 §9)', () => {
  it('lists holidays in a table and asks before removing one', async () => {
    const user = userEvent.setup();
    render(<HolidaysPage />);
    await screen.findByRole('table', { name: 'holidays-table' });
    expect(firstColumn('holidays-table')).toEqual(['Tue, 20 Oct 2099', 'Fri, 25 Dec 2099']);
    await user.click(screen.getByRole('button', { name: 'remove Diwali' }));
    expect(mocks.removeHoliday).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('group', { name: 'remove Diwali?' })).getByRole('button', {
        name: 'Yes',
      }),
    );
    expect(mocks.removeHoliday).toHaveBeenCalledWith('2099-10-20');
    expect(await screen.findByRole('status')).toHaveTextContent('Diwali is no longer a holiday.');
    expect(firstColumn('holidays-table')).toEqual(['Fri, 25 Dec 2099']);
  });

  it('paste a list: check first, then save the new and renamed ones', async () => {
    const user = userEvent.setup();
    render(<HolidaysPage />);
    await user.click(await screen.findByRole('button', { name: 'Paste a list' }));
    const box = screen.getByRole('group', { name: 'paste a list' });
    await user.type(
      within(box).getByLabelText('holiday list'),
      '2099-01-26 Republic Day{enter}2099-10-20, Deepavali{enter}2099-12-25 Christmas{enter}Nonsense',
    );
    await user.click(within(box).getByRole('button', { name: 'Check' }));
    const preview = within(box).getByRole('table', { name: 'holiday-preview' });
    expect(preview).toHaveTextContent('Republic Day');
    expect(preview).toHaveTextContent('(was Diwali)');
    expect(preview).toHaveTextContent('Already listed');
    expect(preview).toHaveTextContent('No date at the start');
    await user.click(within(box).getByRole('button', { name: 'Save 2' }));
    expect(mocks.setHoliday.mock.calls).toEqual([
      ['2099-01-26', 'Republic Day'],
      ['2099-10-20', 'Deepavali'],
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent('2 holidays saved.');
    expect(mocks.holidays).toHaveBeenCalledTimes(2);
  });
});

describe('Computers page (ADR-0038 §9)', () => {
  it('sorts versions as numbers and filters to those behind', async () => {
    mocks.adminDevices.mockResolvedValue({
      devices: [
        {
          device_id: 'd1',
          display_name: 'Roshni',
          work_email: 'r@aptask.com',
          os: 'windows',
          app_version: '0.1.10',
          last_seen_at: null,
          revoked_at: null,
        },
        {
          device_id: 'd2',
          display_name: 'Nilesh',
          work_email: 'n@aptask.com',
          os: 'macos',
          app_version: '0.1.9',
          last_seen_at: null,
          revoked_at: null,
        },
        {
          device_id: 'd3',
          display_name: 'Old',
          work_email: 'o@aptask.com',
          os: 'windows',
          app_version: '0.1.1',
          last_seen_at: null,
          revoked_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const user = userEvent.setup();
    render(<ComputersPage />);
    await screen.findByRole('table', { name: 'computers-table' });
    expect(firstColumn('computers-table')).toEqual(['Nileshn@aptask.com', 'Roshnir@aptask.com']);
    expect(screen.getByLabelText('version-summary')).toHaveTextContent('1 behind 0.1.10');
    await user.click(screen.getByLabelText('behind-only'));
    expect(firstColumn('computers-table')).toEqual(['Nileshn@aptask.com']);
    await user.click(screen.getByLabelText('behind-only'));
    await user.selectOptions(screen.getByLabelText('filter-os'), 'windows');
    expect(firstColumn('computers-table')).toEqual(['Roshnir@aptask.com']);
  });
});

describe('Connections page (ADR-0038 §9)', () => {
  it('a row opens that person’s history beside the table', async () => {
    const seen = new Date().toISOString();
    mocks.teamConnections.mockResolvedValue({
      recording: true,
      attribution: 'IP data by IPinfo',
      people: [
        {
          employee_id: 'e2',
          name: 'Roshni',
          ip: '1.2.3.4',
          city: 'Pune',
          region: null,
          country: 'IN',
          provider: 'Jio',
          asn: null,
          device_os: null,
          first_seen_at: seen,
          last_seen_at: seen,
        },
        {
          employee_id: 'e1',
          name: 'Nilesh',
          ip: '5.6.7.8',
          city: 'Mumbai',
          region: null,
          country: 'IN',
          provider: 'Airtel',
          asn: null,
          device_os: null,
          first_seen_at: seen,
          last_seen_at: seen,
        },
      ],
    });
    mocks.personConnections.mockResolvedValue({
      recording: true,
      keep_days: 30,
      attribution: 'IP data by IPinfo',
      connections: [],
    });
    const user = userEvent.setup();
    render(<ConnectionsPage />);
    await screen.findByRole('table', { name: 'connections-table' });
    expect(firstColumn('connections-table')).toEqual(['Nilesh', 'Roshni']);
    await user.type(screen.getByLabelText('connections-table-find'), 'jio');
    expect(firstColumn('connections-table')).toEqual(['Roshni']);
    await user.click(screen.getByText('Roshni'));
    expect(
      screen.getByRole('complementary', { name: 'connections of Roshni' }),
    ).toBeInTheDocument();
    expect(mocks.personConnections).toHaveBeenCalledWith('e2');
  });
});
