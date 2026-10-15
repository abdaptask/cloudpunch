import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { OpsMonitor, QUIET_MS, WINDOW_MS, type OpsAlert } from './monitor.js';
import { postTeams, teamsBody, type TeamsPost } from './teams.js';

const log = pino({ level: 'silent' });
const tick = () => new Promise((r) => setTimeout(r, 0));

function monitor(now: { t: number }, opts: { failEmail?: boolean } = {}) {
  const emails: OpsAlert[] = [];
  const posts: TeamsPost[] = [];
  const m = new OpsMonitor({
    log,
    siteUrl: 'https://cloudpunch.aptask.com/',
    now: () => now.t,
    email: async (a) => {
      if (opts.failEmail) throw new Error('Graph down');
      emails.push(a);
    },
    teams: async (p) => {
      posts.push(p);
    },
  });
  return { m, emails, posts };
}

describe('the API watching itself (ADR-0043 §2)', () => {
  it('refused uploads: alerts at 50 in 15 minutes, then quiet for an hour', async () => {
    const now = { t: 0 };
    const { m, emails, posts } = monitor(now);
    m.refusedUpload(30);
    now.t += WINDOW_MS + 1;
    m.refusedUpload(30);
    await tick();
    // The first 30 fell out of the window.
    expect(emails).toHaveLength(0);
    m.refusedUpload(20);
    await tick();
    expect(emails.map((e) => e.title)).toEqual(['Uploads are being refused']);
    expect(emails[0]?.lines[0]).toBe('50 events were refused in the last 15 minutes.');
    expect(posts[0]).toMatchObject({
      attention: true,
      link: { url: 'https://cloudpunch.aptask.com/app/admin/' },
    });
    m.refusedUpload(100);
    now.t += QUIET_MS - 1;
    m.refusedUpload(100);
    await tick();
    expect(emails).toHaveLength(1);
    now.t += 2;
    m.refusedUpload(100);
    await tick();
    expect(emails).toHaveLength(2);
  });

  it('server errors: 20 in 15 minutes', async () => {
    const now = { t: 0 };
    const { m, emails } = monitor(now);
    for (let i = 0; i < 19; i++) m.serverError();
    await tick();
    expect(emails).toHaveLength(0);
    m.serverError();
    await tick();
    expect(emails[0]?.title).toBe('The API is answering with errors');
    expect(emails[0]?.lines[0]).toBe('20 requests failed in the last 15 minutes, for one reason.');
  });

  it("server errors from one computer's fast clock name the person, the why and the fix", async () => {
    const now = { t: Date.UTC(2026, 9, 15, 12, 0) };
    const emails: OpsAlert[] = [];
    const m = new OpsMonitor({
      log,
      siteUrl: 'https://cloudpunch.aptask.com',
      now: () => now.t,
      email: async (a) => {
        emails.push(a);
      },
      teams: null,
      device: async (id) =>
        id === 'd1' ? { name: 'Sweta Pandit', os: 'macos', appVersion: '0.1.33' } : null,
    });
    const refused = {
      route: 'POST /v1/events',
      error: 'new row for relation "time_event" violates check constraint "time_event_check"',
      account: 'sweta@aptask.com',
      deviceId: 'd1',
    };
    m.clockAhead('d1', 103);
    for (let i = 0; i < 20; i++) {
      m.serverError(refused);
      now.t += 30_000;
    }
    await tick();
    await tick();
    expect(emails).toHaveLength(1);
    const [a] = emails;
    expect(a?.title).toBe("Sweta Pandit's computer clock is ahead: uploads are waiting");
    const body = a?.lines.join('\n') ?? '';
    expect(body).toContain(
      "A computer's clock is ahead of real time: 20 times, 17:30–17:39 India time.",
    );
    expect(body).toContain('Request: POST /v1/events');
    expect(body).toContain('Who: Sweta Pandit (Mac, CloudPunch 0.1.33)');
    expect(body).toContain('Nothing is lost');
    expect(body).toContain('about 2 minutes fast');
    expect(body).toContain('automatic date and time');
    // Once an hour, however many more fail.
    for (let i = 0; i < 30; i++) m.serverError(refused);
    await tick();
    expect(emails).toHaveLength(1);
  });

  it('server errors of different kinds are listed by cause, the unknown with its error', async () => {
    const now = { t: 0 };
    const { m, emails } = monitor(now);
    for (let i = 0; i < 15; i++) {
      m.serverError({ route: 'GET /v1/team', error: 'connect ECONNREFUSED 127.0.0.1:5432' });
    }
    for (let i = 0; i < 5; i++) {
      m.serverError({
        route: 'GET /v1/reports/day',
        error: 'Cannot read properties of undefined',
        account: 'abdulla@aptask.com',
      });
    }
    await tick();
    await tick();
    expect(emails[0]?.title).toBe('The API is answering with errors');
    expect(emails[0]?.lines[0]).toBe('20 requests failed in the last 15 minutes, for 2 reasons.');
    expect(emails[0]?.lines[1]).toContain("The server can't reach its database: 15 times");
    expect(emails[0]?.lines[2]).toContain('Who: abdulla@aptask.com');
    expect(emails[0]?.lines[2]).toContain('Error: Cannot read properties of undefined');
  });

  it('a job failing 3 times in a row, then once when it works again', async () => {
    const now = { t: 0 };
    const { m, emails, posts } = monitor(now);
    m.jobFailed('Day-end summary', new Error('db down'));
    m.jobFailed('Day-end summary', new Error('db down'));
    m.jobOk('Day-end summary');
    m.jobFailed('Day-end summary', new Error('db down'));
    m.jobFailed('Day-end summary', new Error('db down'));
    await tick();
    expect(emails).toHaveLength(0);
    m.jobFailed('Day-end summary', new Error('db down'));
    await tick();
    expect(emails[0]).toEqual({
      title: 'Day-end summary keeps failing',
      lines: [
        'It failed 3 times in a row. Last error: db down',
        'Check the log: journalctl -u cloudpunch-api --since "-30 min"',
      ],
    });
    m.jobOk('Day-end summary');
    m.jobOk('Day-end summary');
    await tick();
    expect(posts.map((p) => [p.title, p.attention])).toEqual([
      ['Day-end summary keeps failing', true],
      ['Day-end summary works again', false],
    ]);
  });

  it('one channel failing does not stop the other', async () => {
    const now = { t: 0 };
    const { m, posts } = monitor(now, { failEmail: true });
    for (let i = 0; i < 20; i++) m.serverError();
    await tick();
    expect(posts).toHaveLength(1);
  });
});

