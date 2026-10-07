import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  api,
  type CorrectionInput,
  type CorrectionKind,
  type CorrectionQueue,
  type CorrectionQueueItem,
  type DayCorrection,
} from './api.js';
import {
  KIND_LABEL,
  KINDS,
  correctionErrorText,
  correctionSpan,
  spanText,
  statusText,
  zoneChoices,
} from './correctionModel.js';
import { dayLabel, localDateOf } from './dayHistory.js';
import { Button } from './ui/Button.js';
import { useTheme, type Theme } from './ui/theme.js';

/**
 * Time corrections (ADR-0030): the form, a day's corrections, and the
 * review queue. The server decides who may do what; these only ask.
 */

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** How often the review banner checks for new work. */
const QUEUE_REFRESH_MS = 5 * 60_000;

function input(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    fontSize: 13,
    padding: '6px 8px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.text,
  };
}

/**
 * "Correct this day": a stretch of `date` (start, end, what it was, why).
 * `defaultTz` is the zone the day was recorded in, when known.
 */
export function CorrectionForm({
  date,
  defaultTz,
  submitLabel,
  onSubmit,
  onDone,
  onCancel,
}: {
  date: string;
  defaultTz: string | null;
  submitLabel: string;
  onSubmit: (c: Omit<CorrectionInput, 'employeeId'>) => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const zones = zoneChoices(LOCAL_TZ);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [tz, setTz] = useState(
    defaultTz && zones.some((z) => z.tz === defaultTz) ? defaultTz : (zones[0]?.tz ?? LOCAL_TZ),
  );
  const [kind, setKind] = useState<CorrectionKind>('working');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = start !== '' && end !== '' && start !== end && reason.trim() !== '';

  const submit = (): void => {
    const span = correctionSpan(date, start, end, tz);
    setBusy(true);
    setError(null);
    onSubmit({ ...span, tzIana: tz, kind, reason: reason.trim() }).then(
      () => {
        setBusy(false);
        onDone();
      },
      (e: unknown) => {
        setBusy(false);
        setError(correctionErrorText(String(e)));
      },
    );
  };

  const label: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 };
  return (
    <form
      aria-label="correction-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) submit();
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surfaceAlt,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        Correct {dayLabel(date, localDateOf(Date.now()))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label style={label}>
          From
          <input
            aria-label="correction-start"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={input(t)}
          />
        </label>
        <label style={label}>
          To
          <input
            aria-label="correction-end"
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            style={input(t)}
          />
        </label>
        <label style={{ ...label, flex: 1, minWidth: 140 }}>
          Time zone
          <select
            aria-label="correction-zone"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            style={input(t)}
          >
            {zones.map((z) => (
              <option key={z.tz} value={z.tz}>
                {z.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {start !== '' && end !== '' && end <= start && start !== end && (
        <span style={{ fontSize: 12, color: t.muted }}>Ends the next morning.</span>
      )}
      <label style={label}>
        This time was
        <select
          aria-label="correction-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as CorrectionKind)}
          style={input(t)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label style={label}>
        Reason
        <input
          aria-label="correction-reason"
          value={reason}
          maxLength={500}
          placeholder="For example: the app didn't record this shift"
          onChange={(e) => setReason(e.target.value)}
          style={input(t)}
        />
      </label>
      {error && (
        <span role="alert" style={{ fontSize: 12, color: t.danger }}>
          {error}
        </span>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="chip" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? 'Sending…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A day's corrections and where each stands (ADR-0030 §4: nothing hidden). */
export function DayCorrections({
  corrections,
}: {
  corrections: readonly DayCorrection[] | undefined;
}): JSX.Element | null {
  const t = useTheme();
  const shown = (corrections ?? []).filter((c) => c.status !== 'withdrawn');
  if (shown.length === 0) return null;
  return (
    <ul aria-label="day-corrections" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {shown.map((c) => (
        <li
          key={c.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: '6px 0',
            borderTop: `1px solid ${t.border}`,
            fontSize: 13,
          }}
        >
          <span>
            <strong style={{ fontWeight: 600 }}>
              {c.status === 'approved' ? 'Corrected' : 'Correction'}
            </strong>{' '}
            {spanText(c)} · {KIND_LABEL[c.kind]}
          </span>
          <span style={{ fontSize: 12, color: c.status === 'rejected' ? t.danger : t.muted }}>
            {statusText(c)} · asked by {c.requested_by} · “{c.reason}”
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The caller's queue, refreshed every few minutes; `reload` after acting. */
export function useCorrectionsQueue(enabled: boolean): {
  queue: CorrectionQueue | null;
  reload: () => void;
} {
  const [queue, setQueue] = useState<CorrectionQueue | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) {
      setQueue(null);
      return;
    }
    let current = true;
    const load = (): void => {
      api.correctionsQueue().then(
        (q) => {
          if (current) setQueue(q);
        },
        () => undefined,
      );
    };
    load();
    const timer = window.setInterval(load, QUEUE_REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [enabled, tick]);
  return { queue, reload };
}

export function queueCount(q: CorrectionQueue | null): number {
  return q ? q.to_endorse.length + q.to_approve.length : 0;
}

/** The banner that leads to the queue; nothing when there is no work. */
export function CorrectionsBanner({
  count,
  onReview,
}: {
  count: number;
  onReview: () => void;
}): JSX.Element | null {
  const t = useTheme();
  if (count === 0) return null;
  return (
    <section
      role="status"
      aria-label="corrections-waiting"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 10,
        border: `1px solid ${t.accent}`,
        background: t.surfaceAlt,
        fontSize: 13,
      }}
    >
      <span>
        {count === 1
          ? '1 time correction waits for you.'
          : `${count} time corrections wait for you.`}
      </span>
      <Button variant="chip" onClick={onReview}>
        Review
      </Button>
    </section>
  );
}

/** Corrections waiting on the caller: endorse as the manager, approve as an Administrator. */
export function CorrectionsQueue({
  queue,
  onChanged,
  onClose,
}: {
  queue: CorrectionQueue | null;
  onChanged: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = (item: CorrectionQueueItem, decision: 'endorse' | 'approve' | 'reject'): void => {
    setBusy(item.correction.id);
    setError(null);
    api.decideCorrection(item.correction.id, decision).then(
      () => {
        setBusy(null);
        onChanged();
      },
      (e: unknown) => {
        setBusy(null);
        setError(correctionErrorText(String(e)));
        onChanged();
      },
    );
  };
  const today = localDateOf(Date.now());
  const group = (
    title: string,
    items: readonly CorrectionQueueItem[],
    yes: 'endorse' | 'approve',
  ): JSX.Element | null =>
    items.length === 0 ? null : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: t.muted }}>{title}</h3>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((i) => (
            <li
              key={i.correction.id}
              aria-label={`correction ${i.name}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '10px 0',
                borderTop: `1px solid ${t.border}`,
                fontSize: 13,
              }}
            >
              <span>
                <strong style={{ fontWeight: 600 }}>{i.name}</strong> · {dayLabel(i.date, today)} ·{' '}
                {spanText(i.correction)} · {KIND_LABEL[i.correction.kind]}
              </span>
              <span style={{ fontSize: 12, color: t.muted }}>
                Asked by {i.correction.requested_by} · “{i.correction.reason}”
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="primary" disabled={busy !== null} onClick={() => act(i, yes)}>
                  {yes === 'approve' ? 'Approve' : 'Endorse'}
                </Button>
                <Button variant="chip" disabled={busy !== null} onClick={() => act(i, 'reject')}>
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  const empty = queueCount(queue) === 0;
  return (
    <section
      aria-label="corrections-queue"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Time corrections</h2>
        <button
          type="button"
          onClick={onClose}
          style={{
            border: 'none',
            background: 'none',
            padding: 0,
            color: t.accent,
            font: 'inherit',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </div>
      {error && (
        <span role="alert" style={{ fontSize: 12, color: t.danger }}>
          {error}
        </span>
      )}
      {!queue && <span style={{ fontSize: 13, color: t.muted }}>Loading…</span>}
      {queue && empty && (
        <span style={{ fontSize: 13, color: t.muted }}>Nothing waits for you.</span>
      )}
      {queue && group('To approve', queue.to_approve, 'approve')}
      {queue && group('From your team, to endorse', queue.to_endorse, 'endorse')}
    </section>
  );
}
