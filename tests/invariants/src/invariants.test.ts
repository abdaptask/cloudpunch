import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_CRATES,
  FORBIDDEN_RUST_APIS,
  FORBIDDEN_WEB_APIS,
  appendOnlyViolations,
  bannedFields,
  cargoDependencies,
  exactlyAny,
  jsonKeys,
  rustJsonKeys,
  schemaFields,
  tsFields,
  usesAny,
} from './scan.js';

/**
 * The real checks, over the repository (CLAUDE.md "Non-negotiable
 * invariants" 1 and 2; ADR-0004 §10). A failure here blocks the merge.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function files(relDir: string, ext: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'target') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (ext.test(name)) out.push(path.relative(ROOT, full).replaceAll('\\', '/'));
    }
  };
  walk(path.join(ROOT, relDir));
  return out.sort();
}

describe('invariant 1: no content capture', () => {
  it('no event or signed field is named after captured content', () => {
    const fields = new Set<string>();
    // Event JSON Schemas and the shared fixtures.
    for (const f of files('packages/event-schema/schemas', /\.json$/)) {
      schemaFields(JSON.parse(read(f)), fields);
    }
    for (const f of files('packages/event-schema/fixtures', /\.json$/)) {
      jsonKeys(JSON.parse(read(f)), fields);
    }
    // The signed field set and the backend's ingest schema.
    tsFields(read('packages/event-schema/src/canonicalize.ts')).forEach((f) => fields.add(f));
    tsFields(read('apps/backend/src/events/schemas.ts')).forEach((f) => fields.add(f));
    // What the desktop actually writes into events.
    for (const f of [
      'apps/desktop/src-tauri/src/machine/mod.rs',
      'apps/desktop/src-tauri/src/event/encode.rs',
      'apps/desktop/src-tauri/src/recorder.rs',
    ]) {
      rustJsonKeys(read(f)).forEach((k) => fields.add(k));
    }

    // Sanity: the scan really saw the event model.
    expect(fields).toContain('break_kind');
    expect(fields).toContain('call_type');
    expect(fields).toContain('integrity_signature');
    expect(bannedFields(fields)).toEqual([]);
  });

  it('the desktop agent calls no content-capturing Windows API', () => {
    const rs = files('apps/desktop/src-tauri/src', /\.rs$/);
    expect(rs.length).toBeGreaterThan(20);
    const hits = rs.flatMap((f) =>
      usesAny(read(f), FORBIDDEN_RUST_APIS).map((api) => `${f}: ${api}`),
    );
    expect(hits).toEqual([]);
  });

  it('the desktop agent depends on no capture crate', () => {
    const deps = cargoDependencies(read('apps/desktop/src-tauri/Cargo.toml'));
    expect(deps).toContain('tauri');
    expect(exactlyAny(deps, FORBIDDEN_CRATES)).toEqual([]);
  });

  it('the desktop webview uses no clipboard, screen, camera or microphone API', () => {
    const ts = files('apps/desktop/src', /\.(ts|tsx)$/);
    const hits = ts.flatMap((f) =>
      usesAny(read(f), FORBIDDEN_WEB_APIS).map((api) => `${f}: ${api}`),
    );
    expect(hits).toEqual([]);
  });
});

describe('invariant 2: time_event and audit_log are append-only', () => {
  it('no migration or backend code updates, deletes or truncates them', () => {
    const sources = [
      ...files('apps/backend/db/migrations', /\.sql$/),
      ...files('apps/backend/src', /\.ts$/),
      ...files('apps/backend/scripts', /\.ts$/),
    ]
      // ADR-0004 §10 exception. Tests are excluded: integration tests
      // prove the triggers *reject* UPDATE/DELETE, and reset their DB.
      .filter((f) => !f.includes('/retention_worker/') && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(10);
    const hits = sources.flatMap((f) => appendOnlyViolations(read(f)).map((s) => `${f}: ${s}`));
    expect(hits).toEqual([]);
  });
});
