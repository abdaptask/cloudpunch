import { useEffect, useState, type CSSProperties } from 'react';
import { api, type Shift, type ShiftRow } from './api.js';
import { zoneChoices } from './correctionModel.js';
import { Button } from './ui/Button.js';
import { useTheme, type Theme } from './ui/theme.js';

/**
 * Settings → People → Shifts (ADR-0031 §1): Administrators set each
 * person's weekly shift. The server checks the role again.
 */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: 'Only an Administrator can set shifts.',
  validation: 'A shift needs at least one day, a start and a different end.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** "Mon–Fri", "Mon, Wed, Fri", "Every day". */
export function daysText(days: readonly number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'Every day';
  const run = d.length > 2 && d.every((x, i) => i === 0 || x === (d[i - 1] ?? 0) + 1);
  if (run) return `${DAY_NAMES[(d[0] ?? 1) - 1]}–${DAY_NAMES[(d.at(-1) ?? 1) - 1]}`;
  return d.map((x) => DAY_NAMES[x - 1]).join(', ');
}

/** "Mon–Fri · 08:00–17:30 · US Eastern", or "No shift". */
export function shiftText(s: Shift | null): string {
  if (!s) return 'No shift';
  const zone = zoneChoices(LOCAL_TZ).find((z) => z.tz === s.tz_iana)?.label ?? s.tz_iana;
  const next = s.end <= s.start ? ' (next day)' : '';
  return `${daysText(s.days)} · ${s.start}–${s.end}${next} · ${zone}`;
}

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

function Editor({
  row,
  onSaved,
  onCancel,
}: {
  row: ShiftRow;
  onSaved: (s: Shift | null) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const zones = zoneChoices(LOCAL_TZ);
  const [days, setDays] = useState<number[]>(row.shift?.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(row.shift?.start ?? '');
  const [end, setEnd] = useState(row.shift?.end ?? '');
  const [tz, setTz] = useState(row.shift?.tz_iana ?? 'Asia/Kolkata');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = days.length > 0 && start !== '' && end !== '' && start !== end;

  const save = (clear: boolean): void => {
    setBusy(true);
    setError(null);
    api
      .adminSetShift(row.employee_id, {
        days: clear ? [] : days,
        start: clear ? null : start,
        end: clear ? null : end,
        tzIana: tz,
      })
      .then(
        (r) => onSaved(r.shift),
        (e: unknown) => {
          setBusy(false);
          setError(errorText(String(e)));
        },
      );
  };

  return (
    <div
      aria-label={`shift editor ${row.name}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}
    >
      <div role="group" aria-label="shift-days" style={{ display: 'flex', gap: 4 }}>
        {DAY_NAMES.map((name, i) => {
          const day = i + 1;
          const on = days.includes(day);
          return (
            <Button
              key={name}
              variant="chip"
              aria-pressed={on}
              onClick={() => setDays((d) => (on ? d.filter((x) => x !== day) : [...d, day].sort()))}
              style={on ? { borderColor: t.accent, color: t.accent, fontWeight: 650 } : {}}
            >
              {name}
            </Button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          aria-label="shift-start"
          type="time"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          style={input(t)}
        />
        <span style={{ fontSize: 13 }}>to</span>
        <input
          aria-label="shift-end"
          type="time"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          style={input(t)}
        />
        <select
          aria-label="shift-zone"
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
      </div>
      {start !== '' && end !== '' && end < start && (
        <span style={{ fontSize: 12, color: t.muted }}>Ends the next morning.</span>
      )}
      {error && (
        <span role="alert" style={{ fontSize: 12, color: t.danger }}>
          {error}
        </span>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" disabled={!ready || busy} onClick={() => save(false)}>
          Save shift
        </Button>
        {row.shift && (
          <Button variant="chip" disabled={busy} onClick={() => save(true)}>
            No shift
          </Button>
        )}
        <Button variant="chip" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ShiftEditor(): JSX.Element {
  const t = useTheme();
  const [rows, setRows] = useState<ShiftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    api.adminShifts().then(
      (r) => {
        if (current) setRows(r.people);
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <section aria-label="shifts" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: '8px 0 0', fontSize: 14, fontWeight: 650 }}>Shifts</h3>
      <p style={{ margin: 0, fontSize: 12, color: t.muted }}>
        During someone's shift, CloudPunch asks them to clock in from its start, and again every 5
        minutes until they do or say they aren't working.
      </p>
      {error && (
        <span role="alert" style={{ fontSize: 13, color: t.danger }}>
          {errorText(error)}
        </span>
      )}
      {!rows && !error && <span style={{ fontSize: 13, color: t.muted }}>Loading…</span>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows?.map((row) => (
          <li
            key={row.employee_id}
            style={{ borderTop: `1px solid ${t.border}`, padding: '8px 0', fontSize: 13 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontWeight: 600 }}>{row.name}</strong>
                <span
                  aria-label={`shift of ${row.name}`}
                  style={{ display: 'block', fontSize: 12, color: t.muted }}
                >
                  {shiftText(row.shift)}
                </span>
              </span>
              {editing !== row.employee_id && (
                <Button variant="chip" onClick={() => setEditing(row.employee_id)}>
                  {row.shift ? 'Edit' : 'Set shift'}
                </Button>
              )}
            </div>
            {editing === row.employee_id && (
              <Editor
                row={row}
                onCancel={() => setEditing(null)}
                onSaved={(shift) => {
                  setRows(
                    (rs) =>
                      rs?.map((r) => (r.employee_id === row.employee_id ? { ...r, shift } : r)) ??
                      null,
                  );
                  setEditing(null);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
