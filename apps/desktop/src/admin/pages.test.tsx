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
  adminUpdatesLatest: vi.fn(),
  adminUpdateRemind: vi.fn(),
  saveCsv: vi.fn(),
  adminPolicyGet: vi.fn(),
  adminPolicyPut: vi.fn(),
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
  mocks.adminUpdatesLatest.mockResolvedValue({ windows: '0.1.42', macos: '0.1.42' });
  mocks.adminPolicyGet.mockResolvedValue({
    override: { document: { idle: { threshold_seconds: 180 } } },
    effective: { policy: {} },
  });
  mocks.adminPolicyPut.mockImplementation(async (_s: string, _i: null, document: unknown) => ({
    override: { document },
    effective: { policy: document },
  }));
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

describe('Computers → Push the update (ADR-0046 §3)', () => {
  it('pushes "everyone on the latest by…" into the company settings, keeping the rest', async () => {
    mocks.adminDevices.mockResolvedValue({ devices: [] });
    const user = userEvent.setup();
    render(<ComputersPage canPush />);
    const panel = await screen.findByRole('region', { name: 'push-update' });
    expect(await within(panel).findByText(/Latest: Windows 0.1.42 · Mac 0.1.42\./)).toBeTruthy();
    await user.selectOptions(within(panel).getByLabelText('push-when'), 'soon');
    await user.click(within(panel).getByRole('button', { name: 'Push the update' }));
    const [scope, id, document, reason] = mocks.adminPolicyPut.mock.calls[0] as [
      string,
      null,
      { idle: unknown; updates: { required_by: string; pushed_at: string } },
      string,
    ];
    expect([scope, id]).toEqual(['global', null]);
    expect(document.idle).toEqual({ threshold_seconds: 180 });
    const by = Date.parse(document.updates.required_by) - Date.now();
    expect(by).toBeGreaterThan(4 * 60_000);
    expect(by).toBeLessThanOrEqual(5 * 60_000);
    expect(reason).toMatch(/^Pushed the update \(Windows 0.1.42 · Mac 0.1.42\)/);
    expect(await within(panel).findByRole('status')).toHaveTextContent('Pushed.');
    expect(within(panel).getByLabelText('push-status')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Stop the push' }));
    expect(mocks.adminPolicyPut.mock.calls[1]?.[2]).toMatchObject({
      updates: { required_by: null, pushed_at: null },
    });
  });

  it('an Auditor sees it but cannot push', async () => {
    mocks.adminDevices.mockResolvedValue({ devices: [] });
    render(<ComputersPage />);
    const panel = await screen.findByRole('region', { name: 'push-update' });
    expect(panel).toHaveTextContent('Only an Administrator can push an update.');
    expect(mocks.adminPolicyGet).not.toHaveBeenCalled();
  });
});

describe('Computers → Export CSV and Email to update', () => {
  const device = (over: Record<string, unknown>) => ({
    device_id: crypto.randomUUID(),
    user_id: 'u1',
    display_name: 'Sweta Pandit',
    work_email: 'sweta@aptask.com',
    os: 'windows',
    app_version: '0.1.32',
    enrolled_at: '2026-10-09T09:00:00Z',
    last_seen_at: '2026-10-15T17:42:00Z',
    revoked_at: null,
    ...over,
  });
  const devices = [
    device({}),
    device({ os: 'macos', app_version: '0.1.42' }),
    device({
      user_id: 'u2',
      display_name: 'Eela Kapilla',
      work_email: 'eela@aptask.com',
      app_version: '0.1.40',
    }),
    device({
      user_id: 'u3',
      display_name: 'Amit, "AB" Bisht',
      work_email: 'amit@aptask.com',
      os: 'macos',
      app_version: '0.1.42',
    }),
  ];

  it('exports the rows as shown, quoted, with up to date against the published version', async () => {
    mocks.adminDevices.mockResolvedValue({ devices });
    mocks.saveCsv.mockResolvedValue('Downloads/x.csv');
    const user = userEvent.setup();
    render(<ComputersPage />);
    await screen.findByRole('table', { name: 'computers-table' });
    await user.type(screen.getByLabelText('computers-table-find'), 'aptask.com');
    await user.selectOptions(screen.getByLabelText('filter-os'), 'macos');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    const [name, text] = mocks.saveCsv.mock.calls[0] as [string, string];
    expect(name).toMatch(/^cloudpunch-computers-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Person,Email,System,CloudPunch version,Latest for system,Up to date,First set up,Last seen,Status',
    );
    // Mac only, sorted by name, quotes escaped.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^"Amit, ""AB"" Bisht",amit@aptask.com,macOS,0.1.42,0.1.42,yes,/);
    expect(lines[2]).toMatch(/^Sweta Pandit,sweta@aptask.com,macOS,0.1.42,0.1.42,yes,.*,active$/);
    expect(await screen.findByText('Saved Downloads/x.csv')).toBeTruthy();
    // No Email to update without the push capability.
    expect(screen.queryByRole('button', { name: 'Email to update' })).toBeNull();
  });

  it('emails the people behind, all ticked; unticking leaves someone out', async () => {
    mocks.adminDevices.mockResolvedValue({ devices });
    mocks.adminUpdateRemind.mockResolvedValue({
      sent: 1,
      sent_ids: ['u1'],
      skipped: [],
    });
    const user = userEvent.setup();
    render(<ComputersPage canPush />);
    await user.click(await screen.findByRole('button', { name: 'Email to update' }));
    const panel = screen.getByRole('region', { name: 'email-to-update' });
    const list = within(panel).getByRole('list', { name: 'people-behind' });
    // Behind 0.1.42: Sweta's Windows 0.1.32 and Eela's 0.1.40; not Amit.
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Eela Kapilla · Windows 0.1.40', 'Sweta Pandit · Windows 0.1.32']);
    await user.click(within(panel).getByLabelText('remind-Eela Kapilla'));
    await user.type(within(panel).getByLabelText('remind-message'), 'Today, please.');
    await user.click(within(panel).getByRole('button', { name: 'Send to 1 person' }));
    expect(mocks.adminUpdateRemind).toHaveBeenCalledWith(['u1'], 'Today, please.');
    expect(await within(panel).findByRole('status')).toHaveTextContent('Sent to 1 person.');
  });

  it('says why someone was not sent to', async () => {
    mocks.adminDevices.mockResolvedValue({ devices });
    mocks.adminUpdateRemind.mockResolvedValue({
      sent: 1,
      sent_ids: ['u1'],
      skipped: [{ id: 'u2', reason: 'reminded_recently' }],
    });
    const user = userEvent.setup();
    render(<ComputersPage canPush />);
    await user.click(await screen.findByRole('button', { name: 'Email to update' }));
    const panel = screen.getByRole('region', { name: 'email-to-update' });
    await user.click(within(panel).getByRole('button', { name: 'Send to 2 people' }));
    expect(await within(panel).findByRole('status')).toHaveTextContent(
      'Sent to 1 person. Not sent: Eela Kapilla (emailed in the last hour).',
    );
  });
});