describe('Teams posts (ADR-0043)', () => {
  it('an Adaptive Card message, with facts and a button', async () => {
    const p: TeamsPost = {
      title: 'Corrections waiting: 2',
      lines: ['By who has to act.'],
      facts: [{ title: 'Nilesh (to endorse)', value: 'Roshni 2' }],
      link: { title: 'Open Team', url: 'https://cloudpunch.aptask.com/app/' },
      attention: true,
    };
    const body = teamsBody(p) as {
      type: string;
      attachments: { contentType: string; content: { body: unknown[]; actions: unknown[] } }[];
    };
    expect(body.type).toBe('message');
    const card = body.attachments[0];
    expect(card?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card?.content.body).toEqual([
      expect.objectContaining({ text: 'Corrections waiting: 2', color: 'Attention' }),
      expect.objectContaining({ text: 'By who has to act.' }),
      { type: 'FactSet', facts: [{ title: 'Nilesh (to endorse)', value: 'Roshni 2' }] },
    ]);
    expect(card?.content.actions).toEqual([
      { type: 'Action.OpenUrl', title: 'Open Team', url: 'https://cloudpunch.aptask.com/app/' },
    ]);

    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string });
      return new Response('1', { status: calls.length === 1 ? 200 : 429 });
    }) as unknown as typeof fetch;
    await postTeams('https://example.webhook.office.com/x', p, { fetch: fake });
    expect(calls[0]?.url).toBe('https://example.webhook.office.com/x');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(teamsBody(p));
    await expect(
      postTeams('https://example.webhook.office.com/x', p, { fetch: fake }),
    ).rejects.toThrow('Teams webhook HTTP 429');
  });
});
