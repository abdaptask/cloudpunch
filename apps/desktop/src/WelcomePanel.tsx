import { useEffect, useState } from 'react';
import { api, type WelcomePreview } from './api.js';
import { Button } from './ui/Button.js';
import { useTheme } from './ui/theme.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  welcome_not_configured: 'Welcome emails are not set up on the server yet.',
  welcome_not_permitted:
    'Exchange refused to send as the noreply mailbox. An Exchange admin needs to finish the mail setup.',
  welcome_send_failed: 'The email could not be sent. Try again in a moment.',
  welcome_recently_sent: 'A welcome email was just sent to this person.',
  no_email: 'This person has no email address in the directory.',
  unknown_person: 'This person is not in the directory.',
  forbidden: "Your role can't send welcome emails.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/**
 * Welcome email for one person (ADR-0021): shows who it goes to, from and
 * copied, then sends it from the noreply mailbox. An optional personal
 * note is added at the top.
 */
export function WelcomePanel({
  oid,
  name,
  onDone,
}: {
  oid: string;
  name: string;
  /** `sent` true when it went out; false for "Not now". */
  onDone: (sent: boolean, text: string) => void;
}): JSX.Element {
  const t = useTheme();
  const [preview, setPreview] = useState<WelcomePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.adminWelcomePreview(oid).then(setPreview, (e: unknown) => setError(errorText(String(e))));
  }, [oid]);

  const send = (): void => {
    setSending(true);
    setError(null);
    api.adminWelcomeSend(oid, note).then(
      (r) => {
        setSending(false);
        onDone(
          true,
          `Welcome email sent to ${r.to}${r.cc.length ? ` (copied to ${r.cc.join(', ')})` : ''}.`,
        );
      },
      (e: unknown) => {
        setSending(false);
        setError(errorText(String(e)));
      },
    );
  };

  const row = (label: string, value: string): JSX.Element => (
    <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr', gap: 6, fontSize: 12.5 }}>
      <span style={{ color: t.muted }}>{label}</span>
      <span style={{ wordBreak: 'break-word' }}>{value}</span>
    </div>
  );

  return (
    <div
      role="group"
      aria-label="welcome-email"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: `1px solid ${t.border}`,
        borderRadius: 12,
        background: t.surface,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 650 }}>Send {name} a welcome email?</div>
      <p style={{ margin: 0, fontSize: 12.5, color: t.muted, lineHeight: 1.4 }}>
        It explains how to download CloudPunch, sign in and clock in, what it records, and to email
        support if they need help.
      </p>
      {preview && (
        <>
          {row('From', `ApTask CloudPunch <${preview.from}>`)}
          {row('To', preview.to)}
          {preview.cc.length > 0 && row('Cc', preview.cc.join(', '))}
          {row('Subject', preview.subject)}
          <textarea
            aria-label="welcome-note"
            placeholder="Add a personal note (optional)"
            value={note}
            maxLength={500}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            style={{
              font: 'inherit',
              fontSize: 13,
              padding: '7px 9px',
              borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: t.bg,
              color: t.text,
              resize: 'vertical',
            }}
          />
        </>
      )}
      {!preview && !error && <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Preparing…</p>}
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: t.danger, lineHeight: 1.4 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Button variant="primary" disabled={!preview || sending} onClick={send}>
          {sending ? 'Sending…' : 'Send welcome email'}
        </Button>
        <Button variant="secondary" onClick={() => onDone(false, '')}>
          Not now
        </Button>
      </div>
    </div>
  );
}
