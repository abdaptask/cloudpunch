import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RulesPage } from './RulesPage.js';

const mocks = vi.hoisted(() => ({
  adminDepartments: vi.fn(),
  adminPolicyGet: vi.fn(),
  adminPolicyPut: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: mocks }));

const DEPT = '0f8fad5b-d9cb-469f-a165-70867728950e';
// The company: defaults, but a 3-minute idle popup.
const COMPANY = { idle: { threshold_seconds: 180 } };
// Sales: a 5-minute popup and a 45-minute meal break.
const SALES = { idle: { threshold_seconds: 300 }, break: { meal: { max_minutes: 45 } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminDepartments.mockResolvedValue({ departments: [{ id: DEPT, name: 'Sales' }] });
  mocks.adminPolicyGet.mockImplementation(async (scope: string) =>
    scope === 'global'
      ? { override: { document: COMPANY }, effective: { policy: COMPANY } }
      : { override: { document: SALES }, effective: { policy: { ...COMPANY, ...SALES } } },
  );
  mocks.adminPolicyPut.mockImplementation(
    async (_s: string, _i: string | null, document: unknown) => ({
      override: { document },
      effective: { policy: document },
    }),
  );
});

describe('Rules (ADR-0038 §8)', () => {
  it('one section at a time; company-only sections only company-wide', async () => {
    const user = userEvent.setup();
    render(<RulesPage canEditCompany />);
    const menu = await screen.findByRole('navigation', { name: 'rule-sections' });
    expect(
      within(menu)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Idle',
      'Clock-in popup',
      'Long days',
      'Breaks',
      'Away',
      'Connection location',
      'Shift-start emails',
      'Day-end summary',
    ]);
    expect(await screen.findByLabelText('idle-prompt')).toHaveValue(3);
    expect(screen.queryByLabelText('long-day')).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('button', { name: 'Long days' }));
    expect(screen.getByLabelText('long-day')).toHaveValue(8);
    await user.selectOptions(screen.getByLabelText('scope'), DEPT);
    await screen.findByText(/follows the company rules/);
    const deptMenu = await screen.findByRole('navigation', { name: 'rule-sections' });
    expect(within(deptMenu).queryByRole('button', { name: 'Connection location' })).toBeNull();
  });

  it('a department shows Overridden with the company value, and Reset', async () => {
    const user = userEvent.setup();
    render(<RulesPage canEditCompany={false} />);
    const idle = await screen.findByRole('group', { name: 'Idle popup after (minutes)' });
    expect(idle).toHaveTextContent('Overridden');
    expect(idle).toHaveTextContent('Company: 3 min');
    // Not overridden: no badge.
    expect(screen.getByRole('group', { name: /Popup waits/ })).not.toHaveTextContent('Overridden');
    await user.click(within(idle).getByRole('button', { name: 'Reset to company value' }));
    expect(screen.getByLabelText('idle-prompt')).toHaveValue(3);
    expect(idle).not.toHaveTextContent('Overridden');

    await user.click(screen.getByRole('button', { name: 'Breaks' }));
    const meal = screen.getByRole('row', { name: 'break meal' });
    expect(meal).toHaveTextContent('Company: On · Meal break · Unpaid · 60 min');
  });

  it('the save bar counts changes across sections; a department saves only what differs', async () => {
    const user = userEvent.setup();
    render(<RulesPage canEditCompany={false} />);
    await screen.findByLabelText('idle-prompt');
    expect(screen.queryByRole('region', { name: 'save-bar' })).toBeNull();
    // Back to the company's popup time, and a new away check.
    await user.click(screen.getByRole('button', { name: 'Reset to company value' }));
    await user.click(screen.getByRole('button', { name: 'Away' }));
    await user.clear(screen.getByLabelText('away-check'));
    await user.type(screen.getByLabelText('away-check'), '90');
    const bar = screen.getByRole('region', { name: 'save-bar' });
    expect(bar).toHaveTextContent('2 unsaved changes');
    expect(screen.getByLabelText('Idle has unsaved changes')).toBeInTheDocument();
    await user.type(within(bar).getByLabelText('reason'), 'sales asked');
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    expect(mocks.adminPolicyPut).toHaveBeenCalledWith(
      'department',
      DEPT,
      { away: { check_after_minutes: 90 }, break: { meal: { max_minutes: 45 } } },
      'sales asked',
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(screen.queryByRole('region', { name: 'save-bar' })).toBeNull();
  });

  it('Discard puts the saved values back; switching scope with changes asks first', async () => {
    const user = userEvent.setup();
    render(<RulesPage canEditCompany />);
    const prompt = await screen.findByLabelText('idle-prompt');
    await user.clear(prompt);
    await user.type(prompt, '7');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('idle-prompt')).toHaveValue(3);

    await user.clear(screen.getByLabelText('idle-prompt'));
    await user.type(screen.getByLabelText('idle-prompt'), '7');
    await user.selectOptions(screen.getByLabelText('scope'), DEPT);
    const ask = screen.getByRole('alertdialog', { name: 'unsaved-changes' });
    expect(ask).toHaveTextContent('You have 1 unsaved change.');
    await user.click(within(ask).getByRole('button', { name: 'Stay' }));
    expect(screen.getByLabelText('idle-prompt')).toHaveValue(7);
    expect(mocks.adminPolicyGet).toHaveBeenCalledTimes(1);
  });
});
