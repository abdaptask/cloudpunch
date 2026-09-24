import { useState, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { useTheme, type Theme } from './theme.js';

export type ButtonVariant = 'primary' | 'secondary' | 'chip';

function variantStyle(t: Theme, variant: ButtonVariant, hover: boolean): CSSProperties {
  const base: CSSProperties = {
    fontFamily: t.font,
    cursor: 'pointer',
    borderRadius: 10,
    transition: 'background 120ms, border-color 120ms',
  };
  switch (variant) {
    case 'primary':
      return {
        ...base,
        width: '100%',
        padding: '13px 16px',
        fontSize: 15,
        fontWeight: 600,
        border: 'none',
        background: hover ? t.accentHover : t.accent,
        color: t.onAccent,
      };
    case 'secondary':
      return {
        ...base,
        width: '100%',
        padding: '11px 16px',
        fontSize: 14,
        fontWeight: 500,
        border: `1px solid ${hover ? t.muted : t.border}`,
        background: t.surface,
        color: t.text,
      };
    case 'chip':
      return {
        ...base,
        flex: 1,
        padding: '9px 12px',
        fontSize: 13,
        fontWeight: 500,
        borderRadius: 999,
        border: `1px solid ${hover ? t.muted : t.border}`,
        background: hover ? t.surfaceAlt : t.surface,
        color: t.text,
      };
  }
}

export function Button({
  variant = 'secondary',
  style,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): JSX.Element {
  const t = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...variantStyle(t, variant, hover && !disabled),
        ...(disabled ? { opacity: 0.5, cursor: 'default' } : null),
        ...style,
      }}
      {...rest}
    />
  );
}
