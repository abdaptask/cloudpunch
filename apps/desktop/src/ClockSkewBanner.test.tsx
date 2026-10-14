import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClockSkewBanner, skewAmount, skewText, syncHint } from './ClockSkewBanner.js';

describe('clock off warning (owner, 2026-10-14)', () => {
  it('says how far off, which way, and how to fix it on this system', () => {
    expect(skewAmount(150)).toBe('2 min 30 s');
    expect(skewAmount(45)).toBe('45 s');
    expect(skewAmount(120)).toBe('2 min');
    expect(skewAmount(3720)).toBe('1 h 02 min');
    expect(skewText({ ahead: true, seconds: 150 })).toBe(
      "Your computer's clock is 2 min 30 s fast.",
    );
    expect(skewText({ ahead: false, seconds: 300 })).toBe("Your computer's clock is 5 min slow.");
    expect(syncHint(false)).toContain('Settings → Time & language → Date & time → Sync now');
    expect(syncHint(true)).toContain('System Settings → General → Date & Time');
  });

  it('a fast clock warns that time may not be saved', () => {
    render(<ClockSkewBanner skew={{ ahead: true, seconds: 150 }} />);
    const banner = screen.getByRole('alert', { name: 'clock-skew' });
    expect(banner).toHaveTextContent("Your computer's clock is 2 min 30 s fast.");
    expect(banner).toHaveTextContent('may not be able to save your time');
  });
});
