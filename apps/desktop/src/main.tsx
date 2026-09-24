import React from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { App } from './App.js';
import { PromptWindow } from './PromptWindow.js';
import { ThemeProvider } from './ui/theme.js';

const root = document.getElementById('root');
if (!root) {
  throw new Error('CloudPunch: #root element not found in index.html');
}

/** Both windows load this bundle; route on the Tauri window label. */
function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Plain browser (`vite:dev` without Tauri).
    return 'main';
  }
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>{windowLabel() === 'idle-prompt' ? <PromptWindow /> : <App />}</ThemeProvider>
  </React.StrictMode>,
);
