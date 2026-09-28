import { useId, type ReactNode } from 'react';
import { arcPath, clockAngle, dialArcs, LED_COUNT, ledBand, ledsLit, polar } from './dialModel.js';
import { KIND_LABEL, type Segment } from './timelineModel.js';
import { dark, useTheme } from './ui/theme.js';

const SIZE = 236;
const C = SIZE / 2;
/** Radius of the day ring. */
const R = 96;
const STROKE = 13;
/** The rev-counter LEDs, outside the day ring. */
const LED_R = 110;
/** The glass face: covers the LEDs. */
const FACE_R = 117;

/**
 * "Your day on a clock", as a car-dashboard gauge (owner request):
 * dark glass, today's segments as neon arcs at their real times on a
 * 12-hour face, a rev-counter LED ring filling with time worked (one
 * LED per 15 minutes; amber past 8h, red past 10h), a glowing needle at
 * now, and the status as an ambient glow. The centre holds the status
 * and the timer (`children`).
 *
 * The gauge is dark in both themes, like an instrument cluster, so its
 * neon colours come from the dark theme.
 */
export function DayDial({
  segments,
  now,
  tint,
  glow,
  worked = 0,
  hand = true,
  label = 'Today',
  children,
}: {
  segments: readonly Segment[];
  /** End of the 12-hour window: now, or the end of a past day. */
  now: number;
  /** Status tint (kept on the face for tests and screen tools). */
  tint?: string | undefined;
  /** Ambient glow colour for the status. */
  glow?: string | undefined;
  /** Time worked today, for the LED ring (ms). */
  worked?: number;
  /** Draw the "now" needle (not on past days). */
  hand?: boolean;
  /** Day name for screen readers. */
  label?: string;
  children: ReactNode;
}): JSX.Element {
  const g = useTheme().gauge;
  // SVG ids must be unique per dial; useId's colons don't belong in url().
  const id = useId().replace(/:/g, '');
  const arcs = dialArcs(segments, now);
  const nowAngle = clockAngle(now);
  const lit = ledsLit(worked);
  const labels: [number, string][] = [
    [0, '12'],
    [90, '3'],
    [180, '6'],
    [270, '9'],
  ];
  const kinds = [...new Set(arcs.map((a) => a.kind))];
  // Tapered needle near the rim, so it never crosses the readout.
  const [tipX, tipY] = polar(C, C, R + STROKE / 2 + 3, nowAngle);
  const [lX, lY] = polar(C, C, R - STROKE / 2 - 14, nowAngle - 3.2);
  const [rX, rY] = polar(C, C, R - STROKE / 2 - 14, nowAngle + 3.2);
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
        <defs>
          <radialGradient id={`${id}-glass`} cx="50%" cy="38%" r="70%">
            <stop offset="0%" stopColor={g.face} />
            <stop offset="100%" stopColor={g.faceEdge} />
          </radialGradient>
          <radialGradient id={`${id}-ambient`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glow ?? g.glow.off} stopOpacity={0.34} />
            <stop offset="70%" stopColor={glow ?? g.glow.off} stopOpacity={0.08} />
            <stop offset="100%" stopColor={glow ?? g.glow.off} stopOpacity={0} />
          </radialGradient>
          <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.1} />
            <stop offset="45%" stopColor="#ffffff" stopOpacity={0} />
          </linearGradient>
          <filter id={`${id}-neon`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Glass, rim and the status glow. */}
        <circle cx={C} cy={C} r={FACE_R} fill={`url(#${id}-glass)`} />
        <circle cx={C} cy={C} r={FACE_R - 0.75} fill="none" stroke={g.rim} strokeWidth={1.5} />
        <circle
          aria-label="dial-face"
          data-tint={tint}
          cx={C}
          cy={C}
          r={R - STROKE / 2}
          fill={`url(#${id}-ambient)`}
          style={{ transition: 'fill 400ms ease' }}
        />

        {/* Rev-counter LEDs. */}
        <g aria-label="led-ring" data-lit={lit}>
          {Array.from({ length: LED_COUNT }, (_, i) => {
            const a = (i + 0.5) * (360 / LED_COUNT);
            const [x, y] = polar(C, C, LED_R, a);
            const on = i < lit;
            return (
              <circle
                key={i}
                cx={x}
                cy={y}
                r={2}
                fill={on ? g.led[ledBand(i)] : g.unlit}
                filter={on ? `url(#${id}-neon)` : undefined}
              />
            );
          })}
        </g>

        {/* Track, hour ticks and numerals. */}
        <circle cx={C} cy={C} r={R} fill="none" stroke={g.unlit} strokeWidth={STROKE} />
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
              stroke={g.dim}
              strokeOpacity={major ? 0.7 : 0.4}
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
              fontWeight={600}
              fill={g.dim}
            >
              {text}
            </text>
          );
        })}

        {/* The day, in neon. */}
        <g filter={`url(#${id}-neon)`}>
          {arcs.map((a, i) => (
            <path
              key={i}
              data-arc={a.kind}
              d={arcPath(C, C, R, a.from, a.sweep)}
              fill="none"
              stroke={dark.kind[a.kind]}
              strokeWidth={STROKE - 3}
              strokeLinecap="butt"
              opacity={a.open ? 1 : 0.88}
            />
          ))}
        </g>

        {/* Now. */}
        {hand && (
          <g filter={`url(#${id}-neon)`} aria-label="needle">
            <path
              d={`M ${lX.toFixed(2)} ${lY.toFixed(2)} L ${tipX.toFixed(2)} ${tipY.toFixed(2)} L ${rX.toFixed(2)} ${rY.toFixed(2)} Z`}
              fill={g.needle}
            />
          </g>
        )}

        {/* Glass sheen over everything. */}
        <circle cx={C} cy={C} r={FACE_R - 2} fill={`url(#${id}-sheen)`} pointerEvents="none" />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: STROKE + 34,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: 3,
          color: g.text,
        }}
      >
        {children}
      </div>
    </div>
  );
}
