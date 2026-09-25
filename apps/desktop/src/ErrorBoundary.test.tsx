import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary.js';

function Boom(): JSX.Element {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('shows a recovery screen instead of a blank window', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Your time is still being tracked.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    quiet.mockRestore();
  });
});
