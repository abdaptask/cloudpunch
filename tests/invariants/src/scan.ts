/**
 * Pure scanners for the CI invariants (CLAUDE.md "Non-negotiable
 * invariants", ADR-0004 §10). Kept separate from the repo walk so each
 * rule is unit-tested against planted violations.
 */

/**
 * ADR-0004 §10: no event or signed field may be named after captured
 * content. `app_version` and `hostname_hash` are legitimate.
 */
export const BANNED_FIELD =
  /(keystroke|screenshot|screen_capture|clipboard|filename|window_title|app_name|url|browser_history|mic_audio|audio_frame|camera_frame|webcam|geolocation)/i;

export const FIELD_ALLOWLIST: ReadonlySet<string> = new Set(['app_version', 'hostname_hash']);

/** Field names that break the rule. */
export function bannedFields(names: Iterable<string>): string[] {
  const hits = new Set<string>();
  for (const n of names) {
    if (!FIELD_ALLOWLIST.has(n) && BANNED_FIELD.test(n)) hits.add(n);
  }
  return [...hits].sort();
}

/** Every object key in a JSON value, recursively. */
export function jsonKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) jsonKeys(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      jsonKeys(v, out);
    }
  }
  return out;
}

/**
 * Property names a JSON Schema declares (walks `properties` and
 * `required` at any depth; schema keywords themselves are not fields).
 */
export function schemaFields(schema: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) schemaFields(s, out);
  } else if (schema !== null && typeof schema === 'object') {
    const obj = schema as Record<string, unknown>;
    const props = obj['properties'];
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const k of Object.keys(props)) out.add(k);
    }
    const required = obj['required'];
    if (Array.isArray(required)) {
      for (const r of required) if (typeof r === 'string') out.add(r);
    }
    for (const v of Object.values(obj)) schemaFields(v, out);
  }
  return out;
}

/** Keys of Zod `z.object({ key: … })` literals and quoted field lists in TS. */
export function tsFields(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gm)) out.add(m[1] as string);
  for (const m of source.matchAll(/'([a-z][a-z0-9]*_[a-z0-9_]+)'/g)) out.add(m[1] as string);
  return out;
}

/** JSON keys written by Rust: `"key": …` in `json!` and `.insert("key"`. */
export function rustJsonKeys(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/"([a-z][a-z0-9_]*)"\s*:/g)) out.add(m[1] as string);
  for (const m of source.matchAll(/insert\(\s*"([a-z][a-z0-9_]*)"/g)) out.add(m[1] as string);
  return out;
}

/**
 * APIs and crates that would capture content (CLAUDE.md invariant 1):
 * window titles, the foreground app, the clipboard, keystrokes, the
 * screen, audio or camera frames. `GetLastInputInfo` (idle time only)
 * and the audio *session* list used for call detection (ADR-0012) are
 * not on it.
 */
export const FORBIDDEN_RUST_APIS = [
  'GetWindowText',
  'GetForegroundWindow',
  'GetClipboardData',
  'OpenClipboard',
  'SetWindowsHookEx',
  'WH_KEYBOARD',
  'GetAsyncKeyState',
  'GetKeyboardState',
  'BitBlt',
  'PrintWindow',
  'GraphicsCaptureItem',
  'IAudioCaptureClient',
  'IMFSourceReader',
] as const;

export const FORBIDDEN_CRATES = [
  'screenshots',
  'xcap',
  'scrap',
  'arboard',
  'clipboard',
  'copypasta',
  'rdev',
  'device_query',
  'inputbot',
  'cpal',
  'nokhwa',
  'active-win-pos-rs',
] as const;

/** Browser APIs the desktop webview must never use. */
export const FORBIDDEN_WEB_APIS = [
  'navigator.clipboard',
  'getDisplayMedia',
  'getUserMedia',
  'MediaRecorder',
] as const;

const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which of `names` start an identifier in `source`. Prefix matching, so
 * the real Win32 names (`GetWindowTextW`, `SetWindowsHookExW`,
 * `WH_KEYBOARD_LL`) are caught too.
 */
export function usesAny(source: string, names: readonly string[]): string[] {
  return names.filter((n) => new RegExp(`(^|[^A-Za-z0-9_])${escape(n)}`).test(source));
}

/** Which of `names` are in `list` exactly (crate names). */
export function exactlyAny(list: readonly string[], names: readonly string[]): string[] {
  return names.filter((n) => list.includes(n));
}

/** Dependency names declared in a Cargo.toml (`name = …` under a deps table). */
export function cargoDependencies(toml: string): string[] {
  const deps: string[] = [];
  let inDeps = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inDeps = /dependencies\]$/.test(line);
      continue;
    }
    const m = inDeps ? /^([A-Za-z0-9_-]+)\s*=/.exec(line) : null;
    if (m) deps.push(m[1] as string);
  }
  return deps;
}

/**
 * CLAUDE.md invariant 2: `time_event` (and `audit_log`) are append-only.
 * Returns each offending statement fragment.
 */
export function appendOnlyViolations(source: string): string[] {
  const re =
    /\b(UPDATE\s+(?:ONLY\s+)?"?(time_event|audit_log)"?\s+SET\b|DELETE\s+FROM\s+(?:ONLY\s+)?"?(time_event|audit_log)"?\b|TRUNCATE\s+(?:TABLE\s+)?"?(time_event|audit_log)"?\b)/gi;
  return [...source.matchAll(re)].map((m) => m[0]);
}
