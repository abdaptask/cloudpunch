import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionHistory } from './api.js';
import { ConnectionList } from './ConnectionsView.js';

vi.mock('./api.js', () => ({ api: {} }));

const at = new Date().toISOString();
const history = (over: Partial<ConnectionHistory> = {}): ConnectionHistory => ({
  recording: true,
  keep_days: 30,
  attribution: 'IP data by DB-IP',
  connections: [
    {
      ip: '58.84.61.202',
      city: 'Pune',
      region: 'Maharashtra',
      country: 'IN',
      provider: 'Tata Play Broadband Private Limited',
      asn: 134674,
      device_os: 'windows',
      first_seen_at: at,
      last_seen_at: at,
    },
  ],
  ...over,
});

describe('ConnectionList (ADR-0029)', () => {
  it('shows the place, provider, address and computer, with the DB-IP credit', async () => {
    const h = history();
    render(<ConnectionList load={() => Promise.resolve(h)} />);
    expect(await screen.findByText('Pune, Maharashtra')).toBeInTheDocument();
    expect(screen.getByText(/Tata Play Broadband · 58\.84\.61\.202 · Windows/)).toBeInTheDocument();
    expect(screen.getByText(/IP data by DB-IP/)).toBeInTheDocument();
    expect(screen.queryByText(/Recording is off/)).not.toBeInTheDocument();
  });

  it('says when recording is off and when there is nothing yet', async () => {
    const h = history({ recording: false, connections: [] });
    render(<ConnectionList load={() => Promise.resolve(h)} />);
    expect(await screen.findByText(/Recording is off/)).toBeInTheDocument();
    expect(screen.getByText('No connections in the last 30 days.')).toBeInTheDocument();
  });

  it('explains a refusal', async () => {
    // Tauri commands reject with the backend's code as a string.
    const load = vi.fn<() => Promise<ConnectionHistory>>().mockRejectedValue('not_found');
    render(<ConnectionList load={load} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("That person isn't on your team.");
  });
});
