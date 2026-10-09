import { AppRole } from '@cloudpunch/shared';
import type { FastifyRequest } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import { RoleNotes } from './roles.js';

const req = (oid: string, roles: AppRole[]) =>
  ({
    auth: {
      oid,
      tid: 't',
      scope: [],
      roles,
      preferredUsername: null,
      exp: 0,
      iat: 0,
      jti: null,
    },
  }) as unknown as FastifyRequest;

describe('remembering roles (ADR-0037)', () => {
  it('notes the roles a token carries, writing only when they change', async () => {
    const db = new InMemoryDb();
    let writes = 0;
    const note = db.roles.note.bind(db.roles);
    db.roles.note = async (...a) => {
      writes += 1;
      return note(...a);
    };
    const notes = new RoleNotes(db, pino({ level: 'silent' }));
    await notes.fromRequest(req('o1', [AppRole.Employee, AppRole.Administrator]));
    await notes.fromRequest(req('o1', [AppRole.Administrator, AppRole.Employee]));
    expect(writes).toBe(1);
    expect(db.roleSeen.get('o1')).toEqual({
      roles: ['Administrator', 'Employee'],
      source: 'token',
    });
    await notes.fromRequest(req('o1', [AppRole.Employee]));
    expect(writes).toBe(2);
    // No token: nothing.
    await notes.fromRequest({} as FastifyRequest);
    expect(writes).toBe(2);
  });
});
