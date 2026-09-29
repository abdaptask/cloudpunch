import { describe, expect, it } from 'vitest';
import { addressList, sendWelcome, welcomeMessage, type WelcomeSettings } from './welcome.js';

const SETTINGS: WelcomeSettings = {
  from: 'noreply@aptask.com',
  cc: ['support@aptask.com', 'abdulla@aptask.com', 'nileshd@aptask.com'],
  siteUrl: 'https://cloudpunch.aptask.com',
  supportEmail: 'support@aptask.com',
};

describe('welcome email (ADR-0021)', () => {
  it('tells the person what to do and where to get help', () => {
    const m = welcomeMessage(SETTINGS, {
      firstName: 'Farheen',
      to: 'farheen@aptask.com',
      version: '0.1.0',
      note: null,
    });
    expect(m.from).toBe('noreply@aptask.com');
    expect(m.to).toBe('farheen@aptask.com');
    expect(m.cc).toEqual(SETTINGS.cc);
    expect(m.subject).toBe('Welcome to CloudPunch: how to get started');
    expect(m.html).toContain('Welcome to CloudPunch, Farheen');
    expect(m.html).toContain('href="https://cloudpunch.aptask.com"');
    expect(m.html).toContain('CloudPunch_0.1.0_x64-setup.exe');
    expect(m.html).toContain('More info → Run anyway');
    expect(m.html).toContain('mailto:support@aptask.com');
    expect(m.html).toContain('the team will help you solve it');
    expect(m.html).toContain('It never takes screenshots');
    expect(m.html).not.toMatch(/<script/i);
  });

  it('never copies the recipient, and escapes names and notes', () => {
    const m = welcomeMessage(SETTINGS, {
      firstName: '<b>Nilesh</b>',
      to: 'NileshD@aptask.com',
      version: null,
      note: 'See you at <script>standup</script>',
    });
    expect(m.cc).toEqual(['support@aptask.com', 'abdulla@aptask.com']);
    expect(m.html).not.toContain('<b>Nilesh</b>');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&#60;script&#62;standup');
    expect(m.html).toContain('the CloudPunch setup file');
  });

  it('parses the Cc setting', () => {
    expect(addressList('Support@aptask.com, abdulla@aptask.com;bad, abdulla@aptask.com')).toEqual([
      'support@aptask.com',
      'abdulla@aptask.com',
    ]);
    expect(addressList(undefined)).toEqual([]);
  });

  it('sends as the from mailbox with To and Cc', async () => {
    let url = '';
    let body: unknown = null;
    let auth = '';
    const fetchFn = (async (u: string | URL, init: RequestInit = {}) => {
      url = String(u);
      body = JSON.parse(init.body as string);
      auth = (init.headers as Record<string, string>)['authorization'] ?? '';
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const m = welcomeMessage(SETTINGS, {
      firstName: 'Roshni',
      to: 'roshnis@aptask.com',
      version: '0.1.0',
      note: null,
    });
    await sendWelcome('app-token', m, { fetch: fetchFn, base: 'https://graph.test/v1.0' });
    expect(url).toBe('https://graph.test/v1.0/users/noreply%40aptask.com/sendMail');
    expect(auth).toBe('Bearer app-token');
    expect(body).toMatchObject({
      message: {
        subject: 'Welcome to CloudPunch: how to get started',
        body: { contentType: 'HTML' },
        toRecipients: [{ emailAddress: { address: 'roshnis@aptask.com' } }],
        ccRecipients: SETTINGS.cc.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    });
  });

  it('a refusal carries its status', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'no' } }), {
        status: 403,
      })) as typeof fetch;
    const m = welcomeMessage(SETTINGS, {
      firstName: 'A',
      to: 'a@aptask.com',
      version: null,
      note: null,
    });
    await expect(sendWelcome('t', m, { fetch: fetchFn })).rejects.toMatchObject({
      status: 403,
      code: 'ErrorAccessDenied',
    });
  });
});
