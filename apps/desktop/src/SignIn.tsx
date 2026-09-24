import type { CSSProperties } from 'react';
import { MicrosoftSignInButton } from './ui/MicrosoftSignInButton.js';
import { useTheme } from './ui/theme.js';

const ERROR_TEXT: Record<string, string> = {
  timed_out: 'Sign-in timed out. Please try again.',
  denied: 'Sign-in was cancelled.',
  network: "Couldn't reach Microsoft. Check your connection and try again.",
  rejected: 'Microsoft rejected the sign-in. Please try again.',
  browser: "Couldn't open your browser.",
  busy: 'Sign-in is already in progress in your browser.',
  keystore: "Couldn't save your sign-in securely on this computer. Please try again.",
};

/** Shown until the user signs in with their ApTask Microsoft account. */
export function SignIn({
  busy,
  error,
  onSignIn,
}: {
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
}): JSX.Element {
  const t = useTheme();
  const small: CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: t.muted };
  return (
    <section
      aria-label="sign-in"
      style={{
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 14,
        padding: '28px 24px 22px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 16,
        textAlign: 'center',
      }}
    >
      <ClockMark />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: -0.2 }}>
          Welcome to CloudPunch
        </h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: t.muted }}>
          Sign in with your ApTask work account to start tracking your time.
        </p>
      </div>

      <MicrosoftSignInButton onClick={onSignIn} disabled={busy} />

      <p role="status" style={{ ...small, minHeight: 18 }}>
        {busy
          ? 'A browser window has opened. Finish signing in there, then come back here.'
          : 'Sign-in opens in your browser, where your organisation’s security checks apply.'}
      </p>

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger }}>
          {ERROR_TEXT[error] ?? `Sign-in failed (${error}).`}
        </p>
      )}

      <p style={{ ...small, borderTop: `1px solid ${t.border}`, paddingTop: 12 }}>
        ApTask · Time &amp; attendance
      </p>
    </section>
  );
}

/** Simple clock mark in the accent colour. */
function ClockMark(): JSX.Element {
  const t = useTheme();
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 44 44"
      aria-hidden="true"
      style={{ alignSelf: 'center' }}
    >
      <circle cx="22" cy="22" r="20" fill={t.accent} />
      <circle cx="22" cy="22" r="15" fill="none" stroke={t.onAccent} strokeWidth="2.5" />
      <path
        d="M22 13v9l6 4"
        fill="none"
        stroke={t.onAccent}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
