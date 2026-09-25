import type { CSSProperties } from 'react';
import { Logo } from './ui/Logo.js';
import { MicrosoftSignInButton } from './ui/MicrosoftSignInButton.js';
import { useTheme, type Theme } from './ui/theme.js';

const ERROR_TEXT: Record<string, string> = {
  timed_out: 'Sign-in timed out. Please try again.',
  denied: 'Sign-in was cancelled.',
  network: "Couldn't reach Microsoft. Check your connection and try again.",
  rejected: 'Microsoft rejected the sign-in. Please try again.',
  browser: "Couldn't open your browser.",
  keystore: "Couldn't save your sign-in securely on this computer. Please try again.",
};

/** Brand colours (docs/brand/README.md). */
const NAVY = '#012456';
const BLUE = '#018AFE';
const TEAL = '#00BFB5';

/** What the app really does today; shown as trust points under the button. */
const POINTS = ['Single sign-on', 'Encrypted on this device', 'Works offline'];

/** Shown until the user signs in with their ApTask Microsoft account. */
export function SignIn({
  busy,
  error,
  onSignIn,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const small: CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: t.muted };
  const link: CSSProperties = {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.accent,
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
  };
  const dark = t.mode === 'dark';
  return (
    <section
      aria-label="sign-in"
      style={{
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: dark
          ? '0 12px 32px rgba(0,0,0,.45)'
          : '0 12px 32px rgba(1,36,86,.10), 0 2px 6px rgba(1,36,86,.06)',
        textAlign: 'center',
      }}
    >
      {/* Brand bar. */}
      <div
        aria-hidden
        style={{ height: 5, background: `linear-gradient(90deg, ${NAVY}, ${BLUE} 70%, ${TEAL})` }}
      />

      <div
        style={{
          padding: '26px 28px 22px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 2.4,
              textTransform: 'uppercase',
              color: t.muted,
            }}
          >
            Welcome to
          </h2>
          <Logo height={84} />
          <p style={{ margin: 0, fontSize: 13, color: t.muted, letterSpacing: 0.2 }}>
            Time &amp; attendance for ApTask
          </p>
        </div>

        <div style={{ height: 1, background: t.border }} />

        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: t.text }}>
          Sign in with your ApTask work account to start tracking your time.
        </p>

        <MicrosoftSignInButton onClick={onSignIn} disabled={busy} />

        <p role="status" style={{ ...small, minHeight: 18 }}>
          {busy
            ? 'A browser window has opened. Finish signing in there, then come back here.'
            : 'Sign-in opens in your browser, where your organisation’s security checks apply.'}
        </p>

        {busy && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 18 }}>
            {/* Closed the tab, or it never appeared: start over. */}
            <button type="button" onClick={onSignIn} style={link}>
              Open the browser again
            </button>
            <button type="button" onClick={onCancel} style={link}>
              Cancel
            </button>
          </div>
        )}

        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
            {ERROR_TEXT[error] ?? `Sign-in failed (${error}).`}
          </p>
        )}

        <ul
          aria-label="about CloudPunch"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            justifyContent: 'center',
            flexWrap: 'wrap',
            gap: '6px 16px',
          }}
        >
          {POINTS.map((p) => (
            <li
              key={p}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: t.muted,
              }}
            >
              <Check color={TEAL} />
              {p}
            </li>
          ))}
        </ul>
      </div>

      <footer
        style={{
          ...small,
          background: t.surfaceAlt,
          borderTop: `1px solid ${t.border}`,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <Lock t={t} />
        Secured by Microsoft Entra ID · ApTask
      </footer>
    </section>
  );
}

function Check({ color }: { color: string }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill={color} opacity="0.16" />
      <path
        d="M4.6 8.3l2.2 2.2 4.6-4.9"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Lock({ t }: { t: Theme }): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7.5" rx="1.6" fill={t.muted} />
      <path d="M5.3 7V5.2a2.7 2.7 0 015.4 0V7" fill="none" stroke={t.muted} strokeWidth="1.6" />
    </svg>
  );
}
