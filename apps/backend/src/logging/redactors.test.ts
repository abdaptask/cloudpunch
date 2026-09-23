import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';

function captureLog(fn: (log: ReturnType<typeof createLogger>) => void): unknown {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  });
  try {
    const log = createLogger({
      level: 'debug',
      pretty: false,
      serviceName: 'test',
      appVersion: '0.0.0',
      env: 'test',
    });
    fn(log);
  } finally {
    spy.mockRestore();
    // paranoia: rebind in case pino held a reference
    process.stdout.write = origWrite;
  }
  const joined = chunks.join('');
  return joined.length > 0 ? JSON.parse(joined.trim().split('\n')[0]!) : {};
}

describe('logger redaction', () => {
  it('redacts Authorization header from req log', () => {
    const line = captureLog((log) => {
      log.info({ req: { headers: { authorization: 'Bearer supersecret' } } }, 'incoming');
    }) as { req?: { headers?: { authorization?: string } } };
    expect(line.req?.headers?.authorization).toBe('***REDACTED***');
  });

  it('redacts refresh_token wherever it appears', () => {
    const line = captureLog((log) => {
      log.info({ tokens: { refresh_token: 'rt_abcdef' } }, 'exchange');
    }) as { tokens?: { refresh_token?: string } };
    expect(line.tokens?.refresh_token).toBe('***REDACTED***');
  });

  it('redacts client_secret and api_key', () => {
    const line = captureLog((log) => {
      log.info({ cfg: { client_secret: 'x', api_key: 'y' } }, 'cfg');
    }) as { cfg?: { client_secret?: string; api_key?: string } };
    expect(line.cfg?.client_secret).toBe('***REDACTED***');
    expect(line.cfg?.api_key).toBe('***REDACTED***');
  });

  it('redacts integrity_signature and webhook_signing_key', () => {
    const line = captureLog((log) => {
      log.info(
        { evt: { integrity_signature: 'sig' }, hook: { webhook_signing_key: 'key' } },
        'signed',
      );
    }) as {
      evt?: { integrity_signature?: string };
      hook?: { webhook_signing_key?: string };
    };
    expect(line.evt?.integrity_signature).toBe('***REDACTED***');
    expect(line.hook?.webhook_signing_key).toBe('***REDACTED***');
  });

  it('leaves non-sensitive fields alone', () => {
    const line = captureLog((log) => {
      log.info({ oid: 'abc-123', route: '/timesheet' }, 'ok');
    }) as { oid?: string; route?: string };
    expect(line.oid).toBe('abc-123');
    expect(line.route).toBe('/timesheet');
  });
});
