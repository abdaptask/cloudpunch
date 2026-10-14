import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ShiftPattern, type ShiftRow, type ShiftTemplate } from '../api.js';
import { zoneChoices } from '../correctionModel.js';
import { ShiftEditor, shiftText } from '../ShiftEditor.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { useNarrow } from '../ui/useNarrow.js';
import { ShiftChooser } from './ShiftChooser.js';

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

/** Named shifts as a table: name, pattern, people, actions (owner: "squished", 2026-10-13). */
const NAMED_COLUMNS = 'minmax(140px, 1fr) minmax(240px, 2fr) 90px minmax(260px, auto)';

/**
 * The admin console's Shifts page (ADR-0038 §6): named shifts, each
 * with how many people are on it. Make one once, give it by name (in
 * People, singly or in bulk); editing it changes it for everyone on it
 * from a chosen date, after showing how many that is. Custom shifts,
 * set person by person, are below.
 */
export function ShiftsPage(): JSX.Element {
  const t = useTheme();
  // A phone: each named shift stacks its cells instead of four columns.
  const narrow = useNarrow();
  const [list, setList] = useState<{
    templates: ShiftTemplate[];
    custom: number;
    none: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null: nothing open; 'new'; or the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  // The named shift being given to people.
  const [giving, setGiving] = useState<string | null>(null);
  // Bumped to reload "Each person's shift" after a change here.
  const [reloads, setReloads] = useState(0);
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
    setGiving(null);
    setStatus(text);
    load();
    setReloads((n) => n + 1);
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
        Set up a shift once, then use <strong>Give to people…</strong> (here, or in People).
        Changing it changes it for everyone on it, from the date you choose.
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
          onSaved={(name) => done(`${name} is set up. Use Give to people… to put people on it.`)}
        />
      )}

      {list && [...active, ...retired].length > 0 && !narrow && (
        <div aria-hidden style={{ ...namedRow(t, false), borderTop: 'none', paddingBottom: 4 }}>
          <span style={headCell(t)}>Name</span>
          <span style={headCell(t)}>Days and hours</span>
          <span style={headCell(t)}>People</span>
          <span />
        </div>
      )}
      {list && (
        <ul aria-label="named-shifts" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {active.length === 0 && editing !== 'new' && (
            <li style={{ fontSize: 13, color: t.muted, padding: '6px 0' }}>No named shifts yet.</li>
          )}
          {[...active, ...retired].map((x) => (
            <li key={x.id} aria-label={`named shift ${x.name}`} style={namedRow(t, narrow)}>
              <span style={{ minWidth: 0, opacity: x.retired ? 0.6 : 1 }}>
                <strong style={{ fontWeight: 650 }}>{x.name}</strong>
                {x.retired && <span style={{ color: t.muted }}> · retired</span>}
              </span>
              <span style={{ minWidth: 0, opacity: x.retired ? 0.6 : 1 }}>
                {shiftText({ days: x.days, start: x.start, end: x.end, tz_iana: x.tz_iana })}
                {x.next && (
                  <span style={{ display: 'block', fontSize: 12, color: t.warnText }}>
                    From {dayText(x.next.effective_from)}: {shiftText(x.next)}
                  </span>
                )}
              </span>
              <span
                aria-label={`people on ${x.name}`}
                style={{ color: t.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
              >
                {people(x.people)}
              </span>
              <span
                style={{
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                }}
              >
                {!x.retired && editing !== x.id && giving !== x.id && (
                  <>
                    <Button
                      variant="primary"
                      onClick={() => {
                        setStatus(null);
                        setEditing(null);
                        setGiving(x.id);
                      }}
                    >
                      Give to people…
                    </Button>
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
              </span>
              {giving === x.id && (
                <GiveShift
                  template={x}
                  onCancel={() => setGiving(null)}
                  onDone={(n, from) =>
                    done(
                      `${people(n)} ${n === 1 ? 'is' : 'are'} on ${x.name}` +
                        (from ? ` from ${dayText(from)}.` : ' from today.'),
                    )
                  }
                  onError={(e) => setError(errorText(e))}
                />
              )}
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
      {/* One person at a time: a named shift or a custom pattern. */}
      <ShiftEditor
        title="Each person's shift"
        reloadKey={reloads}
        editor={(row, saved, cancel) => (
          <ShiftChooser
            employeeId={row.employee_id}
            name={row.name}
            shift={row.shift}
            current={row.template ?? null}
            templates={list?.templates ?? null}
            onCancel={cancel}
            onSaved={(text) => {
              saved();
              setStatus(text);
              load();
            }}
          />
        )}
      />
    </section>
  );
}

/**
 * "Give to people…": put several people on this named shift at once,
 * from a date (today when left empty). People with no shift are offered
 * first; those on another shift on request. One all-or-nothing request
 * (ADR-0038 §5).
 */
function GiveShift({
  template,
  onDone,
  onCancel,
  onError,
}: {
  template: ShiftTemplate;
  onDone: (changed: number, from: string | null) => void;
  onCancel: () => void;
  onError: (code: string) => void;
}): JSX.Element {
  const t = useTheme();
  const [rows, setRows] = useState<ShiftRow[] | null>(null);
  const [q, setQ] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let current = true;
    api.adminShifts().then(
      (r) => {
        if (current) setRows(r.people);
      },
      (e: unknown) => {
        if (current) onError(String(e));
      },
    );
    return () => {
      current = false;
    };
    // Load once; onError only reports.
  }, []);

  const onIt = (r: ShiftRow): boolean => r.template?.id === template.id;
  const needle = q.trim().toLowerCase();
  const offered = (rows ?? [])
    .filter((r) => !onIt(r) && (everyone || !r.shift))
    .filter((r) => !needle || r.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  const withShift = (rows ?? []).filter((r) => !onIt(r) && r.shift).length;
  const toggle = (id: string, on: boolean): void =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const apply = (): void => {
    setBusy(true);
    api.adminBulkShift(key, [...picked], { templateId: template.id }, from || null, '').then(
      (r) => onDone(r.changed.length, from || null),
      (e: unknown) => {
        setBusy(false);
        onError(String(e));
      },
    );
  };

  return (
    <div role="group" aria-label={`give ${template.name}`} style={form(t)}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          aria-label="give-find"
          placeholder="Find a person"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...input(t), flex: 1, minWidth: 140 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          From
          <input
            aria-label="give-from"
            type="date"
            value={from}
            min={today()}
            onChange={(e) => setFrom(e.target.value)}
            style={input(t)}
          />
          <span style={{ color: t.muted }}>{from ? '' : 'today'}</span>
        </label>
      </div>
      {!rows && <span style={{ fontSize: 13, color: t.muted }}>Loading…</span>}
      {rows && (
        <>
          <div style={{ display: 'flex', gap: 12, fontSize: 12.5, flexWrap: 'wrap' }}>
            {offered.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setPicked((p) => new Set([...p, ...offered.map((r) => r.employee_id)]))
                }
                style={link(t)}
              >
                All {offered.length} listed
              </button>
            )}
            {withShift > 0 && (
              <button type="button" onClick={() => setEveryone((e) => !e)} style={link(t)}>
                {everyone
                  ? 'Only people without a shift'
                  : `Also show the ${withShift} on another shift`}
              </button>
            )}
          </div>
          <ul
            aria-label="give-people"
            style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 260, overflowY: 'auto' }}
          >
            {offered.length === 0 && (
              <li style={{ fontSize: 13, color: t.muted }}>
                {needle ? 'Nobody matches.' : 'Everyone else already has a shift.'}
              </li>
            )}
            {offered.map((r) => (
              <li key={r.employee_id}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    aria-label={`give to ${r.name}`}
                    checked={picked.has(r.employee_id)}
                    onChange={(e) => toggle(r.employee_id, e.target.checked)}
                  />
                  <span style={{ flex: 1 }}>{r.name}</span>
                  <span style={{ fontSize: 12, color: t.muted }}>
                    {r.template?.name ?? (r.shift ? 'Custom shift' : 'No shift')}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" disabled={busy || picked.size === 0} onClick={apply}>
          {busy
            ? 'Saving…'
            : picked.size === 0
              ? 'Choose people'
              : `Put ${people(picked.size)} on ${template.name}`}
        </Button>
        <Button variant="chip" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
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

function namedRow(t: Theme, narrow: boolean): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : NAMED_COLUMNS,
    columnGap: 16,
    rowGap: 4,
    alignItems: 'center',
    borderTop: `1px solid ${t.border}`,
    padding: '10px 0',
    fontSize: 13,
  };
}

function headCell(t: Theme): CSSProperties {
  return { fontSize: 12, fontWeight: 600, color: t.muted };
}

function form(t: Theme): CSSProperties {
  return {
    // Under its row, across the whole table.
    gridColumn: '1 / -1',
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
