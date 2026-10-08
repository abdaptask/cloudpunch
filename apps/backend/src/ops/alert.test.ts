import { describe, expect, it, vi } from 'vitest';
import { alertBody, sendAlert } from './alert.js';

const A = {
  from: 'cloudpunch@aptask.com',
  to: ['abdulla@aptask.com'],
  subject: 'Backup failed',
  text: 'pg_dump: connection refused',
};

describe('alert emails (ADR-0035)', () => {
  it('is a plain-text sendMail as CloudPunch, not kept in Sent Items', () => {
    expect(alertBody(A)).toEqual({
      message: {
        subject: '[CloudPunch] Backup failed',
        body: { contentType: 'Text', content: 'pg_dump: connection refused' },
        toRecipients: [{ emailAddress: { address: 'abdulla@aptask.com' } }],
      },
      saveToSentItems: false,
    });
  });

  it('posts to the sender mailbox with the app token, and reports Graph errors', async () => {
    const f = vi.fn(async () => new Response(null, { status: 202 }));
    await sendAlert('tok', A, { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/users/cloudpunch%40aptask.com/sendMail',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer tok' }) as unknown,
      }),
    );
    const no = vi.fn(async () =>
      Response.json({ error: { message: 'Access denied' } }, { status: 403 }),
    );
    await expect(sendAlert('tok', A, { fetch: no as unknown as typeof fetch })).rejects.toThrow(
      'Access denied',
    );
    await expect(sendAlert('tok', { ...A, to: [] })).rejects.toThrow('no ALERT_TO');
  });
});
