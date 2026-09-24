import type { CSSProperties } from 'react';
import { api, type StateView } from './api.js';
import { useAgentState } from './useAgentState.js';

/**
 * Home window. State lives in the Rust agent (slice 2b.7.2b PR D);
 * this component renders the current `StateView` and invokes
 * commands. The idle prompt itself opens in its own window.
 *
 * Calls are shown as "Clocked in": ON_CALL is reported as ACTIVE
 * (ADR-0003 §1).
 */

function statusLabel(v: StateView): string {
  switch (v.status) {
    case 'clocked_out':
      return 'Not clocked in';
    case 'active':
    case 'on_call':
      return 'Clocked in';
    case 'idle_pending':
      return 'Clocked in — are you still there?';
    case 'on_break':
      return v.breakKind === 'meal' ? 'On a meal break' : 'On a bio break';
    case 'away':
      return v.awayReason === 'phone_call' ? 'Away — on a phone call' : 'Away — working away';
  }
}

const ERROR_TEXT: Record<string, string> = {
  invalid_transition: "That action isn't available right now.",
};

export function App(): JSX.Element {
  const { view, error, run } = useAgentState();

  return (
    <main
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        padding: 24,
        color: '#111',
        height: '100vh',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <header>
        <h1 style={{ margin: 0, fontSize: 22 }}>CloudPunch</h1>
      </header>

      <section
        aria-label="current-status"
        style={{
          background: '#f4f6fa',
          border: '1px solid #dce1eb',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <div style={{ fontSize: 12, color: '#556', textTransform: 'uppercase' }}>Status</div>
        <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>
          {view ? statusLabel(view) : 'Loading…'}
        </div>
      </section>

      {view?.status === 'clocked_out' && view.autoClockedOutAt !== null && (
        <p role="status" style={{ margin: 0, fontSize: 14, color: '#7a3b00' }}>
          You were clocked out at {new Date(view.autoClockedOutAt).toLocaleTimeString()} because the
          idle prompt wasn&apos;t answered. Time up to when the prompt appeared is kept.
        </p>
      )}

      {view && (
        <section aria-label="actions" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {view.status === 'clocked_out' && (
            <button style={primaryButton} onClick={() => run(api.clockIn)}>
              Clock in
            </button>
          )}
          {(view.status === 'active' || view.status === 'on_call') && (
            <>
              <button style={primaryButton} onClick={() => run(api.clockOut)}>
                Clock out
              </button>
              <button style={secondaryButton} onClick={() => run(() => api.startBreak('bio'))}>
                Bio break
              </button>
              <button style={secondaryButton} onClick={() => run(() => api.startBreak('meal'))}>
                Meal break
              </button>
            </>
          )}
          {view.status === 'idle_pending' && (
            <button style={primaryButton} onClick={() => run(api.clockOut)}>
              Clock out
            </button>
          )}
          {view.status === 'on_break' && (
            <>
              <button style={primaryButton} onClick={() => run(api.endBreak)}>
                End break
              </button>
              <button style={secondaryButton} onClick={() => run(api.clockOut)}>
                Clock out
              </button>
            </>
          )}
          {view.status === 'away' && (
            <>
              <button style={primaryButton} onClick={() => run(api.markBack)}>
                I&apos;m back
              </button>
              <button style={secondaryButton} onClick={() => run(api.clockOut)}>
                Clock out
              </button>
            </>
          )}
        </section>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: '#a00' }}>
          {ERROR_TEXT[error] ?? `Something went wrong (${error}).`}
        </p>
      )}
    </main>
  );
}

const primaryButton: CSSProperties = {
  padding: '12px 16px',
  fontSize: 15,
  fontWeight: 600,
  border: 'none',
  borderRadius: 6,
  background: '#1a2b4c',
  color: '#fff',
  cursor: 'pointer',
};

const secondaryButton: CSSProperties = {
  padding: '10px 16px',
  fontSize: 14,
  border: '1px solid #dce1eb',
  borderRadius: 6,
  background: '#fff',
  color: '#111',
  cursor: 'pointer',
};
