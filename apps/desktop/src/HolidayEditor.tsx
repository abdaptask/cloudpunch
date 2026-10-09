import { useEffect, useState, type CSSProperties } from 'react';
import { api, type Holiday } from './api.js';
import { Button } from './ui/Button.js';
import { useTheme, type Theme } from './ui/theme.js';

/**
 * Settings → People → Holidays (ADR-0037 §1): one company list, kept by
 * HR and Administrators. On a holiday nobody is asked to clock in and
 * nobody counts as late. The server checks the role again.
 */

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: 'Only HR or an Administrator can change holidays.',
  validation: 'A holiday needs a date and a name.',
  invalid_argument: 'A holiday needs a date and a name.',
  not_found: 'That day is no longer a holiday.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** "Mon, 9 Nov 2026" for `2026-11-09`, whatever the computer's zone. */
export function holidayDateText(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
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

export function HolidayEditor(): JSX.Element {
  const t = useTheme();
  const [list, setList] = useState<Holiday[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    api.holidays().then(
      (r) => {
        if (current) setList(r.holidays);
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.setHoliday(date, name.trim());
      setList((l) =>
        [...(l ?? []).filter((h) => h.date !== saved.date), saved].sort((a, b) =>
          a.date.localeCompare(b.date),
        ),
      );
      setDate('');
      setName('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (h: Holiday): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.removeHoliday(h.date);
      setList((l) => l?.filter((x) => x.date !== h.date) ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="holidays" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: '8px 0 0', fontSize: 14, fontWeight: 650 }}>Holidays</h3>
      <p style={{ margin: 0, fontSize: 12, color: t.muted }}>
        One list for everyone. On a holiday CloudPunch doesn't ask anyone to clock in, and nobody
        shows as late. Anyone who works that day can still clock in.
      </p>
      {error && (
        <span role="alert" style={{ fontSize: 13, color: t.danger }}>
          {errorText(error)}
        </span>
      )}
      {!list && !error && <span style={{ fontSize: 13, color: t.muted }}>Loading…</span>}
      {list?.length === 0 && (
        <span style={{ fontSize: 13, color: t.muted }}>No holidays coming up.</span>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {list?.map((h) => (
          <li
            key={h.date}
            style={{
              borderTop: `1px solid ${t.border}`,
              padding: '8px 0',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ fontWeight: 600 }}>{h.name}</strong>
              <span style={{ display: 'block', fontSize: 12, color: t.muted }}>
                {holidayDateText(h.date)}
              </span>
            </span>
            <Button aria-label={`remove ${h.name}`} disabled={busy} onClick={() => void remove(h)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="date"
          aria-label="holiday date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={input(t)}
        />
        <input
          type="text"
          aria-label="holiday name"
          placeholder="e.g. Diwali"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ ...input(t), flex: 1, minWidth: 120 }}
        />
        <Button
          variant="primary"
          disabled={busy || !date || name.trim() === ''}
          onClick={() => void add()}
        >
          Add holiday
        </Button>
      </div>
    </section>
  );
}
