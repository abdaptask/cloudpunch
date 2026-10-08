import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorrectionQueue, DayCorrection } from './api.js';
import {
  CorrectionForm,
  CorrectionsBanner,
  CorrectionsQueue,
  DayCorrections,
} from './Corrections.js';

const mocks = vi.hoisted(() => ({
  decideCorrection: vi.fn<(id: string, decision: string) => Promise<unknown>>(),
}));
vi.mock('./api.js', () => ({ api: mocks }));

const correction = (over: Partial<DayCorrection> = {}): DayCorrection => ({
  id: 'c1',
  from: '2026-10-05T17:30:00.000+05:30',
  to: '2026-10-06T01:30:00.000+05:30',
  kind: 'working',
  reason: 'The app did not record the day',
  status: 'endorsed',
  requested_by: 'Abdulla Sheikh',
  requested_at: '2026-10-07T12:00:00Z',
  decisions: [],
  ...over,
});

beforeEach(() => {
  mocks.decideCorrection.mockReset();
});

describe('CorrectionForm', () => {
  it('sends a shift past midnight in the chosen zone', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(
      <CorrectionForm
        date="2026-10-05"
        defaultTz="Asia/Kolkata"
        submitLabel="Send for approval"
        onSubmit={onSubmit}
        onDone={onDone}
        onCancel={() => undefined}
      />,
    );
    const send = screen.getByRole('button', { name: 'Send for approval' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('correction-start'), '17:30');
    await user.type(screen.getByLabelText('correction-end'), '01:30');
    expect(screen.getByText('Ends the next morning.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('correction-reason'), 'Not recorded');
    await user.click(send);
    expect(onSubmit).toHaveBeenCalledWith({
      from: '2026-10-05T17:30:00+05:30',
      to: '2026-10-06T01:30:00+05:30',
      tzIana: 'Asia/Kolkata',
      kind: 'working',
      reason: 'Not recorded',
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('says why the server refused, in plain words', async () => {
    const user = userEvent.setup();
    render(
      <CorrectionForm
        date="2026-10-05"
        defaultTz="Asia/Kolkata"
        submitLabel="Send"
        onSubmit={vi.fn().mockRejectedValue('overlaps_pending')}
        onDone={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await user.type(screen.getByLabelText('correction-start'), '09:00');
    await user.type(screen.getByLabelText('correction-end'), '10:00');
    await user.type(screen.getByLabelText('correction-reason'), 'x');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Part of this time already has a correction waiting.',
    );
  });
});

describe('DayCorrections', () => {
  it('shows each correction with where it stands; withdrawn ones are left out', () => {
    render(
      <DayCorrections
        corrections={[
          correction(),
          correction({ id: 'c2', status: 'withdrawn' }),
          correction({
            id: 'c3',
            status: 'approved',
            decisions: [{ decision: 'approved', by: 'Nilesh Darekar', at: 'x', note: null }],
          }),
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('17:30–01:30 (next day) · Working');
    expect(items[0]).toHaveTextContent("Waiting for an Administrator's approval");
    expect(items[1]).toHaveTextContent('Corrected');
    expect(items[1]).toHaveTextContent('Approved by Nilesh Darekar');
  });
});

describe('the review queue', () => {
  const queue: CorrectionQueue = {
    to_approve: [
      { employee_id: 'e1', name: 'Roshni Sahani', date: '2026-10-05', correction: correction() },
    ],
    to_endorse: [],
  };

  it('the banner counts the work and opens the queue', async () => {
    const onReview = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<CorrectionsBanner count={0} onReview={onReview} />);
    expect(screen.queryByLabelText('corrections-waiting')).not.toBeInTheDocument();
    rerender(<CorrectionsBanner count={2} onReview={onReview} />);
    expect(screen.getByLabelText('corrections-waiting')).toHaveTextContent(
      '2 time corrections wait for you.',
    );
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledOnce();
  });

  it('Approve sends the decision and reloads', async () => {
    mocks.decideCorrection.mockResolvedValue({ correction: correction({ status: 'approved' }) });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<CorrectionsQueue queue={queue} onChanged={onChanged} onClose={() => undefined} />);
    expect(screen.getByLabelText('correction Roshni Sahani')).toHaveTextContent(
      'Asked by Abdulla Sheikh',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mocks.decideCorrection).toHaveBeenCalledWith('c1', 'approve');
    expect(onChanged).toHaveBeenCalled();
  });

  it('read only (the web, ADR-0033): shows what waits, no decisions', () => {
    render(
      <CorrectionsQueue
        readOnly
        queue={queue}
        onChanged={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByLabelText('correction Roshni Sahani')).toHaveTextContent(
      'Asked by Abdulla Sheikh',
    );
    for (const name of ['Approve', 'Endorse', 'Reject']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/open the CloudPunch app/)).toBeInTheDocument();
  });

  it('says when nothing waits', () => {
    render(
      <CorrectionsQueue
        queue={{ to_approve: [], to_endorse: [] }}
        onChanged={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Nothing waits for you.')).toBeInTheDocument();
  });
});
