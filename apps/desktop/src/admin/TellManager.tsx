import { useEffect, useState, type CSSProperties } from 'react';
import {
  api,
  type ManagerNoteView,
  type NoteSummary,
  type NoteTopic,
  type PersonNotes,
} from '../api.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';

/**
 * Tell manager (ADR-0055): HR or an Administrator writes to a person's
 * manager about them, with their last 14 days attached. Only the
 * manager gets it (the sender is copied); the person never sees it.
 * CloudPunch follows up 14 days later. Used in the person panel, in
 * Team and on Insights findings.
 */

export const TOPICS: readonly NoteTopic[] = ['activity', 'timings', 'breaks', 'missed'];

export const TOPIC_LABEL: Record<NoteTopic, string> = {
  activity: 'Activity level',
  timings: 'Start and finish times',
  breaks: 'Breaks',
  missed: 'Missed days',
};

const VERDICT_LABEL: Record<string, string> = {
  improved: 'Improved',
  no_change: 'No change',
  worse: 'Worse',
};

const BLOCKED_TEXT: Record<Exclude<PersonNotes['blocked'], null>, string> = {
  no_manager: 'Set a manager first: this person has no manager to tell.',
  inactive: 'This person is deactivated.',
  self: "You can't send a note about yourself.",
  own_manager: "You're their manager, so there's no one to tell.",
};

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again.',
  forbidden: 'Only HR and Administrators can send these.',
  mail_not_configured: "CloudPunch's mailbox isn't set up, so notes can't go out yet.",
  no_manager: 'This person has no manager now.',
  own_manager: "You're their manager.",
  no_email: 'Their manager has no work email.',
  validation: 'Pick at least one topic and write at least 10 characters.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const first = (name: string): string => name.split(' ')[0] || name;

/** "7h 05m". */
function hm(ms: number): string {
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${String(min % 60).padStart(2, '0')}m` : `${min % 60}m`;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 25 Nov" for `YYYY-MM-DD`; spelled out here, so every platform says the same. */
export function dayText(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return `${WEEKDAY[at.getUTCDay()]} ${at.getUTCDate()} ${MONTH[at.getUTCMonth()]}`;
}

/** "11 Nov", on this computer's calendar. */
const whenText = (iso: string): string => {
  const at = new Date(iso);
  return `${at.getDate()} ${MONTH[at.getMonth()]}`;
};

/** One line: "On time 6 of 9 · 61h of 72h · idle 8% · 2 long breaks · 1 missed". */
export function summaryLine(s: NoteSummary): string {
  const parts = [
    s.shift_days > 0 ? `On time ${s.on_time} of ${s.shift_days} shift days` : 'No shift days',
    `${hm(s.worked_ms)} worked${s.scheduled_ms > 0 ? ` of ${hm(s.scheduled_ms)}` : ''}`,
    s.worked_ms > 0 ? `idle ${Math.round((s.idle_ms / s.worked_ms) * 100)}%` : null,
    s.breaks_over > 0 ? `${s.breaks_over} long ${s.breaks_over === 1 ? 'break' : 'breaks'}` : null,
    s.missed > 0 ? `${s.missed} missed` : null,
  ];
  return parts.filter((p): p is string => p !== null).join(' · ');
}

/** The starting text, from the topics and the numbers; editable. */
export function draftNote(
  manager: string,
  person: string,
  topics: readonly NoteTopic[],
  s: NoteSummary | null,
): string {
  const what = topics.map((t) => TOPIC_LABEL[t].toLowerCase());
  const list =
    what.length <= 1 ? (what[0] ?? '') : `${what.slice(0, -1).join(', ')} and ${what.at(-1)}`;
  const facts: string[] = [];
  if (s) {
    if (topics.includes('timings') && s.shift_days > 0) {
      facts.push(`started on time on ${s.on_time} of ${s.shift_days} shift days`);
    }
    if (topics.includes('activity') && s.worked_ms > 0) {
      facts.push(
        `was idle for ${Math.round((s.idle_ms / s.worked_ms) * 100)}% of their worked time`,
      );
    }
    if (topics.includes('breaks') && s.breaks_over > 0) {
      facts.push(`went over their break limit ${s.breaks_over} times`);
    }
    if (topics.includes('missed') && s.missed > 0) {
      facts.push(`missed ${s.missed} shift ${s.missed === 1 ? 'day' : 'days'}`);
    }
  }
  const p = first(person);
  return [
    `Hi ${first(manager)},`,
    '',
    `Please keep an eye on ${p}'s ${list || 'attendance'}.` +
      (facts.length > 0
        ? ` In the last two weeks ${p} ${facts.length === 1 ? facts[0] : `${facts.slice(0, -1).join(', ')} and ${facts.at(-1)}`}.`
        : ''),
    '',
    `Could you check in with ${p} and let me know how it goes?`,
  ].join('\n');
}

