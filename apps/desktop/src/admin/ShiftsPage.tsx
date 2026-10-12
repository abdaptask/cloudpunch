import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ShiftPattern, type ShiftTemplate } from '../api.js';
import { zoneChoices } from '../correctionModel.js';
import { ShiftEditor, shiftText } from '../ShiftEditor.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: 'Only an Administrator can set up shifts.',
  name_taken: 'Another named shift has that name.',
  past_date: 'A shift can change from today on, not before.',
  template_retired: 'That named shift is retired.',
  template_not_found: 'That named shift no longer exists. Reload.',
  validation: 'A named shift needs a name, at least one day, a start and a different end.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** "19 Oct", for a `YYYY-MM-DD`. */
function dayText(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Today on this computer, `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;

/**
 * The admin console's Shifts page (ADR-0038 §6): named shifts, each
 * with how many people are on it. Make one once, give it by name (in
 * People, singly or in bulk); editing it changes it for everyone on it
 * from a chosen date, after showing how many that is. Custom shifts,
 * set person by person, are below.
 */
export function ShiftsPage(): JSX.Element {
  const t = useTheme();
  const [list, setList] = useState<{
    templates: ShiftTemplate[];
    custom: number;
    none: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null: nothing open; 'new'; or the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = (): void => {
    api.adminShiftTemplates().then(
      (r) => {
        setList(r);
        setError(null);
      },
      (e: unknown) => setError(errorText(String(e))),
    );
  };
  useEffect(load, []);

  const active = list?.templates.filter((x) => !x.retired) ?? [];
  const retired = list?.templates.filter((x) => x.retired) ?? [];
  const done = (text: string): void => {
    setEditing(null);
    setStatus(text);
    load();
  };

  return (
    <section aria-label="shifts" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, flex: 1 }}>Shifts</h2>
        {editing !== 'new' && (
          <button
            type="button"
            onClick={() => {
              setStatus(null);
              setEditing('new');
            }}
            style={link(t)}
          >
            New named shift
          </button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: t.muted, lineHeight: 1.45 }}>
        Set up a shift once and give it to people by name in People. Changing it changes it for
        everyone on it, from the date you choose.
      </p>

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          {error}
        </p>
      )}
      {status && (
        <p role="status" style={{ margin: 0, fontSize: 13 }}>
          {status}
        </p>
      )}
      {!list && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}

      {editing === 'new' && (
        <TemplateForm
          onCancel={() => setEditing(null)}
          onSaved={(name) => done(`${name} is set up. Give it to people in People.`)}
        />
      )}

      {list && (
        <ul aria-label="named-shifts" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {active.length === 0 && editing !== 'new' && (
            <li style={{ fontSize: 13, color: t.muted, padding: '6px 0' }}>No named shifts yet.</li>
          )}
          {[...active, ...retired].map((x) => (
            <li
              key={x.id}
              aria-label={`named shift ${x.name}`}
              style={{ borderTop: `1px solid ${t.border}`, padding: '8px 0', fontSize: 13 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, opacity: x.retired ? 0.6 : 1 }}>
                  <strong style={{ fontWeight: 650 }}>{x.name}</strong>
                  {x.retired && <span style={{ color: t.muted }}> · retired</span>}
                  <span style={{ display: 'block', fontSize: 12, color: t.muted }}>
                    {shiftText({ days: x.days, start: x.start, end: x.end, tz_iana: x.tz_iana })}
                  </span>
                  {x.next && (
                    <span style={{ display: 'block', fontSize: 12, color: t.warnText }}>
                      From {dayText(x.next.effective_from)}: {shiftText(x.next)}
                    </span>
                  )}
                </span>
                <span
                  aria-label={`people on ${x.name}`}
                  style={{ fontSize: 12, color: t.muted, whiteSpace: 'nowrap' }}
                >
                  {people(x.people)}
                </span>
                {!x.retired && editing !== x.id && (
                  <>
                    <Button
                      variant="chip"
                      onClick={() => {
                        setStatus(null);
                        setEditing(x.id);
                      }}
                    >
                      Edit
                    </Button>
                    <RetireButton
                      template={x}
                      onDone={() => done(`${x.name} is retired. People on it keep it until moved.`)}
                      onError={(e) => setError(errorText(e))}
                    />
                  </>
                )}
              </div>
              {editing === x.id && (
                <TemplateForm
                  template={x}
                  onCancel={() => setEditing(null)}
                  onSaved={(name, n, from) =>
                    done(
                      `${name} saved. ${people(n)} ${n === 1 ? 'gets' : 'get'} the new shift from ${dayText(from)}.`,
                    )
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {list && (
        <p aria-label="shift-counts" style={{ margin: 0, fontSize: 12.5, color: t.muted }}>
          {people(list.custom)} on a custom shift · {people(list.none)} with no shift
        </p>
      )}
      {/* Custom shifts, one person at a time, as before. */}
      <ShiftEditor title="Each person's shift" />
    </section>
  );
}

function RetireButton({
  template,
  onDone,
  onError,
}: {
  template: ShiftTemplate;
  onDone: () => void;
  onError: (code: string) => void;
}): JSX.Element {
  const t = useTheme();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <Button variant="chip" onClick={() => setAsking(true)}>
        Retire
      </Button>
    );
  }
  return (
    <span role="group" aria-label={`retire ${template.name}`} style={{ display: 'flex', gap: 6 }}>
      <span style={{ fontSize: 12, color: t.warnText, alignSelf: 'center' }}>
        Not offered any more; {people(template.people)} keep it.
      </span>
      <Button
        variant="chip"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          api.adminRetireShiftTemplate(template.id, '').then(onDone, (e: unknown) => {
            setBusy(false);
            onError(String(e));
          });
        }}
      >
        Retire
      </Button>
      <Button variant="chip" disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}

/**
 * A named shift's name and pattern. Editing asks for the date it
 * changes from, then shows how many people that changes before saving.
 */
function TemplateForm({
  template,
  onCancel,
  onSaved,
}: {
  template?: ShiftTemplate;
  onCancel: () => void;
  onSaved: (name: string, people: number, from: string) => void;
}): JSX.Element {
  const t = useTheme();
  const zones = zoneChoices(LOCAL_TZ);
  const [name, setName] = useState(template?.name ?? '');
  const [days, setDays] = useState<number[]>(template?.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(template?.start ?? '09:00');
  const [end, setEnd] = useState(template?.end ?? '18:00');
  const [tz, setTz] = useState(template?.tz_iana ?? 'Asia/Kolkata');
  const [from, setFrom] = useState(today());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Editing: how many it changes, before Apply.
  const [count, setCount] = useState<number | null>(null);

  const pattern: ShiftPattern = { name: name.trim(), days, start, end, tzIana: tz };
  const ready =
    name.trim() !== '' && days.length > 0 && start !== '' && end !== '' && start !== end;
  const fail = (e: unknown): void => {
    setBusy(false);
    setError(errorText(String(e)));
  };
  const changed = (): void => {
    setCount(null);
    setError(null);
  };

  const save = (): void => {
    setBusy(true);
    setError(null);
    if (!template) {
      api
        .adminCreateShiftTemplate(pattern, reason)
        .then(() => onSaved(pattern.name, 0, from), fail);
    } else if (count === null) {
      api.adminSaveShiftTemplate(template.id, pattern, from, reason, true).then((r) => {
        setBusy(false);
        setCount(r.people);
      }, fail);
    } else {
      api
        .adminSaveShiftTemplate(template.id, pattern, from, reason)
        .then((r) => onSaved(pattern.name, r.people, from), fail);
    }
  };

  return (
    <div
      role="group"
      aria-label={template ? `edit ${template.name}` : 'new named shift'}
      style={form(t)}
    >
      <input
        aria-label="shift-name"
        placeholder="Name, e.g. India day"
        value={name}
        maxLength={100}
        onChange={(e) => {
          setName(e.target.value);
          changed();
        }}
        style={input(t)}
      />
      <div
        role="group"
        aria-label="shift-days"
        style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}
      >
        {DAY_NAMES.map((n, i) => {
          const day = i + 1;
          const on = days.includes(day);
          return (
            <Button
              key={n}
              variant="chip"
              aria-pressed={on}
              onClick={() => {
                setDays((d) => (on ? d.filter((x) => x !== day) : [...d, day].sort()));
                changed();
              }}
              style={on ? { borderColor: t.accent, color: t.accent, fontWeight: 650 } : {}}
            >
              {n}
            </Button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          aria-label="shift-start"
          type="time"
          value={start}
          onChange={(e) => {
            setStart(e.target.value);
            changed();
          }}
          style={input(t)}
        />
        <span style={{ fontSize: 13 }}>to</span>
        <input
          aria-label="shift-end"
          type="time"
          value={end}
          onChange={(e) => {
            setEnd(e.target.value);
            changed();
          }}
          style={input(t)}
        />
        <select
          aria-label="shift-zone"
          value={tz}
          onChange={(e) => {
            setTz(e.target.value);
            changed();
          }}
          style={input(t)}
        >
          {zones.map((z) => (
            <option key={z.tz} value={z.tz}>
              {z.label}
            </option>
          ))}
        </select>
      </div>
      {end !== '' && start !== '' && end < start && (
        <span style={{ fontSize: 12, color: t.muted }}>Ends the next morning.</span>
      )}
      {template && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          Changes from
          <input
            aria-label="shift-from"
            type="date"
            value={from}
            min={today()}
            onChange={(e) => {
              setFrom(e.target.value);
              changed();
            }}
            style={input(t)}
          />
        </label>
      )}
      <input
        aria-label="shift-reason"
        placeholder="Why (audit log, optional)"
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        style={input(t)}
      />
      {count !== null && (
        <p role="status" aria-label="shift-preview" style={{ margin: 0, fontSize: 12.5 }}>
          This changes the shift of {people(count)} from {dayText(from)}.
        </p>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.danger }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" disabled={!ready || busy || (!!template && !from)} onClick={save}>
          {!template ? 'Save' : count === null ? 'Check' : 'Apply'}
        </Button>
        <Button variant="chip" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function form(t: Theme): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    marginTop: 8,
    border: `1px solid ${t.border}`,
    borderRadius: 10,
    background: t.surface,
  };
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

function link(t: Theme): CSSProperties {
  return {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.accent,
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
  };
}
