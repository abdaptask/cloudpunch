import type { ReactNode } from 'react';
import { arcPath, clockAngle, dialArcs, polar } from './dialModel.js';
import { KIND_LABEL, type Segment } from './timelineModel.js';
import { useTheme } from './ui/theme.js';

const SIZE = 236;
const C = SIZE / 2;
/** Radius of the day ring. */
const R = 100;
const STROKE = 14;

/**
 * "Your day on a clock" (owner request: something more than a list).
 * Today's segments are drawn as coloured arcs at their real times on a
 * 12-hour face, a hand marks now, and the centre holds the status and
 * the live timer (`children`).
 */
export function DayDial({
  segments,
  now,
  tint,
  hand = true,
  label = 'Today',
  children,
}: {
  segments: readonly Segment[];
  /** End of the 12-hour window: now, or the end of a past day. */
  now: number;
  /** Face colour inside the ring (status tint). */
  tint?: string | undefined;
  /** Draw the "now" hand (not on past days). */
  hand?: boolean;
  /** Day name for screen readers. */
  label?: string;
  children: ReactNode;
}): JSX.Element {
  const t = useTheme();
  const arcs = dialArcs(segments, now);
  const nowAngle = clockAngle(now);
  const [hx, hy] = polar(C, C, R + STROKE / 2 + 4, nowAngle);
  const [hx0, hy0] = polar(C, C, R - STROKE / 2 - 6, nowAngle);
  const labels: [number, string][] = [
    [0, '12'],
    [90, '3'],
    [180, '6'],
    [270, '9'],
  ];
  const kinds = [...new Set(arcs.map((a) => a.kind))];
  return (
    <div style={{ position: 'relative', width: SIZE, height: SIZE, margin: '0 auto' }}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={
          kinds.length === 0
            ? `${label} on a clock: nothing tracked${hand ? ' yet' : ''}`
            : `${label} on a clock: ${kinds.map((k) => KIND_LABEL[k]).join(', ')}`
        }
      >
        {tint && (
          <circle
            aria-label="dial-face"
            data-tint={tint}
            cx={C}
            cy={C}
            r={R - STROKE / 2}
            fill={tint}
            style={{ transition: 'fill 400ms ease' }}
          />
        )}
        {/* Track and hour ticks. */}
        <circle cx={C} cy={C} r={R} fill="none" stroke={t.surfaceAlt} strokeWidth={STROKE} />
        {Array.from({ length: 12 }, (_, i) => {
          const a = i * 30;
          const major = i % 3 === 0;
          const [x1, y1] = polar(C, C, R - STROKE / 2 - 3, a);
          const [x2, y2] = polar(C, C, R - STROKE / 2 - (major ? 9 : 6), a);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={t.muted}
              strokeOpacity={major ? 0.55 : 0.3}
              strokeWidth={major ? 1.6 : 1}
              strokeLinecap="round"
            />
          );
        })}
        {labels.map(([a, text]) => {
          const [x, y] = polar(C, C, R - STROKE / 2 - 19, a);
          return (
            <text
              key={text}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={10}
              fill={t.muted}
              opacity={0.8}
            >
              {text}
            </text>
          );
        })}

        {/* The day. */}
        {arcs.map((a, i) => (
          <path
            key={i}
            d={arcPath(C, C, R, a.from, a.sweep)}
            fill="none"
            stroke={t.kind[a.kind]}
            strokeWidth={STROKE}
            strokeLinecap="butt"
            opacity={a.open ? 1 : 0.9}
          />
        ))}

        {/* Now. */}
        {hand && (
          <>
            <line
              x1={hx0}
              y1={hy0}
              x2={hx}
              y2={hy}
              stroke={t.text}
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0.75}
            />
            <circle cx={hx} cy={hy} r={3} fill={t.text} opacity={0.75} />
          </>
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: STROKE + 30,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: 2,
        }}
      >
        {children}
      </div>
    </div>
  );
}
