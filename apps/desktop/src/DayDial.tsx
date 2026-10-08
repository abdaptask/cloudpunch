import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  arcPath,
  clockAngle,
  dialArcs,
  LED_COUNT,
  ledBand,
  secondsLit,
  polar,
} from './dialModel.js';
import { KIND_LABEL, type Segment } from './timelineModel.js';
import { dark, useTheme } from './ui/theme.js';

const SIZE = 236;
const C = SIZE / 2;
/** Radius of the day ring. */
const R = 96;
const STROKE = 13;
/** The seconds LEDs, outside the day ring. */
const LED_R = 110;
/** The glass face: covers the LEDs. */
const FACE_R = 117;

/**
 * "Your day on a clock", as a car-dashboard gauge (owner request):
 * dark glass, today's segments as neon arcs at their real times on a
 * 12-hour face, a 60-LED seconds ring sweeping with the session timer
 * (green; amber past 8h worked, red past 10h), a glowing needle at
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
  elapsed = null,
  hand = true,
  park = false,
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
  /** Time worked today (ms): the seconds ring's colour. */
  worked?: number;
  /** Time on the clock today (ms) while clocked in, or null: seconds ring dark. */
  elapsed?: number | null;
  /** Draw the "now" needle (not on past days). */
  hand?: boolean;
  /** "Engine off": sweep the needle back to 12 (end of a long day). */
  park?: boolean;
  /** Day name for screen readers. */
  label?: string;
  children: ReactNode;
}): JSX.Element {
  const g = useTheme().gauge;
  // SVG ids must be unique per dial; useId's colons don't belong in url().
  const id = useId().replace(/:/g, '');
  const arcs = dialArcs(segments, now);
  const nowAngle = clockAngle(now);
  const needle = useRef<SVGGElement>(null);
  const angleAtPark = useRef(0);
  angleAtPark.current = park ? angleAtPark.current : nowAngle;
  useEffect(() => {
    const el = needle.current;
    if (!park || !el || typeof el.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const anim = el.animate(
      [{ transform: 'rotate(0deg)' }, { transform: `rotate(${-angleAtPark.current}deg)` }],
      { duration: 1600, easing: 'cubic-bezier(.6,0,.2,1)', fill: 'forwards' },
    );
    return () => anim.cancel();
  }, [park]);
  const lit = elapsed === null ? 0 : secondsLit(elapsed);
  const band = ledBand(worked);
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

        {/* Seconds LEDs. */}
        <g aria-label="led-ring" data-lit={lit} data-band={band}>
          {Array.from({ length: LED_COUNT }, (_, i) => {
            const a = (i + 0.5) * (360 / LED_COUNT);
            const [x, y] = polar(C, C, LED_R, a);
            const on = i < lit;
            return (
              <circle
                key={i}
                cx={x}
                cy={y}
                r={1.7}
                fill={on ? g.led[band] : g.unlit}
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
          <g
            ref={needle}
            filter={`url(#${id}-neon)`}
            aria-label="needle"
            data-parked={park}
            style={{ transformOrigin: `${C}px ${C}px`, transformBox: 'view-box' }}
          >
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
