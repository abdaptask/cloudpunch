import { readFileSync } from 'node:fs';

/**
 * The welcome email (ADR-0021): what a new CloudPunch user needs to get
 * started, and where to get help. Sent from CloudPunch's own mailbox
 * (WELCOME_FROM); the sender and Cc come from server settings, not code.
 * The two logos travel inside the email (`cid:`), so Outlook shows them
 * without "download pictures" and nothing is fetched from our site.
 */

/** Logos the html refers to as `cid:<id>`, bundled with the backend. */
const IMAGES: { id: string; file: string }[] = [
  { id: 'cloudpunch-logo', file: 'logo.png' },
  { id: 'aptask-mark', file: 'aptask-mark.png' },
];

let imageCache: Map<string, string> | null = null;

/** The logos as base64, read once. */
function imageBytes(): Map<string, string> {
  imageCache ??= new Map(
    IMAGES.map(({ id, file }) => [
      id,
      readFileSync(new URL(`../../assets/brand/${file}`, import.meta.url)).toString('base64'),
    ]),
  );
  return imageCache;
}

export interface WelcomeSettings {
  /** The mailbox it's sent from, e.g. cloudpunch@aptask.com. */
  from: string;
  /** Always copied, e.g. support@, the owner. */
  cc: string[];
  /** Where to download the app, e.g. https://cloudpunch.aptask.com. */
  siteUrl: string;
  /** Who helps with problems, e.g. support@aptask.com. */
  supportEmail: string;
}

export interface WelcomeInput {
  firstName: string;
  to: string;
  /** Newest published version, if any. */
  version: string | null;
  /** An optional personal line from the admin. */
  note: string | null;
}

export interface WelcomeMessage {
  from: string;
  to: string;
  cc: string[];
  subject: string;
  html: string;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Parse `a@x.com, b@x.com` into distinct lower-case addresses. */
export function addressList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(/[,;\s]+/)
        .map((a) => a.trim().toLowerCase())
        .filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)),
    ),
  ];
}

