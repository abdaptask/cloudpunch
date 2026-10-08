/**
 * Alert emails to the owner (ADR-0035, production on the internal
 * server): a backup that failed, the database or disk in trouble, and
 * when it's fixed. Sent like the welcome email (ADR-0021): Graph
 * `sendMail` with CloudPunch's app token, as `WELCOME_FROM`, which
 * Exchange limits to that one mailbox. Plain text, no images.
 */
export interface Alert {
  from: string;
  to: readonly string[];
  subject: string;
  text: string;
}

/** The Graph `sendMail` body for `a`. Not kept in Sent Items. */
export function alertBody(a: Alert): Record<string, unknown> {
  return {
    message: {
      subject: `[CloudPunch] ${a.subject}`,
      body: { contentType: 'Text', content: a.text },
      toRecipients: a.to.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: false,
  };
}

export async function sendAlert(
  token: string,
  a: Alert,
  opts: { fetch?: typeof fetch; base?: string } = {},
): Promise<void> {
  if (a.to.length === 0) throw new Error('no ALERT_TO address');
  const base = opts.base ?? 'https://graph.microsoft.com/v1.0';
  const res = await (opts.fetch ?? fetch)(`${base}/users/${encodeURIComponent(a.from)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(alertBody(a)),
  });
  if (res.status === 202 || res.ok) return;
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  throw new Error(json.error?.message ?? `sendMail HTTP ${res.status}`);
}
