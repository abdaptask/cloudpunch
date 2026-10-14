import type { AppDeps } from './App.js';
import type { Auth } from './auth.js';

/**
 * Browser tests only (item 9, 2026-10-14): signed in without Microsoft.
 * Built in only with `VITE_E2E=1`; the API calls still go to `/v1/…`,
 * which the tests answer themselves.
 */
const auth: Auth = {
  account: {
    homeAccountId: 'e2e',
    environment: 'e2e',
    tenantId: 'e2e',
    username: 'e2e@aptask.com',
    localAccountId: 'e2e',
    name: 'E2E Tester',
  },
  signIn: async () => undefined,
  signOut: async () => undefined,
  token: async () => 'e2e-token',
};

export const e2eDeps: AppDeps = {
  fetch: (...a) => fetch(...a),
  startAuth: async () => auth,
  navigate: () => undefined,
};
