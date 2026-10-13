import { useState, type CSSProperties } from 'react';
import { api } from '../api.js';
import { daysText } from '../ShiftEditor.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: 'Only HR or an Administrator can set office days.',
  past_date: 'Office weekdays change from today on.',
  validation: 'Pick a date from a month ago to a year ahead.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** "Tue, Thu", or "None". */
export function officeText(weekdays: readonly number[]): string {
  return weekdays.length === 0 ? 'None' : daysText(weekdays);
}

/** "Tue, 20 Oct" for `2026-10-20`. */
function dayText(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * In-office days in the person panel (ADR-0039 §5): their usual office
 * weekdays, and one-off dates in the office (or not). On an office day
 * CloudPunch doesn't ask them to clock in and nobody is told they're late.
 */
export function OfficeDaysPart({
  employeeId,
  weekdays,
  days,
  reason,
  onSaved,
}: {
  employeeId: string;
  weekdays: readonly number[];
  /** One-offs coming up. */
  days: readonly { date: string; in_office: boolean }[];
  /** The panel's "Why", for the audit log. */
  reason: string;
  onSaved: (text: string, error?: boolean) => void;
}): JSX.Element {
  const t = useTheme();
  const [picked, setPicked] = useState<number[]>([...weekdays]);
  const [date, setDate] = useState('');
  const [inOffice, setInOffice] = useState(true);
  const [busy, setBusy] = useState(false);
  const changed = [...picked].sort().join() !== [...weekdays].sort().join();
  const fail = (e: unknown): void => {
    setBusy(false);
    onSaved(errorText(String(e)), true);
  };

  const saveWeekdays = (): void => {
    setBusy(true);
    const sorted = [...picked].sort((a, b) => a - b);
    api.adminSetOfficePattern(employeeId, sorted, null, reason).then(() => {
      setBusy(false);
      onSaved(`Office days: ${officeText(sorted)}, from today.`);
    }, fail);
  };
  const saveDay = (d: string, on: boolean): void => {
    setBusy(true);
    api.adminSetOfficeDay(employeeId, d, on, reason).then(() => {
      setBusy(false);
      setDate('');
      onSaved(`${dayText(d)}: ${on ? 'in the office' : 'not in the office'}.`);
    }, fail);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        role="group"
        aria-label="office-weekdays"
        style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}
      >
        {DAY_NAMES.map((n, i) => {
          const day = i + 1;
          const on = picked.includes(day);
          return (
            <Button
              key={n}
              variant="chip"
              aria-pressed={on}
              onClick={() => setPicked((p) => (on ? p.filter((x) => x !== day) : [...p, day]))}
              style={on ? { borderColor: t.accent, color: t.accent, fontWeight: 650 } : {}}
            >
              {n}
            </Button>
          );
        })}
      </div>
      {changed && (
        <Button variant="primary" disabled={busy} onClick={saveWeekdays}>
          Save office weekdays
        </Button>
      )}
      {days.length > 0 && (
        <ul aria-label="office-one-offs" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {days.map((d) => (
            <li
              key={d.date}
              style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}
            >
              <span style={{ flex: 1 }}>
                {dayText(d.date)} · {d.in_office ? 'In office' : 'Not in office'}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => saveDay(d.date, !d.in_office)}
                style={link(t)}
              >
                {d.in_office ? 'Not in office' : 'In office'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          aria-label="office-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={input(t)}
        />
        <select
          aria-label="office-date-kind"
          value={inOffice ? 'in' : 'out'}
          onChange={(e) => setInOffice(e.target.value === 'in')}
          style={input(t)}
        >
          <option value="in">In office</option>
          <option value="out">Not in office</option>
        </select>
        <Button variant="chip" disabled={busy || !date} onClick={() => saveDay(date, inOffice)}>
          Add date
        </Button>
      </div>
    </div>
  );
}

function input(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    fontSize: 13,
    padding: '5px 8px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.text,
  };
}

function link(t: Theme): CSSProperties {
  return {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.accent,
    font: 'inherit',
    fontSize: 12.5,
    cursor: 'pointer',
  };
}
