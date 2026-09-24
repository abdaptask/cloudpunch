import { useState, type CSSProperties } from 'react';
import {
  formatClock,
  formatDuration,
  KIND_LABEL,
  sessionsToday,
  today,
  type Segment,
  type SegmentKind,
  type SessionGroup,
} from './timelineModel.js';
import { useTheme } from './ui/theme.js';

/**
 * Day strip, legend, and today's segments grouped by clock-in
 * session. The latest session starts expanded, earlier ones collapsed.
 */
export function TimelineView({
  segments,
  now,
}: {
  segments: readonly Segment[];
  now: number;
}): JSX.Element {
  const t = useTheme();
  const rows = today(segments, now);
  const groups = sessionsToday(segments, now);
  const latest = groups[groups.length - 1]?.session;
  /** User toggles; unset sessions default to "latest is open". */
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  if (rows.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: t.muted }}>
        Nothing tracked yet today. Clock in to start.
      </p>
    );
  }

  const first = Math.min(...rows.map((s) => s.startedAt));
  const last = Math.max(...rows.map((s) => s.endedAt));
  const span = Math.max(1, last - first);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        aria-hidden
        style={{
          position: 'relative',
          height: 10,
          borderRadius: 999,
          background: t.surfaceAlt,
          overflow: 'hidden',
        }}
      >
        {rows.map((s) => (
          <div
            key={`${s.kind}-${s.startedAt}`}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${((s.startedAt - first) / span) * 100}%`,
              width: `${Math.max(0.6, ((s.endedAt - s.startedAt) / span) * 100)}%`,
              background: t.kind[s.kind],
            }}
          />
        ))}
      </div>

      <ul aria-label="legend" style={legend}>
        {[...new Set(rows.map((s) => s.kind))].map((kind: SegmentKind) => (
          <li key={kind} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: 2, background: t.kind[kind] }}
            />
            <span style={{ fontSize: 11, color: t.muted }}>{KIND_LABEL[kind]}</span>
          </li>
        ))}
      </ul>

      <div aria-label="sessions" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {groups.map((g, i) => (
          <SessionBlock
            key={g.session}
            group={g}
            index={i + 1}
            expanded={expanded[g.session] ?? g.session === latest}
            onToggle={() =>
              setExpanded((e) => ({ ...e, [g.session]: !(e[g.session] ?? g.session === latest) }))
            }
          />
        ))}
      </div>
    </div>
  );
}

function SessionBlock({
  group,
  index,
  expanded,
  onToggle,
}: {
  group: SessionGroup;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const t = useTheme();
  const range = `${formatClock(group.startedAt)} – ${group.open ? 'now' : formatClock(group.endedAt)}`;
  return (
    <section style={{ borderTop: `1px solid ${t.border}`, paddingTop: 10 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 0,
          border: 'none',
          background: 'none',
          color: t.text,
          fontFamily: t.font,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span aria-hidden style={{ width: 10, color: t.muted, fontSize: 10 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
          Session {index}
          <span style={{ fontWeight: 400, color: t.muted }}> · {range}</span>
        </span>
        <span style={{ fontSize: 13, color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
          {formatDuration(group.endedAt - group.startedAt)}
        </span>
      </button>
      {expanded && (
        <ol aria-label={`session ${index}`} style={{ ...list, marginTop: 10 }}>
          {group.rows.map((s, i) => {
            const open = group.open && i === group.rows.length - 1;
            return (
              <li key={`${s.kind}-${s.startedAt}`} style={row}>
                <span style={{ ...time, color: t.muted }}>{formatClock(s.startedAt)}</span>
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    flex: 'none',
                    background: t.kind[s.kind],
                  }}
                />
                <span style={{ flex: 1, fontSize: 13 }}>{KIND_LABEL[s.kind]}</span>
                <span style={{ fontSize: 13, color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {open
                    ? `${formatDuration(s.endedAt - s.startedAt)} · now`
                    : formatDuration(s.endedAt - s.startedAt)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
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

const legend: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 14px',
};

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };

const time: CSSProperties = {
  width: 40,
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
};
