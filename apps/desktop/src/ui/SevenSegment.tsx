/**
 * Seven-segment readout drawn in SVG, so no font file ships. Digits and
 * `:` only; anything else is a blank cell. Unlit segments show faintly,
 * like a real display. The text stays in the DOM for screen readers
 * and tests; the drawing is hidden from them.
 */

//   a
//  f b
//   g
//  e c
//   d
const DIGITS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcfgd',
};

const W = 14; // digit cell width
const H = 26; // digit cell height
const T = 3; // segment thickness
const GAP = 3; // between cells
const COLON = 6; // colon cell width

/** A horizontal or vertical bar with bevelled ends. */
function bar(x: number, y: number, len: number, horizontal: boolean): string {
  const h = T / 2;
  return horizontal
    ? `M${x + h} ${y}h${len - T}l${h} ${h}l${-h} ${h}h${-(len - T)}l${-h} ${-h}z`
    : `M${x} ${y + h}l${h} ${-h}l${h} ${h}v${len - T}l${-h} ${h}l${-h} ${-h}z`;
}

function segments(x: number): Record<string, string> {
  const half = H / 2;
  return {
    a: bar(x + 1, 0, W - 2, true),
    b: bar(x + W - T, 1, half - 1, false),
    c: bar(x + W - T, half, half - 1, false),
    d: bar(x + 1, H - T, W - 2, true),
    e: bar(x, half, half - 1, false),
    f: bar(x, 1, half - 1, false),
    g: bar(x + 1, half - T / 2, W - 2, true),
  };
}

export function SevenSegment({
  text,
  color,
  unlit,
  height = H,
  glow = true,
}: {
  text: string;
  color: string;
  unlit: string;
  /** Rendered height in px; the width follows. */
  height?: number;
  glow?: boolean;
}): JSX.Element {
  const cells: JSX.Element[] = [];
  let x = 0;
  [...text].forEach((ch, i) => {
    if (ch === ':') {
      cells.push(
        <g key={i} fill={color}>
          <rect x={x + 1.5} y={H * 0.3 - 1.5} width={3} height={3} rx={0.6} />
          <rect x={x + 1.5} y={H * 0.7 - 1.5} width={3} height={3} rx={0.6} />
        </g>,
      );
      x += COLON + GAP;
      return;
    }
    const on = DIGITS[ch] ?? '';
    const segs = segments(x);
    cells.push(
      <g key={i}>
        {Object.entries(segs).map(([name, d]) => (
          <path key={name} d={d} fill={on.includes(name) ? color : unlit} />
        ))}
      </g>,
    );
    x += W + GAP;
  });
  const width = Math.max(0, x - GAP);
  return (
    <span style={{ display: 'inline-block', lineHeight: 0 }}>
      <svg
        aria-hidden
        width={(width / H) * height}
        height={height}
        viewBox={`0 0 ${width} ${H}`}
        style={{
          overflow: 'visible',
          filter: glow ? `drop-shadow(0 0 3px ${color})` : undefined,
        }}
      >
        <g transform="skewX(-6)" style={{ transformOrigin: 'center' }}>
          {cells}
        </g>
      </svg>
      <span style={VISUALLY_HIDDEN}>{text}</span>
    </span>
  );
}

const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;