/** A sent note, for the lists: when, who, what, seen, follow-up. */
export function NoteLine({
  note,
  t,
  showManager = true,
}: {
  note: ManagerNoteView;
  t: Theme;
  showManager?: boolean;
}): JSX.Element {
  const verdict = note.follow_up ? (VERDICT_LABEL[note.follow_up.verdict] ?? '') : null;
  return (
    <li style={{ fontSize: 12.5, lineHeight: 1.45 }}>
      <div>
        <strong style={{ fontWeight: 600 }}>{whenText(note.sent_at)}</strong>
        <span style={{ color: t.muted }}>
          {' '}
          · {note.sent_by ?? 'Someone'}
          {showManager && ` to ${note.manager_name}`} ·{' '}
          {note.topics.map((x) => TOPIC_LABEL[x]).join(', ')}
        </span>
      </div>
      <div style={{ color: t.muted, whiteSpace: 'pre-wrap' }}>&ldquo;{note.message}&rdquo;</div>
      <div style={{ color: t.muted }}>
        {note.seen_at ? `Seen ${whenText(note.seen_at)}` : 'Not marked seen yet'}
        {' · '}
        {verdict ? (
          <span
            style={{
              fontWeight: 600,
              color:
                note.follow_up?.verdict === 'improved'
                  ? t.go
                  : note.follow_up?.verdict === 'worse'
                    ? t.danger
                    : t.text,
            }}
          >
            Follow-up: {verdict}
          </span>
        ) : (
          `Follow-up ${dayText(note.follow_up_on)}`
        )}
      </div>
    </li>
  );
}

