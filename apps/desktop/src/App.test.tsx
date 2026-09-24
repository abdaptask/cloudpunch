import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function statusText(): string | null {
  return within(screen.getByRole('region', { name: 'current-status' })).getByText(
    /clocked in|on a break/i,
  ).textContent;
}

function actionButtons(): string[] {
  return within(screen.getByRole('region', { name: 'actions' }))
    .getAllByRole('button')
    .map((b) => b.textContent ?? '');
}

describe('App home UI', () => {
  beforeEach(() => {
    // Handlers log placeholder messages until the state-machine slice
    // lands; keep test output clean.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('starts not clocked in with only a Clock in action', () => {
    render(<App />);
    expect(statusText()).toBe('Not clocked in');
    expect(actionButtons()).toEqual(['Clock in']);
  });

  it('clock in → shows Clock out and Take a break', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    expect(statusText()).toBe('Clocked in');
    expect(actionButtons()).toEqual(['Clock out', 'Take a break']);
  });

  it('take a break → end break returns to clocked in', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    await user.click(screen.getByRole('button', { name: 'Take a break' }));
    expect(statusText()).toBe('On a break');
    expect(actionButtons()).toEqual(['End break']);

    await user.click(screen.getByRole('button', { name: 'End break' }));
    expect(statusText()).toBe('Clocked in');
  });

  it('clock out returns to not clocked in', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    await user.click(screen.getByRole('button', { name: 'Clock out' }));
    expect(statusText()).toBe('Not clocked in');
    expect(actionButtons()).toEqual(['Clock in']);
  });
});
