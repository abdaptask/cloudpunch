import { useState } from 'react';
import { api, type RemindSkip } from '../api.js';
import { Button } from '../ui/Button.js';
import { useTheme } from '../ui/theme.js';
import type { BehindPerson } from './computersModel.js';
import { input } from './DataTable.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to do this.',
  forbidden: 'Only an Administrator can email people to update.',
  mail_not_configured: "CloudPunch's mailbox isn't set up, so it can't send email.",
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const SKIP_TEXT: Record<RemindSkip, string> = {
  not_found: 'not found',
  no_computer: 'no computer',
  up_to_date: 'already up to date',
  no_email: 'no email address',
  reminded_recently: 'emailed in the last hour',
  send_failed: "the email couldn't be sent",
};

const osName = (os: string): string => (os === 'windows' ? 'Windows' : 'Mac');

/**
 * Computers → Email to update (ADR-0046): each person whose computer is
 * behind gets their own email with their version and how to update.
 * Everyone behind is ticked; untick anyone to leave them out.
 */
export function EmailToUpdate({
  people,
  onClose,
}: {
  people: readonly BehindPerson[];
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(people.map((p) => p.userId)));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const name = new Map(people.map((p) => [p.userId, p.name]));

  const toggle = (id: string): void =>
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const send = (): void => {
    setBusy(true);
    setStatus(null);
    api.adminUpdateRemind([...ticked], message.trim() || undefined).then(
      (r) => {
        setBusy(false);
        const left = r.skipped.map(
          (s) => `${name.get(s.id) ?? 'someone'} (${SKIP_TEXT[s.reason]})`,
        );
        setStatus({
          kind: 'saved',
          text: `Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.${
            left.length > 0 ? ` Not sent: ${left.join(', ')}.` : ''
          }`,
        });
      },
      (e: unknown) => {
        setBusy(false);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  return (
    <section
      aria-label="email-to-update"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surface,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14 }}>Email to update</h3>
      {people.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: t.muted }}>Everyone is up to date.</p>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 13, color: t.muted }}>
            Each person gets their own email from CloudPunch with their version and how to update.
          </p>
          <ul
            aria-label="people-behind"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              maxHeight: 220,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {people.map((p) => (
              <li key={p.userId}>
                <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    aria-label={`remind-${p.name}`}
                    checked={ticked.has(p.userId)}
                    onChange={() => toggle(p.userId)}
                  />
                  <span>
                    {p.name}
                    <span style={{ color: t.muted }}>
                      {' · '}
                      {p.computers.map((c) => `${osName(c.os)} ${c.version}`).join(', ')}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <textarea
            aria-label="remind-message"
            placeholder="A line of your own, at the top of the email (optional)"
            value={message}
            maxLength={1000}
            rows={2}
            onChange={(e) => setMessage(e.target.value)}
            style={{ ...input(t), resize: 'vertical', fontFamily: 'inherit' }}
          />
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {people.length > 0 && (
          <Button variant="primary" disabled={busy || ticked.size === 0} onClick={send}>
            {busy
              ? 'Sending…'
              : `Send to ${ticked.size} ${ticked.size === 1 ? 'person' : 'people'}`}
          </Button>
        )}
        <Button variant="chip" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          style={{ margin: 0, fontSize: 13, color: status.kind === 'error' ? t.danger : t.text }}
        >
          {status.text}
        </p>
      )}
    </section>
  );
}
