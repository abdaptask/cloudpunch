import { Capability } from '@cloudpunch/shared';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  CorrectionsBanner,
  CorrectionsQueue,
  queueCount,
  useCorrectionsQueue,
} from '../../desktop/src/Corrections.js';
import { TeamScreen } from '../../desktop/src/TeamScreen.js';
import { ThemeProvider, useTheme } from '../../desktop/src/ui/theme.js';
import { startAuth, type Auth, type WebConfig } from './auth.js';
import { connectApi } from './desktopApi.js';

/**
 * The web dashboard shell (ADR-0033): sign in with Microsoft, then the
 * server says who you are. Only people who can already see others' time
 * (`team.timeline.read`: Managers and HR) get past the gate; the server
 * still checks every request. Past the gate: the desktop's own Team
 * screen (ADR-0033 §5), view only.
 */

export interface Me {
  user: { display_name: string | null; work_email: string };
  capabilities: string[];
}

type View =
  | { kind: 'loading' }
  | { kind: 'not_configured' }
  | { kind: 'signed_out'; auth: Auth }
  | { kind: 'not_set_up'; auth: Auth }
  | { kind: 'not_allowed'; auth: Auth; me: Me }
  | { kind: 'ready'; auth: Auth; me: Me }
  | { kind: 'error'; message: string };

export interface AppDeps {
  fetch: typeof fetch;
  startAuth: (cfg: WebConfig) => Promise<Auth>;
}

const realDeps: AppDeps = { fetch: (...a) => fetch(...a), startAuth };

async function load(deps: AppDeps): Promise<View> {
  const res = await deps.fetch('/app/config.json');
  if (res.status === 503) return { kind: 'not_configured' };
  if (!res.ok) return { kind: 'error', message: `config.json HTTP ${res.status}` };
  return whoAmI(deps, await deps.startAuth((await res.json()) as WebConfig));
}

async function whoAmI(deps: AppDeps, auth: Auth): Promise<View> {
  if (!auth.account) return { kind: 'signed_out', auth };
  const me = await deps.fetch('/v1/me', {
    headers: { authorization: `Bearer ${await auth.token()}` },
  });
  if (me.status === 403) return { kind: 'not_set_up', auth };
  if (!me.ok) return { kind: 'error', message: `/v1/me HTTP ${me.status}` };
  const body = (await me.json()) as Me;
  return body.capabilities.includes(Capability.TeamTimelineRead)
    ? { kind: 'ready', auth, me: body }
    : { kind: 'not_allowed', auth, me: body };
}

const C = {
  bg: '#f4f6fb',
  card: '#ffffff',
  text: '#0f1b33',
  muted: '#5d6675',
  accent: '#018afe',
  navy: '#012456',
  line: '#e3e8f0',
};

const button: CSSProperties = {
  padding: '11px 18px',
  borderRadius: 10,
  border: 'none',
  background: C.accent,
  color: '#fff',
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
};

function Card({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main
      style={{
        maxWidth: 480,
        width: '100%',
        boxSizing: 'border-box',
        background: C.card,
        borderRadius: 18,
        padding: '30px 28px',
        boxShadow: '0 10px 40px rgba(1, 36, 86, 0.10)',
      }}
    >
      <img
        src="/brand/logo.png"
        alt="CloudPunch"
        width={120}
        height={64}
        style={{ display: 'block', margin: '0 0 16px' }}
      />
      {children}
    </main>
  );
}

const p: CSSProperties = { margin: '0 0 14px', color: C.muted };

const failed = (e: unknown): View => ({
  kind: 'error',
  message: e instanceof Error ? e.message : String(e),
});

function SignOut({ auth, onDone }: { auth: Auth; onDone: (v: View) => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() =>
        void auth.signOut().then(
          () => onDone({ kind: 'signed_out', auth }),
          (e: unknown) => onDone(failed(e)),
        )
      }
      style={{ ...button, background: 'transparent', color: C.accent, padding: 0 }}
    >
      Sign out
    </button>
  );
}

