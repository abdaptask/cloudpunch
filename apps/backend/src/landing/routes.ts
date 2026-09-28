import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * A friendly page for someone who opens the API's address in a browser
 * (owner request): what this is and where to get the app. Static — no
 * scripts, no data, nothing about the user or the server — and served
 * with a CSP that allows nothing but its own inline styles.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>CloudPunch · ApTask</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f6fb; --card: #ffffff; --text: #0f1b33; --muted: #5d6675; --accent: #018afe; --navy: #012456; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --card: #141d2e; --text: #eaf2ff; --muted: #9aa8bf; --navy: #eaf2ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
         background: var(--bg); color: var(--text);
         font: 15px/1.55 "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif; }
  main { max-width: 440px; width: 100%; background: var(--card); border-radius: 18px; padding: 32px 28px;
         box-shadow: 0 10px 40px rgba(1, 36, 86, 0.10); }
  .mark { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #018afe, #00bfb5);
          display: grid; place-items: center; margin-bottom: 18px; }
  .mark svg { width: 24px; height: 24px; }
  h1 { margin: 0 0 6px; font-size: 22px; color: var(--navy); letter-spacing: -0.2px; }
  p { margin: 0 0 14px; color: var(--muted); }
  ol { margin: 0 0 18px; padding-left: 20px; color: var(--muted); }
  li { margin: 4px 0; }
  .ok { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
  footer { margin-top: 18px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>
  </div>
  <h1>CloudPunch</h1>
  <p>This is the service behind ApTask's CloudPunch time and attendance app. There's nothing to do here in a browser.</p>
  <ol>
    <li>Install the CloudPunch app your manager or HR sent you.</li>
    <li>Sign in with your ApTask Microsoft account.</li>
    <li>Clock in from the app.</li>
  </ol>
  <span class="ok"><span class="dot" aria-hidden="true"></span>Service is running</span>
  <footer>Questions? Ask your manager or HR.</footer>
</main>
</body>
</html>
`;

const landingRoutesImpl: FastifyPluginAsync = async (app) => {
  app.get('/', async (_req, reply) =>
    reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'public, max-age=300')
      .send(PAGE),
  );
  // Browsers ask for a favicon; answer quietly instead of logging 404s.
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
};

export const landingRoutes = fp(landingRoutesImpl, { name: 'cloudpunch-landing', fastify: '4.x' });
export default landingRoutes;
