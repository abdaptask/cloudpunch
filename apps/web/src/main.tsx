import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppDeps } from './App.js';
import { isAuthResponse } from './auth.js';

// Microsoft returns sign-ins to /app/ (ADR-0033 §3). MSAL v5 expects
// that page to hand the response to the app (a hidden frame, or the
// page before a redirect) and draw nothing itself.
if (isAuthResponse(window.location)) {
  void import('@azure/msal-browser/redirect-bridge').then((m) => m.broadcastResponseToMainFrame());
} else {
  const root = document.getElementById('root');
  if (!root) throw new Error('CloudPunch: #root element not found in index.html');
  // Browser tests only (`VITE_E2E=1`, never set for the real build): a
  // stand-in for Microsoft sign-in. Vite replaces the flag at build
  // time, so a normal build leaves the import out entirely.
  const deps: Promise<AppDeps | undefined> =
    import.meta.env.VITE_E2E === '1'
      ? import('./e2eDeps.js').then((m) => m.e2eDeps)
      : Promise.resolve(undefined);
  void deps.then((d) =>
    createRoot(root).render(
      <StrictMode>
        <App {...(d ? { deps: d } : {})} />
      </StrictMode>,
    ),
  );
}
