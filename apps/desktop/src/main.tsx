import React from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AdminWindow } from './admin/AdminWindow.js';
import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { PromptWindow } from './PromptWindow.js';
import { ThemeProvider } from './ui/theme.js';

const root = document.getElementById('root');
if (!root) {
  throw new Error('CloudPunch: #root element not found in index.html');
}

/** Every window loads this bundle; route on the Tauri window label. */
function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Plain browser (`vite:dev` without Tauri).
    return 'main';
  }
}

function screenFor(label: string): JSX.Element {
  if (label === 'idle-prompt') return <PromptWindow />;
  // The admin console (ADR-0038 §2).
  if (label === 'admin') return <AdminWindow />;
  return <App />;
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>{screenFor(windowLabel())}</ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
