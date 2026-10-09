import type { ShiftAlertKind } from '../db/index.js';

/**
 * The shift-start emails (ADR-0037 §3): plain text from CloudPunch's
 * mailbox, to the person with their manager (or Administrators and HR)
 * copied. Names and times only, nothing about what anyone was doing
 * (invariant 1).
 */
export interface ShiftMail {
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  text: string;
}

export interface ShiftMailInput {
  kind: ShiftAlertKind;
  name: string;
  /** Shift start, and the zone it is in. */
  start: Date;
  tz: string;
  /** For `late_clock_in`. */
  clockIn?: Date | null;
  graceMinutes: number;
  siteUrl: string;
}

/** "08:00" on the wall clock in `tz`. */
export function clockIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** "EDT", "GMT+5:30": the zone's short name at that moment. */
export function zoneName(tz: string, at: Date): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? tz
  );
}

/** "Fri 9 Oct". */
function dayIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(at)
    .replace(',', '');
}

export function shiftMailText(i: ShiftMailInput): { subject: string; text: string } {
  const zone = zoneName(i.tz, i.start);
  const start = `${clockIn(i.tz, i.start)} ${zone}`;
  const day = dayIn(i.tz, i.start);
  const team = `See Team in CloudPunch: ${i.siteUrl.replace(/\/$/, '')}/app/`;
  switch (i.kind) {
    case 'missed': {
      const by = clockIn(i.tz, new Date(i.start.getTime() + i.graceMinutes * 60_000));
      return {
        subject: `Not clocked in: ${i.name}, shift ${start}`,
        text: [
          `${i.name} hasn't clocked in. Their shift started at ${start} on ${day}, and no clock-in had reached CloudPunch by ${by}.`,
          '',
          "If you're working, clock in from CloudPunch now. If you aren't working today, say so in the app.",
          '',
          team,
        ].join('\n'),
      };
    }
    case 'late_clock_in': {
      const at = i.clockIn ?? i.start;
      const late = Math.max(0, Math.round((at.getTime() - i.start.getTime()) / 60_000));
      return {
        subject: `Clocked in late: ${i.name}, ${clockIn(i.tz, at)} (shift ${start})`,
        text: [
          `${i.name} clocked in at ${clockIn(i.tz, at)} ${zone} on ${day}, ${late} min after their shift started at ${start}.`,
          '',
          team,
        ].join('\n'),
      };
    }
    case 'not_working':
      return {
        subject: `Not working today: ${i.name} (shift ${start})`,
        text: [`${i.name} said they aren't working today, ${day} (shift ${start}).`, '', team].join(
          '\n',
        ),
      };
  }
}

/** Send `m` as `from` with CloudPunch's app token (Graph `sendMail`). */
export async function sendShiftMail(
  token: string,
  from: string,
  m: ShiftMail,
  opts: { fetch?: typeof fetch; base?: string } = {},
): Promise<void> {
  const base = opts.base ?? 'https://graph.microsoft.com/v1.0';
  const res = await (opts.fetch ?? fetch)(`${base}/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `[CloudPunch] ${m.subject}`,
        body: { contentType: 'Text', content: m.text },
        toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: m.cc.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
  if (res.status === 202 || res.ok) return;
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  throw new Error(json.error?.message ?? `sendMail HTTP ${res.status}`);
}
