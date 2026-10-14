import { useEffect, useState, type CSSProperties } from 'react';
import { api, type InsightEventView, type InsightItem, type StripDay } from '../api.js';
import { localDateOf } from '../dayHistory.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import {
  actionWord,
  ago,
  applyFilter,
  dayText,
  grouped,
  KIND_LABEL,
  lastStep,
  LEGEND_ORDER,
  MARKS,
  NO_FILTER,
  SEVERITY_LABEL,
  summaryLine,
  VIEW_LABEL,
  type InsightFilter,
  type View,
} from './insightsModel.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: "Your role can't see insights.",
  not_found: 'That finding is no longer on your team.',
  closed: 'That finding was already closed.',
  mail_not_configured: "CloudPunch's mailbox isn't set up, so nudges can't go out yet.",
  no_email: 'This person has no work email.',
  validation: 'Write a little more first.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const VIEWS: readonly View[] = ['open', 'serious', 'no_change', 'nudged', 'due'];

const SEVERITY_COLOR: Record<InsightItem['severity'], string> = {
  serious: '#d03b3b',
  warning: '#fab219',
  info: '#898781',
};

/** The 14-day strip: one square per day, glyph + colour, a tooltip each. */
export function Strip({ days, t }: { days: readonly StripDay[]; t: Theme }): JSX.Element {
  const dark = t.mode === 'dark';
  return (
    <div role="img" aria-label={stripLabel(days)} style={{ display: 'flex', gap: 2 }}>
      {days.map((d) => {
        const m = MARKS[d.mark];
        const late = d.mark === 'late' && d.minutes_late ? ` (+${d.minutes_late} min)` : '';
        return (
          <span
            key={d.date}
            title={`${dayText(d.date)}: ${m.label}${late}`}
            style={{
              width: 16,
              height: 16,
              borderRadius: 3,
              background: dark ? m.dark : m.light,
              color: m.ink,
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '16px',
              textAlign: 'center',
              flexShrink: 0,
            }}
          >
            {m.glyph}
          </span>
        );
      })}
    </div>
  );
}

function stripLabel(days: readonly StripDay[]): string {
  const counts = new Map<string, number>();
  for (const d of days) counts.set(MARKS[d.mark].label, (counts.get(MARKS[d.mark].label) ?? 0) + 1);
  return `Last ${days.length} days: ${[...counts.entries()].map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')}`;
}