export function App({ deps = realDeps }: { deps?: AppDeps }): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'loading' });

  useEffect(() => {
    load(deps).then(setView, (e: unknown) => setView(failed(e)));
  }, [deps]);

  if (view.kind === 'ready') {
    return (
      <ThemeProvider>
        <Dashboard
          deps={deps}
          auth={view.auth}
          me={view.me}
          onSignedOut={(v) => {
            connectApi(null);
            setView(v);
          }}
        />
      </ThemeProvider>
    );
  }

  const signIn = (auth: Auth): void => {
    auth
      .signIn()
      .then(() => whoAmI(deps, auth))
      .then(setView, (e: unknown) => setView(failed(e)));
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px 16px',
        boxSizing: 'border-box',
        background: C.bg,
        color: C.text,
        font: '15px/1.55 "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <Card>
        {view.kind === 'loading' && <p style={p}>Loading…</p>}
        {view.kind === 'not_configured' && (
          <p style={p}>CloudPunch on the web isn't set up on this server yet.</p>
        )}
        {view.kind === 'signed_out' && (
          <>
            <h1 style={{ margin: '0 0 8px', fontSize: 20, color: C.navy }}>
              Your team on CloudPunch
            </h1>
            <p style={p}>
              For managers and HR: see who's working, their days and their corrections, with nothing
              to install.
            </p>
            <button type="button" style={button} onClick={() => signIn(view.auth)}>
              Sign in with Microsoft
            </button>
          </>
        )}
        {view.kind === 'not_set_up' && (
          <>
            <p style={p}>Your account isn't set up in CloudPunch yet. Ask HR to add you.</p>
            <SignOut auth={view.auth} onDone={setView} />
          </>
        )}
        {view.kind === 'not_allowed' && (
          <>
            <p style={p}>
              CloudPunch on the web is for managers and HR. To track your own time, use the
              CloudPunch app.
            </p>
            <p style={p}>
              <a href="/" style={{ color: C.accent, fontWeight: 600 }}>
                Download CloudPunch
              </a>
            </p>
            <SignOut auth={view.auth} onDone={setView} />
          </>
        )}
        {view.kind === 'error' && (
          <p role="alert" style={p}>
            Something went wrong ({view.message}). Reload the page, or write to support@aptask.com.
          </p>
        )}
      </Card>
    </div>
  );
}

/** Those who endorse or approve corrections have a queue (ADR-0030 §3). */
const reviewsCorrections = (me: Me): boolean =>
  me.capabilities.includes('team.correction.review') ||
  me.capabilities.includes('admin.correction.approve');

/** Managers and Administrators see where people connect from (ADR-0029 §5); not HR. */
const canSeeConnections = (me: Me): boolean =>
  me.capabilities.includes('team.connection.read') ||
  me.capabilities.includes('admin.connection.read');

function Dashboard({
  deps,
  auth,
  me,
  onSignedOut,
}: {
  deps: AppDeps;
  auth: Auth;
  me: Me;
  onSignedOut: (v: View) => void;
}): JSX.Element {
  const t = useTheme();
  // Set before the first render of the Team screen, which loads at once.
  const [connected] = useState(() => {
    connectApi({ fetch: deps.fetch, token: auth.token });
    return true;
  });
  const corrections = useCorrectionsQueue(connected && reviewsCorrections(me));
  const [queueOpen, setQueueOpen] = useState(false);
  return (
    <div
      style={{ minHeight: '100vh', background: t.bg, color: t.text, font: `15px/1.5 ${t.font}` }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          borderBottom: `1px solid ${t.border}`,
          background: t.surface,
        }}
      >
        <img src="/brand/logo.png" alt="CloudPunch" width={60} height={32} />
        <span style={{ flex: 1, color: t.muted, fontSize: 14 }}>
          {me.user.display_name ?? me.user.work_email}
        </span>
        <SignOut auth={auth} onDone={onSignedOut} />
      </header>
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '20px 16px 40px' }}>
        {queueOpen ? (
          <CorrectionsQueue
            readOnly
            queue={corrections.queue}
            onChanged={corrections.reload}
            onClose={() => setQueueOpen(false)}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <CorrectionsBanner
              count={queueCount(corrections.queue)}
              onReview={() => {
                corrections.reload();
                setQueueOpen(true);
              }}
            />
            {connected && <TeamScreen canSeeConnections={canSeeConnections(me)} />}
          </div>
        )}
      </main>
    </div>
  );
}
