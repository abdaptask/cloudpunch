import { randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';

/**
 * On-behalf-of token exchange (ADR-0020 §2): the signed-in admin's
 * CloudPunch API token becomes a Microsoft Graph token that carries
 * **their own** rights. Microsoft checks those rights on every Graph
 * call, so this server holds no standing directory power.
 *
 * CloudPunch proves who it is with a certificate (client assertion),
 * not a shared secret. The private key stays on the server and is never
 * sent anywhere.
 */

export interface OboConfig {
  tenantId: string;
  clientId: string;
  /** PKCS#8 PEM private key of the certificate uploaded to the app registration. */
  privateKeyPem: string;
  /** The certificate's SHA-1 thumbprint, base64url (`x5t`). */
  thumbprint: string;
  fetch?: typeof fetch;
  /** Override for tests. */
  authority?: string;
}

export class OboError extends Error {
  constructor(
    readonly code: 'consent_required' | 'not_permitted' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'OboError';
  }
}

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/** Graph access token for the user behind `userToken`. */
export async function graphTokenOnBehalfOf(cfg: OboConfig, userToken: string): Promise<string> {
  const authority = cfg.authority ?? 'https://login.microsoftonline.com';
  const tokenUrl = `${authority}/${cfg.tenantId}/oauth2/v2.0/token`;
  const key = await importPKCS8(cfg.privateKeyPem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', x5t: cfg.thumbprint })
    .setIssuer(cfg.clientId)
    .setSubject(cfg.clientId)
    .setAudience(tokenUrl)
    .setJti(randomUUID())
    .setNotBefore(now - 30)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: cfg.clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    assertion: userToken,
    scope: GRAPH_SCOPE,
    requested_token_use: 'on_behalf_of',
  });
  let res: Response;
  try {
    res = await (cfg.fetch ?? fetch)(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    throw new OboError('unavailable', `token endpoint unreachable: ${String(err)}`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (res.ok && typeof json.access_token === 'string') return json.access_token;
  // AADSTS65001: consent missing for the Graph permissions.
  if (json.error === 'invalid_grant' && /AADSTS65001/.test(json.error_description ?? '')) {
    throw new OboError('consent_required', 'admin consent for Microsoft Graph is missing');
  }
  if (res.status >= 400 && res.status < 500) {
    throw new OboError('not_permitted', json.error ?? `HTTP ${res.status}`);
  }
  throw new OboError('unavailable', json.error ?? `HTTP ${res.status}`);
}
