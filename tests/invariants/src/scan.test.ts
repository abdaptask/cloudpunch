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

// Each scanner must catch a planted violation, or the real checks
// would pass vacuously.

describe('bannedFields', () => {
  it('flags content-capture names and allows the two legitimate ones', () => {
    expect(
      bannedFields(['in_use', 'window_title', 'keystrokes', 'app_version', 'hostname_hash']),
    ).toEqual(['keystrokes', 'window_title']);
    expect(bannedFields(['page_url', 'Screenshot_path', 'mic_audio_frame'])).toEqual([
      'Screenshot_path',
      'mic_audio_frame',
      'page_url',
    ]);
  });
});

describe('field extraction', () => {
  it('reads keys from JSON, schema properties, TS objects and Rust json!', () => {
    expect([...jsonKeys({ a: { window_title: 1 }, b: [{ c: 2 }] })].sort()).toEqual([
      'a',
      'b',
      'c',
      'window_title',
    ]);
    expect([
      ...schemaFields({ properties: { in_use: {}, nested: { properties: { url: {} } } } }),
    ]).toEqual(expect.arrayContaining(['in_use', 'nested', 'url']));
    expect([...tsFields('const s = z.object({\n  clipboard_text: z.string(),\n});')]).toContain(
      'clipboard_text',
    );
    expect([
      ...rustJsonKeys('json!({ "break_kind": k }); p.insert("window_title".into(), v);'),
    ]).toEqual(['break_kind', 'window_title']);
  });
});

describe('forbidden APIs and crates', () => {
  it('finds capture APIs, including their Win32 suffixed names', () => {
    // The real Win32 names carry A/W/Ex suffixes; all must be caught.
    expect(usesAny('let t = GetWindowTextW(hwnd);', FORBIDDEN_RUST_APIS)).toEqual([
      'GetWindowText',
    ]);
    expect(usesAny('GetWindowTextLengthW(h)', FORBIDDEN_RUST_APIS)).toEqual(['GetWindowText']);
    expect(usesAny('MyGetWindowText()', FORBIDDEN_RUST_APIS)).toEqual([]);
    expect(usesAny('SetWindowsHookEx(WH_KEYBOARD_LL, ..)', FORBIDDEN_RUST_APIS)).toEqual([
      'SetWindowsHookEx',
      'WH_KEYBOARD',
    ]);
    expect(usesAny('GetLastInputInfo(&mut info)', FORBIDDEN_RUST_APIS)).toEqual([]);
    expect(usesAny('await navigator.clipboard.readText()', FORBIDDEN_WEB_APIS)).toEqual([
      'navigator.clipboard',
    ]);
  });

  it('reads dependency names from every Cargo dependency table', () => {
    const toml = [
      '[package]',
      'name = "x"',
      '[dependencies]',
      'serde = "1"',
      'arboard = "3"',
      "[target.'cfg(windows)'.dependencies]",
      'windows = { version = "0.58" }',
      '[dev-dependencies]',
      'rand = "0.8"',
    ].join('\n');
    expect(cargoDependencies(toml)).toEqual(['serde', 'arboard', 'windows', 'rand']);
    expect(exactlyAny(cargoDependencies(toml), FORBIDDEN_CRATES)).toEqual(['arboard']);
    // Exact: a crate merely starting with a banned name isn't flagged.
    expect(exactlyAny(['cpal-sys-helper', 'serde'], FORBIDDEN_CRATES)).toEqual([]);
  });
});

describe('appendOnlyViolations', () => {
  it('flags UPDATE, DELETE and TRUNCATE on the append-only tables only', () => {
    expect(appendOnlyViolations('UPDATE time_event SET payload = $1')).toHaveLength(1);
    expect(appendOnlyViolations('delete from audit_log where id = 1')).toHaveLength(1);
    expect(appendOnlyViolations('TRUNCATE TABLE time_event')).toHaveLength(1);
    // Trigger definitions and other tables are fine.
    expect(appendOnlyViolations('CREATE TRIGGER t BEFORE UPDATE ON time_event')).toEqual([]);
    expect(appendOnlyViolations('UPDATE time_session SET closed_at = now()')).toEqual([]);
    expect(appendOnlyViolations('DELETE FROM policy_override WHERE scope = $1')).toEqual([]);
  });
});
