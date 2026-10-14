import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button } from '../ui/Button.js';
import { useTheme } from '../ui/theme.js';
import { input } from './DataTable.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to do this.',
  forbidden: 'Only an Administrator can push an update.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

type When = 'soon' | 'evening' | 'tomorrow' | 'custom';

/** The deadline a choice means, from `now` on this computer's clock. */
export function deadlineOf(when: When, now: Date, custom: string): Date | null {
  switch (when) {
    case 'soon':
      return new Date(now.getTime() + 5 * 60_000);
    case 'evening': {
      const d = new Date(now);
      d.setHours(18, 0, 0, 0);
      return d > now ? d : new Date(now.getTime() + 5 * 60_000);
    }
    case 'tomorrow': {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
      return d;
    }
    case 'custom': {
      const d = new Date(custom);
      return Number.isNaN(d.getTime()) || d <= now ? null : d;
    }
  }
}

const whenText = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

type Doc = Record<string, unknown>;

/**
 * Computers → Push the update (ADR-0046 §3): everyone on the latest
 * version by a time. Until then people choose (update and clock in,
 * clock out and update); after it, clocking in updates first and a
 * clocked-in app updates after a 5-minute notice. Saved in the company
 * settings, so Rules → What changed shows who pushed it and when.
 */
export function PushUpdate({ behind, canPush }: { behind: number; canPush: boolean }): JSX.Element {
  const t = useTheme();
  const [latest, setLatest] = useState<{ windows: string | null; macos: string | null } | null>(
    null,
  );
  const [override, setOverride] = useState<Doc | null | undefined>(undefined);
  const [when, setWhen] = useState<When>('evening');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api.adminUpdatesLatest().then(setLatest, () => setLatest({ windows: null, macos: null }));
    if (canPush) {
      api.adminPolicyGet('global', null).then(
        (p) => setOverride((p.override?.document as Doc | undefined) ?? null),
        (e: unknown) => setStatus({ kind: 'error', text: errorText(String(e)) }),
      );
    }
  }, [canPush]);

  const push = (override?.['updates'] ?? {}) as { required_by?: string | null };
  const pushedBy = push.required_by ?? null;
  const versions = [
    latest?.windows && `Windows ${latest.windows}`,
    latest?.macos && `Mac ${latest.macos}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const save = (updates: Doc, reason: string, done: string): void => {
    setBusy(true);
    setStatus(null);
    const document = { ...(override ?? {}), updates };
    api.adminPolicyPut('global', null, document, reason).then(
      (r) => {
        setBusy(false);
        setOverride(r.override?.document ?? document);
        setStatus({ kind: 'saved', text: done });
      },
      (e: unknown) => {
        setBusy(false);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  const deadline = deadlineOf(when, new Date(), custom);

  return (
    <section
      aria-label="push-update"
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
      <h3 style={{ margin: 0, fontSize: 14 }}>Push the update</h3>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: t.muted }}>
        Latest: {versions || 'nothing published'}.{' '}
        {behind > 0
          ? `${behind} computer${behind === 1 ? ' is' : 's are'} behind.`
          : 'Everyone is up to date.'}{' '}
        Apps update by themselves once clocked out for two minutes; a push makes sure of it.
      </p>
      {pushedBy && (
        <p aria-label="push-status" style={{ margin: 0, fontSize: 13 }}>
          Pushed: everyone on the latest version by <strong>{whenText(pushedBy)}</strong>. After
          that, clocking in updates first, and clocked-in apps update after a 5-minute notice.
        </p>
      )}
      {canPush ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            aria-label="push-when"
            value={when}
            onChange={(e) => setWhen(e.target.value as When)}
            style={input(t)}
          >
            <option value="soon">In 5 minutes</option>
            <option value="evening">Today at 6:00 pm</option>
            <option value="tomorrow">Tomorrow at 10:00 am</option>
            <option value="custom">Pick a time</option>
          </select>
          {when === 'custom' && (
            <input
              aria-label="push-at"
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              style={input(t)}
            />
          )}
          <Button
            variant="primary"
            disabled={busy || override === undefined || !deadline || !versions}
            onClick={() =>
              deadline &&
              save(
                { required_by: deadline.toISOString(), pushed_at: new Date().toISOString() },
                `Pushed the update (${versions}) by ${deadline.toISOString()}`,
                `Pushed. Apps see it within 15 minutes; everyone is on the latest version by ${whenText(deadline.toISOString())}.`,
              )
            }
          >
            {pushedBy ? 'Push again' : 'Push the update'}
          </Button>
          {pushedBy && (
            <Button
              variant="chip"
              disabled={busy}
              onClick={() =>
                save(
                  { required_by: null, pushed_at: null },
                  'Stopped the update push',
                  'Push stopped. Apps still update by themselves when clocked out.',
                )
              }
            >
              Stop the push
            </Button>
          )}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12.5, color: t.muted }}>
          Only an Administrator can push an update.
        </p>
      )}
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