export function StripLegend({ t }: { t: Theme }): JSX.Element {
  const dark = t.mode === 'dark';
  return (
    <div
      aria-label="strip-legend"
      style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: t.muted }}
    >
      {LEGEND_ORDER.map((k) => {
        const m = MARKS[k];
        return (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: dark ? m.dark : m.light,
                color: m.ink,
                fontSize: 8,
                fontWeight: 700,
                lineHeight: '12px',
                textAlign: 'center',
              }}
            >
              {m.glyph}
            </span>
            {m.label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Reports → Insights (ADR-0047 §4): what needs attention, as cases.
 * The server scopes it (Administrators and HR everyone, a Manager their
 * reports). `compact` for the Team tab in the small window.
 */
export function InsightsInbox({
  compact = false,
  initial,
}: {
  compact?: boolean;
  /** Start filtered (from Trends); read once, so remount (a `key`) to change it. */
  initial?: Partial<InsightFilter>;
}): JSX.Element {
  const t = useTheme();
  const today = localDateOf(Date.now());
  const [closed, setClosed] = useState(false);
  const [items, setItems] = useState<InsightItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<InsightFilter>({ ...NO_FILTER, ...initial });
  const now = Date.now();

  useEffect(() => {
    let current = true;
    setItems(null);
    setError(null);
    api.insights(closed ? 'closed' : 'live').then(
      (r) => {
        if (current) setItems(r.insights);
      },
      (e: unknown) => {
        if (current) setError(errorText(String(e)));
      },
    );
    return () => {
      current = false;
    };
  }, [closed]);

  const all = items ?? [];
  const shown = closed ? all : applyFilter(all, filter, today);
  // What the findings hold, plus whatever Trends asked for, so it can be cleared.
  const managers = [
    ...new Set([
      ...all.map((i) => i.manager_name ?? 'No manager'),
      ...(filter.manager ? [filter.manager] : []),
    ]),
  ].sort();
  const kinds = [...new Set([...all.map((i) => i.kind), ...(filter.kind ? [filter.kind] : [])])];
  /** Replace a finding after an action, so the card shows what happened. */
  const replace = (next: InsightItem): void =>
    setItems((list) => list?.map((i) => (i.id === next.id ? next : i)) ?? null);

  return (
    <section aria-label="insights" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        {!compact && <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Insights</h2>}
        {items && !closed && (
          <span aria-label="insights-summary" style={{ fontSize: 13, color: t.muted }}>
            {summaryLine(all, today)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setClosed((c) => !c)} style={link(t)}>
          {closed ? 'Back to open findings' : 'Show closed'}
        </button>
      </div>

      {!closed && items && all.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <div
            role="tablist"
            aria-label="insight-views"
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
          >
            {VIEWS.map((v) => {
              const n = applyFilter(all, { ...NO_FILTER, view: v }, today).length;
              if (n === 0 && v !== 'open' && filter.view !== v) return null;
              return (
                <Button
                  key={v}
                  role="tab"
                  variant="chip"
                  aria-selected={filter.view === v}
                  onClick={() => setFilter((f) => ({ ...f, view: v }))}
                  style={chipStyle(t, filter.view === v)}
                >
                  {VIEW_LABEL[v]} {n}
                </Button>
              );
            })}
          </div>
          <select
            aria-label="insight-kind"
            value={filter.kind}
            onChange={(e) =>
              setFilter((f) => ({ ...f, kind: e.target.value as InsightFilter['kind'] }))
            }
            style={input(t)}
          >
            <option value="">Every kind</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {!compact && (managers.length > 1 || filter.manager) && (
            <select
              aria-label="insight-team"
              value={filter.manager}
              onChange={(e) => setFilter((f) => ({ ...f, manager: e.target.value }))}
              style={input(t)}
            >
              <option value="">Every team</option>
              {managers.map((m) => (
                <option key={m} value={m}>
                  {m === 'No manager' ? m : `${m}'s team`}
                </option>
              ))}
            </select>
          )}
          <input
            aria-label="insight-search"
            placeholder="Find a person"
            value={filter.q}
            onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
            style={{ ...input(t), flex: 1, minWidth: 140 }}
          />
        </div>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          {error}
        </p>
      )}
      {!items && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Loading…</p>}
      {items && shown.length === 0 && (
        <p style={{ margin: 0, fontSize: 13, color: t.muted }}>
          {closed
            ? 'Nothing closed yet.'
            : all.length === 0
              ? 'Nothing needs attention: no patterns in the last two weeks.'
              : 'Nothing matches these filters.'}
        </p>
      )}
      {items && shown.length > 0 && <StripLegend t={t} />}

      {closed
        ? shown.length > 0 && (
            <ul aria-label="closed-findings" style={list}>
              {shown.map((i) => (
                <InsightCard key={i.id} item={i} now={now} t={t} readOnly onChange={replace} />
              ))}
            </ul>
          )
        : grouped(shown).map(([severity, group]) => (
            <section
              key={severity}
              aria-label={`severity ${severity}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 650, color: t.muted }}>
                <span style={{ color: SEVERITY_COLOR[severity] }}>●</span>{' '}
                {SEVERITY_LABEL[severity]} · {group.length}
              </h3>
              <ul aria-label={`findings ${severity}`} style={list}>
                {group.map((i) => (
                  <InsightCard key={i.id} item={i} now={now} t={t} onChange={replace} />
                ))}
              </ul>
            </section>
          ))}
    </section>
  );
}

type Panel = null | 'nudge' | 'dismiss' | 'history';

/** One finding: who, what, the strip, the last step, and its actions. */
export function InsightCard({
  item,
  now,
  t,
  readOnly = false,
  onChange,
}: {
  item: InsightItem;
  now: number;
  t: Theme;
  readOnly?: boolean;
  onChange: (next: InsightItem) => void;
}): JSX.Element {
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState(item.draft);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const [history, setHistory] = useState<InsightEventView[] | null>(null);
  const strip = item.evidence.strip ?? [];
  const live = item.status === 'open' || item.status === 'nudged';

  const toggle = (p: Panel): void => {
    setStatus(null);
    setPanel((cur) => (cur === p ? null : p));
    if (p === 'history' && history === null) {
      api.insightHistory(item.id).then(
        (r) => setHistory(r.events),
        (e: unknown) => setStatus({ kind: 'error', text: errorText(String(e)) }),
      );
    }
  };

  const nudge = (): void => {
    setBusy(true);
    setStatus(null);
    api.insightNudge(item.id, message).then(
      (r) => {
        setBusy(false);
        setPanel(null);
        setHistory(null);
        setStatus({
          kind: 'saved',
          text: `Sent to ${item.name}. CloudPunch checks again on ${dayText(r.follow_up_on)}.`,
        });
        onChange({
          ...item,
          status: 'nudged',
          no_change: false,
          follow_up_on: r.follow_up_on,
          last: { action: 'nudged', at: new Date().toISOString(), by: 'you', note: message },
        });
      },
      (e: unknown) => {
        setBusy(false);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  const dismiss = (): void => {
    setBusy(true);
    setStatus(null);
    api.insightDismiss(item.id, reason).then(
      () => {
        setBusy(false);
        setPanel(null);
        setStatus({ kind: 'saved', text: 'Dismissed. It stays in Closed with your reason.' });
        onChange({
          ...item,
          status: 'dismissed',
          last: { action: 'dismissed', at: new Date().toISOString(), by: 'you', note: reason },
        });
      },
      (e: unknown) => {
        setBusy(false);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  return (
    <li
      aria-label={`finding ${item.name}: ${item.headline}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        border: `1px solid ${t.border}`,
        borderRadius: 10,
        background: t.surface,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 650 }}>
            {item.name}
            {item.manager_name && (
              <span style={{ fontWeight: 400, color: t.muted }}>
                {' '}
                · {item.manager_name}&apos;s team
              </span>
            )}
          </div>
          <div style={{ fontSize: 13 }}>
            {item.headline}
            {item.no_change && (
              <span style={{ color: t.danger, fontWeight: 600 }}> · no change after nudge</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: t.muted }}>{lastStep(item, now)}</div>
        </div>
        {strip.length > 0 && <Strip days={strip} t={t} />}
      </div>
      {!readOnly && live && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button variant="chip" onClick={() => toggle('nudge')} disabled={busy}>
            {item.status === 'nudged' ? 'Nudge again' : 'Nudge'}
          </Button>
          <Button variant="chip" onClick={() => toggle('dismiss')} disabled={busy}>
            Dismiss
          </Button>
          <Button variant="chip" onClick={() => toggle('history')}>
            History
          </Button>
        </div>
      )}
      {readOnly && (
        <div>
          <Button variant="chip" onClick={() => toggle('history')}>
            History
          </Button>
        </div>
      )}
      {panel === 'nudge' && (
        <div role="group" aria-label={`nudge ${item.name}`} style={panelBox(t)}>
          <span style={{ fontSize: 12, color: t.muted }}>
            To {item.name}, their manager and you copied, from cloudpunch@aptask.com. Edit as you
            like.
          </span>
          <textarea
            aria-label="nudge-message"
            value={message}
            rows={7}
            onChange={(e) => setMessage(e.target.value)}
            style={{ ...input(t), resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="primary" onClick={nudge} disabled={busy || message.trim().length < 10}>
              {busy ? 'Sending…' : 'Send nudge'}
            </Button>
            <Button variant="chip" onClick={() => setPanel(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {panel === 'dismiss' && (
        <div role="group" aria-label={`dismiss ${item.name}`} style={panelBox(t)}>
          <input
            aria-label="dismiss-reason"
            placeholder="Why? e.g. shift was wrong, approved leave"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            style={input(t)}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="primary" onClick={dismiss} disabled={busy || reason.trim().length < 3}>
              Dismiss
            </Button>
            <Button variant="chip" onClick={() => setPanel(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {panel === 'history' && (
        <ol aria-label={`history ${item.name}`} style={{ ...list, gap: 4 }}>
          {history === null && <li style={{ fontSize: 12, color: t.muted }}>Loading…</li>}
          {history?.map((h, n) => (
            <li key={n} style={{ fontSize: 12.5, lineHeight: 1.4 }}>
              <strong style={{ fontWeight: 600 }}>{actionWord(h.action)}</strong>
              <span style={{ color: t.muted }}>
                {' '}
                · {h.by ?? 'CloudPunch'} · {ago(h.at, now)}
              </span>
              {h.note && (
                <div style={{ color: t.muted, whiteSpace: 'pre-wrap' }}>&ldquo;{h.note}&rdquo;</div>
              )}
            </li>
          ))}
        </ol>
      )}
      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          style={{ margin: 0, fontSize: 12.5, color: status.kind === 'error' ? t.danger : t.text }}
        >
          {status.text}
        </p>
      )}
    </li>
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

function chipStyle(t: Theme, on: boolean): CSSProperties | undefined {
  return on ? { background: t.accent, color: t.onAccent, borderColor: t.accent } : undefined;
}

function panelBox(t: Theme): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    background: t.surfaceAlt,
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
