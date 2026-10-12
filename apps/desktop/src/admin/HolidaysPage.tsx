import { useEffect, useState, type CSSProperties } from 'react';
import { api, type Holiday } from '../api.js';
import { holidayDateText } from '../HolidayEditor.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { DataTable, input, Notice } from './DataTable.js';
import { parseHolidayList, type PastedLine } from './holidayPaste.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: 'Only HR or an Administrator can change holidays.',
  validation: 'A holiday needs a date and a name.',
  invalid_argument: 'A holiday needs a date and a name.',
  not_found: 'That day is no longer a holiday.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

type NoticeState = { kind: 'saved' | 'error'; text: string } | null;

/** Today on this computer, `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const STATUS_TEXT: Record<Exclude<PastedLine['status'], 'invalid'>, string> = {
  new: 'Add',
  rename: 'Rename',
  same: 'Already listed',
};

/**
 * Holidays in the admin console (ADR-0037 §1, ADR-0038 §9): one company
 * list as a table, one holiday at a time or a pasted list, checked and
 * shown before anything is saved. On a holiday nobody is asked to clock
 * in and nobody counts as late. The server checks the role again.
 */
export function HolidaysPage(): JSX.Element {
  const t = useTheme();
  const [list, setList] = useState<Holiday[] | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [mode, setMode] = useState<'none' | 'one' | 'paste'>('none');
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    api.holidays().then(
      (r) => setList(r.holidays),
      (e: unknown) => setNotice({ kind: 'error', text: errorText(String(e)) }),
    );
  };
  useEffect(load, []);

  const remove = (h: Holiday): void => {
    setBusy(true);
    api.removeHoliday(h.date).then(
      () => {
        setBusy(false);
        setRemoving(null);
        setList((l) => l?.filter((x) => x.date !== h.date) ?? null);
        setNotice({ kind: 'saved', text: `${h.name} is no longer a holiday.` });
      },
      (e: unknown) => {
        setBusy(false);
        setRemoving(null);
        setNotice({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  return (
    <section aria-label="holidays" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, flex: 1 }}>Holidays</h2>
        <button type="button" onClick={() => setMode('one')} style={link(t)}>
          Add a holiday
        </button>
        <button type="button" onClick={() => setMode('paste')} style={link(t)}>
          Paste a list
        </button>
      </div>
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      <p style={{ margin: 0, fontSize: 12.5, color: t.muted, lineHeight: 1.45 }}>
        One list for everyone. On a holiday CloudPunch doesn&apos;t ask anyone to clock in, and
        nobody shows as late. Anyone who works that day can still clock in.
      </p>

      {mode === 'one' && (
        <AddOne
          onCancel={() => setMode('none')}
          onSaved={(h) => {
            setMode('none');
            setList((l) =>
              [...(l ?? []).filter((x) => x.date !== h.date), h].sort((a, b) =>
                a.date.localeCompare(b.date),
              ),
            );
            setNotice({ kind: 'saved', text: `${h.name} added.` });
          }}
          onError={(code) => setNotice({ kind: 'error', text: errorText(code) })}
        />
      )}
      {mode === 'paste' && list && (
        <PasteList
          existing={list}
          onCancel={() => setMode('none')}
          onDone={(text, kind) => {
            setMode('none');
            setNotice({ kind, text });
            load();
          }}
        />
      )}

      {!list && !notice && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {list && (
        <DataTable
          label="holidays-table"
          rows={list}
          rowKey={(h) => h.date}
          search={(h) => `${h.name} ${holidayDateText(h.date)}`}
          searchPlaceholder="Find a holiday"
          initialSort={{ key: 'date', dir: 'asc' }}
          empty="No holidays coming up. Add them one by one or paste a list."
          columns={[
            {
              key: 'date',
              label: 'Date',
              nowrap: true,
              render: (h) => holidayDateText(h.date),
              sortText: (h) => h.date,
            },
            { key: 'name', label: 'Name', render: (h) => h.name, sortText: (h) => h.name },
            {
              key: 'remove',
              label: '',
              nowrap: true,
              render: (h) =>
                removing === h.date ? (
                  <span
                    role="group"
                    aria-label={`remove ${h.name}?`}
                    style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                  >
                    <span style={{ fontSize: 12 }}>Remove?</span>
                    <Button variant="chip" disabled={busy} onClick={() => remove(h)}>
                      Yes
                    </Button>
                    <Button variant="chip" disabled={busy} onClick={() => setRemoving(null)}>
                      No
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="chip"
                    aria-label={`remove ${h.name}`}
                    onClick={() => setRemoving(h.date)}
                  >
                    Remove
                  </Button>
                ),
            },
          ]}
        />
      )}
    </section>
  );
}

function AddOne({
  onSaved,
  onCancel,
  onError,
}: {
  onSaved: (h: Holiday) => void;
  onCancel: () => void;
  onError: (code: string) => void;
}): JSX.Element {
  const t = useTheme();
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div role="group" aria-label="add a holiday" style={form(t)}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="date"
          aria-label="holiday date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={input(t)}
        />
        <input
          aria-label="holiday name"
          placeholder="e.g. Diwali"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ ...input(t), flex: 1, minWidth: 140 }}
        />
        <Button
          variant="primary"
          disabled={busy || !date || name.trim() === ''}
          onClick={() => {
            setBusy(true);
            api.setHoliday(date, name.trim()).then(onSaved, (e: unknown) => {
              setBusy(false);
              onError(String(e));
            });
          }}
        >
          Add
        </Button>
        <Button variant="chip" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** "Paste a list": read it, show what it would do, then save it. */
function PasteList({
  existing,
  onDone,
  onCancel,
}: {
  existing: readonly Holiday[];
  onDone: (text: string, kind: 'saved' | 'error') => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const [text, setText] = useState('');
  const [lines, setLines] = useState<PastedLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toSave = (lines ?? []).filter(
    (l): l is Extract<PastedLine, { date: string }> => l.status === 'new' || l.status === 'rename',
  );

  const save = async (): Promise<void> => {
    setBusy(true);
    const failed: string[] = [];
    for (const l of toSave) {
      try {
        await api.setHoliday(l.date, l.name);
      } catch {
        failed.push(l.name);
      }
    }
    const done = toSave.length - failed.length;
    onDone(
      `${done} ${done === 1 ? 'holiday' : 'holidays'} saved.` +
        (failed.length > 0 ? ` Not saved: ${failed.join(', ')}. Try those again.` : ''),
      failed.length > 0 ? 'error' : 'saved',
    );
  };

  return (
    <div role="group" aria-label="paste a list" style={form(t)}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
        One holiday per line, date first:
        <textarea
          aria-label="holiday list"
          rows={6}
          placeholder={'26 Jan, Republic Day\n15 Aug, Independence Day\n2 Oct, Gandhi Jayanti'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setLines(null);
          }}
          style={{ ...input(t), fontFamily: 'inherit', resize: 'vertical' }}
        />
      </label>
      {lines && (
        <table
          aria-label="holiday-preview"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}
        >
          <tbody>
            {lines.map((l) => (
              <tr key={l.line} style={{ borderTop: `1px solid ${t.border}` }}>
                <td style={{ padding: '4px 6px', color: t.muted }}>{l.line}</td>
                {l.status === 'invalid' ? (
                  <>
                    <td style={{ padding: '4px 6px' }}>{l.text}</td>
                    <td style={{ padding: '4px 6px', color: t.danger }}>{l.why}</td>
                  </>
                ) : (
                  <>
                    <td style={{ padding: '4px 6px' }}>
                      {holidayDateText(l.date)} · {l.name}
                      {l.status === 'rename' && (
                        <span style={{ color: t.muted }}> (was {l.was})</span>
                      )}
                    </td>
                    <td
                      style={{
                        padding: '4px 6px',
                        color: l.status === 'same' ? t.muted : t.text,
                      }}
                    >
                      {STATUS_TEXT[l.status]}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {lines === null ? (
          <Button
            variant="primary"
            disabled={text.trim() === ''}
            onClick={() => setLines(parseHolidayList(text, existing, today()))}
          >
            Check
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || toSave.length === 0}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : `Save ${toSave.length}`}
          </Button>
        )}
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
    border: `1px solid ${t.border}`,
    borderRadius: 10,
    background: t.surface,
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
