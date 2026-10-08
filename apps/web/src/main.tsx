import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { isAuthResponse } from './auth.js';

// Microsoft returns sign-ins to /app/ (ADR-0033 §3). MSAL v5 expects
// that page to hand the response to the app (a hidden frame, or the
// page before a redirect) and draw nothing itself.
if (isAuthResponse(window.location)) {
  void import('@azure/msal-browser/redirect-bridge').then((m) => m.broadcastResponseToMainFrame());
} else {
  const root = document.getElementById('root');
  if (!root) throw new Error('CloudPunch: #root element not found in index.html');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
