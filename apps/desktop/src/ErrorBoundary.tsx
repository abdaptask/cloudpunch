import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A render error must never leave a blank window. Time tracking keeps
 * running in the Rust agent regardless; this only restores the screen.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[cloudpunch] UI error', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main
        role="alert"
        style={{
          fontFamily: '"Segoe UI", system-ui, sans-serif',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          alignItems: 'flex-start',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 16 }}>Something went wrong on this screen</h1>
        <p style={{ margin: 0, fontSize: 13, color: '#5d6675', lineHeight: 1.5 }}>
          Your time is still being tracked. Reload to bring the screen back.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: '#018AFE',
            color: '#fff',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </main>
    );
  }
}
