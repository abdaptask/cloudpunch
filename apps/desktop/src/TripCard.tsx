import { useEffect, useRef, useState } from 'react';
import { odometer, tripLine, type TripSummary } from './tripModel.js';
import { Button } from './ui/Button.js';
import { SevenSegment } from './ui/SevenSegment.js';
import { useTheme } from './ui/theme.js';

/** How long the odometer takes to roll up (ms). */
const ROLL_MS = 1400;

/** Motion is on unless the OS asks for less, or can't animate (tests). */
export function motionOk(): boolean {
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') {
    return false;
  }
  return !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}

/** Counts from 0 up to `target` over ROLL_MS; `target` at once without motion. */
function useRollUp(target: number, animate: boolean): number {
  const [value, setValue] = useState(animate ? 0 : target);
  useEffect(() => {
    if (!animate) {
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(t) {
      const p = Math.min(1, (t - start) / ROLL_MS);
      // Ease out, like a dial settling.
      setValue(target * (1 - (1 - p) ** 3));
      if (p < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, animate]);
  return value;
}

/**
 * End-of-day summary (ADR-0013 §8). A long day: "Trip complete" with the
 * worked total rolling up on an odometer, while the dial's needle
 * parks. A shorter day: a quiet one-line card. Web Animations only (the
 * CSP blocks <style>, so no CSS keyframes); honours reduced motion.
 */
export function TripCard({
  trip,
  signedOut,
  onDone,
}: {
  trip: TripSummary;
  /** Shown at sign-out rather than clock-out. */
  signedOut: boolean;
  onDone: () => void;
}): JSX.Element {
  const t = useTheme();
  const g = t.gauge;
  const animate = motionOk();
  const rolled = useRollUp(trip.worked, animate && trip.long);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!animate || !ref.current) return;
    const anim = ref.current.animate(
      [
        { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
    return () => anim.cancel();
  }, [animate]);

  if (!trip.long) {
    return (
      <div
        ref={ref}
        role="status"
        aria-label="day-summary"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 12,
          background: t.surface,
          border: `1px solid ${t.border}`,
          fontSize: 13,
          color: t.text,
        }}
      >
        <span style={{ flex: 1 }}>
          {signedOut ? 'Signed out' : 'Clocked out'} · {tripLine(trip)} today
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDone}
          style={{
            border: 'none',
            background: 'none',
            color: t.muted,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="trip-complete"
      style={{
        padding: '16px 16px 14px',
        borderRadius: 16,
        background: `radial-gradient(120% 90% at 50% 0%, ${g.face}, ${g.faceEdge})`,
        border: `1px solid ${g.rim}`,
        boxShadow: `0 10px 30px rgba(0, 0, 0, 0.25), inset 0 0 0 1px rgba(255,255,255,0.03)`,
        color: g.text,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 2.4,
          textTransform: 'uppercase',
          color: g.led.normal,
          textShadow: `0 0 8px ${g.led.normal}`,
        }}
      >
        Trip complete
      </div>
      <div aria-label="odometer" style={{ margin: '10px 0 4px' }}>
        <SevenSegment text={odometer(rolled)} color={g.text} unlit={g.unlit} height={34} />
      </div>
      <div style={{ fontSize: 10, letterSpacing: 1.2, color: g.dim, textTransform: 'uppercase' }}>
        hours · minutes
      </div>
      <div aria-label="trip-line" style={{ marginTop: 10, fontSize: 13, fontWeight: 600 }}>
        {tripLine(trip)}
      </div>
      <div style={{ marginTop: 2, fontSize: 12, color: g.dim }}>
        {signedOut ? 'Signed out' : 'Engine off'} · See you tomorrow
      </div>
      <Button variant="secondary" onClick={onDone} style={{ marginTop: 12 }}>
        Done
      </Button>
    </div>
  );
}
