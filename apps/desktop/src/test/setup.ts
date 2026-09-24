// Registers jest-dom matchers (toBeInTheDocument, etc.) on vitest's
// `expect` and unmounts rendered trees between tests.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
