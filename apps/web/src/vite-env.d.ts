/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` only in the browser-test build (`e2e/`, item 9): sign-in is a stand-in. */
  readonly VITE_E2E?: string;
}
