# @cloudpunch/event-schema

Source of truth for the CloudPunch `time_event` ledger. See
[ADR-0004](../../docs/architecture/adr/ADR-0004-event-model.md) for the
"why".

## Layout

```
event-types.json                  — enum of every allowed event_type
canonicalization.md               — the exact signing byte-order spec
schemas/
  common/
    base-event.schema.json        — envelope common to every event
  user-clock-in.schema.json       — one payload per event_type
  user-prompt-response.schema.json
  media-device-state.schema.json  — { in_use } only (ADR-0009)
  input-idle-5m.schema.json       — optional trigger (ADR-0010)
  user-mark-away.schema.json      — away_reason + note (ADR-0011)
  … (more added as Phase 2 lands the desktop agent)
fixtures/
  state-transitions.json          — payroll-state transition table run
                                    by both the backend and desktop
                                    state-machine tests
```

## Rules

- **Never rename an existing `event_type` value.** Add a new one and
  deprecate the old one instead. Existing rows in `time_event` cannot
  be silently reinterpreted.
- **Every payload schema uses `additionalProperties: false`.** New
  fields require an ADR update and a schema version bump.
- **No banned surveillance fields**, ever. A CI check in
  `tests/invariants/no-content-capture.ts` (Phase 2) greps this
  directory for `keystroke`, `screenshot`, `clipboard`, `filename`,
  `window_title`, `app_name`, `browser_history`, `mic_audio`,
  `audio_frame`, `camera_frame`, `webcam`, `geolocation` and fails the
  build on any match.

## Consumers

- `apps/backend/src/event/*` — validates every ingested event.
- `apps/desktop/src-tauri/src/event/*` — validates every emitted event
  (belt and braces).
- `packages/shared` (Phase 2) — codegen'd TypeScript types.

The desktop Rust code and the backend TypeScript code must both
produce byte-identical canonical bytes for the same event — see
`canonicalization.md`.
