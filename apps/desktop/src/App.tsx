import { useState, type CSSProperties } from 'react';

/**
 * Slice 2b.7.1 minimal home UI.
 *
 * Local state only — no backend calls yet. Clicks log to console.
 * When the state machine slice lands, these handlers will invoke
 * Tauri commands that enqueue events into the outbox.
 */
type ClockState = 'not_clocked_in' | 'clocked_in' | 'on_break';

const STATUS_LABEL: Record<ClockState, string> = {
  not_clocked_in: 'Not clocked in',
  clocked_in: 'Clocked in',
  on_break: 'On a break',
};

export function App(): JSX.Element {
  const [state, setState] = useState<ClockState>('not_clocked_in');

  const clockIn = (): void => {
    console.log('[cloudpunch] home: clock_in (state machine wiring TBD)');
    setState('clocked_in');
  };
  const clockOut = (): void => {
    console.log('[cloudpunch] home: clock_out (state machine wiring TBD)');
    setState('not_clocked_in');
  };
  const takeBreak = (): void => {
    console.log('[cloudpunch] home: take_break (state machine wiring TBD)');
    setState('on_break');
  };
  const endBreak = (): void => {
    console.log('[cloudpunch] home: end_break (state machine wiring TBD)');
    setState('clocked_in');
  };

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
        <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{STATUS_LABEL[state]}</div>
      </section>

      <section aria-label="actions" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {state === 'not_clocked_in' && (
          <button style={primaryButton} onClick={clockIn}>
            Clock in
          </button>
        )}
        {state === 'clocked_in' && (
          <>
            <button style={primaryButton} onClick={clockOut}>
              Clock out
            </button>
            <button style={secondaryButton} onClick={takeBreak}>
              Take a break
            </button>
          </>
        )}
        {state === 'on_break' && (
          <button style={primaryButton} onClick={endBreak}>
            End break
          </button>
        )}
      </section>

      <footer style={{ marginTop: 'auto', fontSize: 11, color: '#889' }}>
        Slice 2b.7.1 — local state only. Backend wiring lands with the state-machine slice.
      </footer>
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