/** The person panel's part (and the Team and Insights button). */
export function TellManagerPart({
  employeeId,
  name,
  startOpen = false,
  onSent,
}: {
  employeeId: string;
  name: string;
  /** Opened from the table's icon or a "Tell manager" button: straight to the form. */
  startOpen?: boolean;
  onSent?: (note: ManagerNoteView) => void;
}): JSX.Element {
  const t = useTheme();
  const [info, setInfo] = useState<PersonNotes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(startOpen);
  const [topics, setTopics] = useState<NoteTopic[]>(['activity', 'timings']);
  const [message, setMessage] = useState('');
  // The draft follows the topics until it's edited.
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let current = true;
    setInfo(null);
    setError(null);
    api.adminManagerNotes(employeeId).then(
      (r) => {
        if (current) setInfo(r);
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
      },
    );
    return () => {
      current = false;
    };
  }, [employeeId]);

  const manager = info?.manager ?? null;
  useEffect(() => {
    if (!edited && manager)
      setMessage(draftNote(manager.name, name, topics, info?.summary ?? null));
  }, [edited, manager, name, topics, info?.summary]);

  if (error) {
    return (
      <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.danger }}>
        {error}
      </p>
    );
  }
  if (!info) return <span style={{ fontSize: 12.5, color: t.muted }}>Loading…</span>;

  const send = (): void => {
    if (!manager) return;
    setBusy(true);
    setStatus(null);
    api.adminSendManagerNote(employeeId, topics, message).then(
      (note) => {
        setBusy(false);
        setOpen(false);
        setEdited(false);
        setInfo((i) => (i ? { ...i, notes: [note, ...i.notes] } : i));
        setStatus({
          kind: 'saved',
          text: `Sent to ${manager.name}. CloudPunch follows up on ${dayText(note.follow_up_on)}.`,
        });
        onSent?.(note);
      },
      (e: unknown) => {
        setBusy(false);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  const ok = topics.length > 0 && message.trim().length >= 10;
  return (
    <div
      role="group"
      aria-label={`tell manager about ${name}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {info.blocked ? (
        <span style={{ fontSize: 12.5, color: t.warnText }}>{BLOCKED_TEXT[info.blocked]}</span>
      ) : !open ? (
        <Button
          variant="secondary"
          onClick={() => {
            setStatus(null);
            setOpen(true);
          }}
          style={{ alignSelf: 'flex-start', width: 'auto' }}
        >
          Tell {manager ? first(manager.name) : 'their manager'}…
        </Button>
      ) : (
        <div style={box(t)}>
          <span style={{ fontSize: 12, color: t.muted, lineHeight: 1.4 }}>
            To {manager?.name} only, from cloudpunch@aptask.com, with you copied. {first(name)}{' '}
            doesn&apos;t see it.
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
            {TOPICS.map((topic) => (
              <label
                key={topic}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}
              >
                <input
                  type="checkbox"
                  aria-label={`note-topic-${topic}`}
                  checked={topics.includes(topic)}
                  disabled={busy}
                  onChange={(e) =>
                    setTopics((ts) =>
                      e.target.checked
                        ? TOPICS.filter((x) => x === topic || ts.includes(x))
                        : ts.filter((x) => x !== topic),
                    )
                  }
                />
                {TOPIC_LABEL[topic]}
              </label>
            ))}
          </div>
          {info.summary && (
            <span aria-label="note-summary" style={{ fontSize: 12, color: t.muted }}>
              Last {info.follow_up_days} days: {summaryLine(info.summary)}. The email lists each
              day.
            </span>
          )}
          <textarea
            aria-label="note-message"
            value={message}
            rows={7}
            maxLength={2000}
            disabled={busy}
            onChange={(e) => {
              setEdited(true);
              setMessage(e.target.value);
            }}
            style={input(t)}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              disabled={!ok || busy}
              onClick={send}
              style={{ width: 'auto' }}
            >
              {busy ? 'Sending…' : `Send to ${manager ? first(manager.name) : 'manager'}`}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
              style={{ width: 'auto' }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          style={{
            margin: 0,
            fontSize: 12.5,
            color: status.kind === 'error' ? t.danger : t.text,
          }}
        >
          {status.text}
        </p>
      )}
      {info.notes.length > 0 && (
        <ul aria-label={`notes about ${name}`} style={list}>
          {info.notes.map((n) => (
            <NoteLine key={n.id} note={n} t={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// The manager's side (ADR-0055 §3)

/** Notes addressed to me; reload after marking one seen. */
export function useManagerNotes(enabled: boolean): {
  notes: ManagerNoteView[];
  markSeen: (id: string) => Promise<void>;
} {
  const [notes, setNotes] = useState<ManagerNoteView[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api.teamManagerNotes().then(
      (r) => {
        if (current) setNotes(r.notes);
      },
      // An older server, or none for me: nothing to show.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [enabled]);
  const markSeen = async (id: string): Promise<void> => {
    const r = await api.teamManagerNoteSeen(id);
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, seen_at: n.seen_at ?? r.seen_at } : n)));
  };
  return { notes, markSeen };
}

/** One note to the manager, with "Seen, I'll follow up". */
export function NoteForManager({
  note,
  onOpen,
  onSeen,
}: {
  note: ManagerNoteView;
  /** Open the person in Team; left out on their own page. */
  onOpen?: () => void;
  onSeen: () => Promise<void>;
}): JSX.Element {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      role="note"
      aria-label={`note about ${note.name}`}
      style={{
        ...box(t),
        borderColor: note.seen_at ? t.border : t.warnText,
        background: note.seen_at ? t.surfaceAlt : t.warnBg,
      }}
    >
      <span style={{ fontSize: 13, lineHeight: 1.45 }}>
        <strong>{note.sent_by ?? 'HR'}</strong> asked you to keep an eye on{' '}
        <strong>{note.name}</strong>:{' '}
        {note.topics.map((x) => TOPIC_LABEL[x].toLowerCase()).join(', ')}.{' '}
        <span style={{ color: t.muted }}>{whenText(note.sent_at)}</span>
      </span>
      <span style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
        {note.message}
      </span>
      {note.summary && (
        <span style={{ fontSize: 12, color: t.muted }}>
          Their 14 days then: {summaryLine(note.summary)}.
        </span>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {onOpen && (
          <Button variant="secondary" onClick={onOpen} style={{ width: 'auto' }}>
            Open {first(note.name)}
          </Button>
        )}
        {note.seen_at ? (
          <span style={{ fontSize: 12.5, color: t.muted }}>
            Seen {whenText(note.seen_at)} ·{' '}
            {note.follow_up
              ? `Follow-up: ${VERDICT_LABEL[note.follow_up.verdict] ?? ''}`
              : `CloudPunch follows up on ${dayText(note.follow_up_on)}`}
          </span>
        ) : (
          <Button
            variant="primary"
            disabled={busy}
            style={{ width: 'auto' }}
            onClick={() => {
              setBusy(true);
              setError(null);
              onSeen().then(
                () => setBusy(false),
                (e: unknown) => {
                  setBusy(false);
                  setError(errorText(String(e)));
                },
              );
            }}
          >
            {busy ? 'Saving…' : "Seen, I'll follow up"}
          </Button>
        )}
      </div>
      {error && (
        <span role="alert" style={{ fontSize: 12.5, color: t.danger }}>
          {error}
        </span>
      )}
    </div>
  );
}

const list: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

function box(t: Theme): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    border: `1px solid ${t.border}`,
    background: t.surfaceAlt,
  };
}

function input(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.45,
    padding: '6px 8px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.text,
    resize: 'vertical',
  };
}