export function welcomeMessage(s: WelcomeSettings, w: WelcomeInput): WelcomeMessage {
  const file = w.version ? `CloudPunch_${w.version}_x64-setup.exe` : 'the CloudPunch setup file';
  const site = esc(s.siteUrl);
  const support = esc(s.supportEmail);
  const note = w.note?.trim()
    ? `<p style="margin:0 0 16px;padding:12px 14px;background:#f1f6ff;border-radius:10px;">${esc(w.note.trim())}</p>`
    : '';
  const li = 'margin:0 0 8px;';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px 28px 24px;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.55;color:#0f1b33;">
<tr><td>
<p style="margin:0 0 18px;"><img src="cid:cloudpunch-logo" width="150" height="80" alt="CloudPunch" style="display:block;border:0;"></p>
<h1 style="margin:0 0 16px;font-size:22px;color:#012456;">Welcome to CloudPunch, ${esc(w.firstName)}</h1>
<p style="margin:0 0 16px;">You've been set up on <b>CloudPunch</b>, ApTask's time and attendance app for remote work.</p>
${note}
<h2 style="margin:20px 0 8px;font-size:16px;color:#012456;">Getting started (about 5 minutes)</h2>
<ol style="margin:0 0 16px;padding-left:20px;">
<li style="${li}">Go to <a href="${site}" style="color:#018afe;">${site}</a> and click <b>Download for Windows</b> or <b>Download for Mac</b>. Sign in with your ApTask Microsoft account when asked.</li>
<li style="${li}"><b>Windows:</b> run <b>${esc(file)}</b>. If Windows says <i>"Windows protected your PC / unknown publisher"</i>, click <b>More info → Run anyway</b>. No admin rights are needed.<br><b>Mac:</b> open the downloaded <b>.dmg</b> file, drag <b>CloudPunch</b> into <b>Applications</b>, then open it from Applications.</li>
<li style="${li}">Open CloudPunch and <b>sign in with your ApTask Microsoft account</b>.</li>
<li style="${li}"><b>Clock in</b> when you start work and <b>clock out</b> when you finish. Use <b>Take a break</b> whenever you step away.</li>
</ol>
<p style="margin:0 0 16px;">It works from anywhere; no VPN is needed.</p>
<h2 style="margin:20px 0 8px;font-size:16px;color:#012456;">Worth knowing</h2>
<ul style="margin:0 0 16px;padding-left:20px;">
<li style="${li}"><b>Clock-in reminder:</b> depending on your shift, expect a popup reminding you to clock in when your shift starts. It comes back every few minutes until you clock in. Without a shift, it comes each morning at 8 am US Eastern.</li>
<li style="${li}">After a couple of minutes without keyboard or mouse activity, CloudPunch asks if you're still there. If you don't answer, the time is logged as <b>idle</b> and you stay clocked in; when you're back it asks what you were doing.</li>
<li style="${li}">Teams and Zoom calls are recognised automatically, so a call never counts as idle.</li>
<li style="${li}">The pin button puts a small always-on-top timer on your desktop.</li>
</ul>
<h2 style="margin:20px 0 8px;font-size:16px;color:#012456;">How CloudPunch monitors your working day</h2>
<p style="margin:0 0 16px;">While you're clocked in, CloudPunch monitors your working time: when you clock in and out, your breaks, when you're active or idle at your computer, your Teams, Zoom and other calls, which computer you use, and where you connect from (approximate city and internet provider). Your manager and ApTask administrators review this.</p>
<h2 style="margin:20px 0 8px;font-size:16px;color:#012456;">Need help?</h2>
<p style="margin:0 0 20px;">If you run into any issue, email <a href="mailto:${support}" style="color:#018afe;"><b>${support}</b></a> and the team will help you solve it. A screenshot helps.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0;border-top:1px solid #e6e9f0;width:100%;">
<tr><td style="padding-top:14px;width:36px;vertical-align:middle;"><img src="cid:aptask-mark" width="27" height="24" alt="ApTask" style="display:block;border:0;"></td>
<td style="padding-top:14px;vertical-align:middle;color:#5d6675;font-size:13px;">CloudPunch by ApTask · Replies to this address aren't read; please write to ${support}.</td></tr>
</table>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return {
    from: s.from,
    to: w.to,
    cc: s.cc.filter((c) => c !== w.to.toLowerCase()),
    subject: 'Welcome to CloudPunch: how to get started',
    html,
  };
}

/** The logos `html` refers to, as Graph inline attachments. */
export function inlineImages(html: string): Record<string, unknown>[] {
  const bytes = imageBytes();
  return IMAGES.filter(({ id }) => html.includes(`cid:${id}`)).map(({ id, file }) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: file,
    contentType: 'image/png',
    contentBytes: bytes.get(id),
    contentId: id,
    isInline: true,
  }));
}

/** Send `m` as `m.from` with an app token (Graph `sendMail`), logos inline. */
export async function sendWelcome(
  token: string,
  m: WelcomeMessage,
  opts: { fetch?: typeof fetch; base?: string } = {},
): Promise<void> {
  const base = opts.base ?? 'https://graph.microsoft.com/v1.0';
  const res = await (opts.fetch ?? fetch)(`${base}/users/${encodeURIComponent(m.from)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: m.subject,
        body: { contentType: 'HTML', content: m.html },
        toRecipients: [{ emailAddress: { address: m.to } }],
        ccRecipients: m.cc.map((address) => ({ emailAddress: { address } })),
        attachments: inlineImages(m.html),
      },
      saveToSentItems: true,
    }),
  });
  if (res.status === 202 || res.ok) return;
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  const err = new Error(json.error?.message ?? `sendMail HTTP ${res.status}`) as Error & {
    status: number;
    code: string;
  };
  err.status = res.status;
  err.code = json.error?.code ?? `http_${res.status}`;
  throw err;
}
