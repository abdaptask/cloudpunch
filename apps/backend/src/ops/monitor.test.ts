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
