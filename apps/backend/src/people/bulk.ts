import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { BulkKind, DbRepositories } from '../db/index.js';

/**
 * Bulk changes in the admin console (ADR-0038 §5): what every bulk
 * endpoint shares. At most 200 people a request; each request carries an
 * idempotency key (invariant 4), and its answer is kept in
 * `admin_bulk_request`, so a retry gets the same answer and changes
 * nothing.
 */

export const MAX_BULK = 200;

/** Key order doesn't matter: the same request always hashes the same. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

/** SHA-256 of the request without its key, to spot a reused key. */
export function requestHash(kind: BulkKind, body: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'idempotency_key'));
  return createHash('sha256')
    .update(JSON.stringify([kind, canonical(rest)]))
    .digest('hex');
}

/**
 * True when this key was used before and the answer is sent: the kept
 * one, or a refusal when the key was used for a different request.
 * False to go ahead. (A boolean, not the reply: a Fastify reply is
 * thenable, so an async function can't hand one back.)
 */
export async function replay(
  db: DbRepositories,
  reply: FastifyReply,
  actorUserId: string,
  key: string,
  kind: BulkKind,
  hash: string,
): Promise<boolean> {
  const kept = await db.bulkRequests.find(actorUserId, key);
  if (!kept) return false;
  if (kept.kind !== kind || kept.requestHash !== hash) {
    void reply.code(409).type('application/problem+json').send({
      code: 'idempotency_key_reused',
      message: 'this idempotency key was used for a different request',
    });
  } else {
    void reply.code(200).send(kept.result);
  }
  return true;
}

/** Runs `fn` over `items`, `limit` at a time, answers in order. */
export async function inTurn<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
