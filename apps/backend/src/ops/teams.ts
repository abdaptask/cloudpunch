/**
 * Posts to a Teams channel (ADR-0043): an incoming webhook, either the
 * Office 365 connector kind or a Workflows "post to a channel when a
 * webhook request is received" flow. Both take the Adaptive Card
 * message below. Plain words only: names, times and counts, never idle
 * explanations, notes or locations (invariant 1).
 */
export interface TeamsPost {
  title: string;
  /** Lines of text under the title. */
  lines: readonly string[];
  /** Name–value rows (e.g. "Shift" – "09:00 IST"). */
  facts?: readonly { title: string; value: string }[];
  /** A button that opens CloudPunch. */
  link?: { title: string; url: string };
  /** Red accent for problems. */
  attention?: boolean;
}

/** The webhook body: one Adaptive Card. */
export function teamsBody(p: TeamsPost): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    {
      type: 'TextBlock',
      text: p.title,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      ...(p.attention ? { color: 'Attention' } : {}),
    },
    ...p.lines.map((text) => ({ type: 'TextBlock', text, wrap: true, spacing: 'Small' })),
  ];
  if (p.facts && p.facts.length > 0) {
    body.push({
      type: 'FactSet',
      facts: p.facts.map((f) => ({ title: f.title, value: f.value })),
    });
  }
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          ...(p.link
            ? { actions: [{ type: 'Action.OpenUrl', title: p.link.title, url: p.link.url }] }
            : {}),
        },
      },
    ],
  };
}

/** Post `p` to the webhook; throws on an HTTP error. */
export async function postTeams(
  url: string,
  p: TeamsPost,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const res = await (opts.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(teamsBody(p)),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new Error(`Teams webhook HTTP ${res.status}`);
}
