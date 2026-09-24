import { useState } from 'react';
import { useTheme } from './theme.js';

/**
 * "Sign in with Microsoft" per Microsoft's identity-platform branding
 * guidelines: the four-square logo, Segoe UI Semibold 15px, 41px tall,
 * square corners; light (#FFFFFF, border #8C8C8C, text #5E5E5E) or dark
 * (#2F2F2F, text #FFFFFF) to match the app theme. The label stays
 * "Sign in with Microsoft"; progress is shown next to the button.
 */
export function MicrosoftSignInButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  const t = useTheme();
  const [hover, setHover] = useState(false);
  const dark = t.mode === 'dark';
  const base = dark ? '#2F2F2F' : '#FFFFFF';
  const hovered = dark ? '#3A3A3A' : '#F3F3F3';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        width: '100%',
        height: 41,
        padding: '0 12px',
        border: dark ? '1px solid #2F2F2F' : '1px solid #8C8C8C',
        borderRadius: 0,
        background: hover && !disabled ? hovered : base,
        color: dark ? '#FFFFFF' : '#5E5E5E',
        fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: 15,
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <MicrosoftLogo />
      Sign in with Microsoft
    </button>
  );
}

/** The Microsoft four-square logo, 21×21. */
export function MicrosoftLogo(): JSX.Element {
  return (
    <svg width="21" height="21" viewBox="0 0 21 21" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}
