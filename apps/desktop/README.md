# @cloudpunch/desktop

CloudPunch employee time and attendance desktop agent for Windows and
macOS. Tauri 2 shell around a small React UI, with a Rust core that
handles OS integration (idle, screen lock, sleep, mic/camera state),
Ed25519 event signing, and the local encrypted outbox.

## Layout

```
package.json          — Node workspace member; scripts + JS deps
tsconfig.json         — extends the repo base (adds DOM lib + jsx)
vite.config.ts        — Vite dev server on port 1420 (Tauri convention)
index.html            — Vite entry
src/                  — React UI (renders inside the Tauri webview)
  main.tsx            — routes on window label: main → App,
                        idle-prompt → PromptWindow
  api.ts              — typed wrappers for the agent's commands and
                        the cp://state event
  ui/                 — theme tokens (light/dark) and Button
  TimelineView.tsx    — today's day strip + segment list
  timelineModel.ts    — pure timeline helpers (clip, totals, format)
src-tauri/            — Rust crate (Tauri backend, OS integration)
  Cargo.toml
  build.rs
  tauri.conf.json     — Tauri 2 configuration
  capabilities/       — least-privilege permissions for the main and
                        idle-prompt windows
  icons/              — App icons (see icons/README.md)
  src/
    main.rs           — Process entry
    lib.rs            — Tauri app builder, watchers, ticker wiring
    agent.rs          — runs the state machine: shared lock, 1 Hz
                        tick, prompt window, tray, cp://state
    timeline.rs       — today's tracked segments for the home window
    commands.rs       — Tauri commands (clock in/out, breaks, prompt)
    machine/          — Pure time-state machine (no I/O); idle +
                        grace timers, media debounce (ADR-0003/8/9)
      transitions.rs  — Rust mirror of the backend `nextState`,
                        checked against the shared fixture
dist/                 — Vite output (git-ignored)
src-tauri/target/     — Cargo output (git-ignored)
```

## Prerequisites

- Node >= 20 and pnpm (via corepack) — see repo root `README.md`
- Rust stable (rustup); the workspace pins the toolchain via rust
  version in `Cargo.toml` `[workspace.package]`
- Platform-specific dev tooling:
  - Windows: Windows SDK + Visual Studio Build Tools (usually already
    present on developer machines)
  - macOS: Xcode Command Line Tools

## Scripts

- `pnpm -F @cloudpunch/desktop dev` — full Tauri dev (starts Vite,
  builds the Rust core in debug, opens the app window)
- `pnpm -F @cloudpunch/desktop vite:dev` — Vite only (useful when
  iterating on the React UI without recompiling Rust)
- `pnpm -F @cloudpunch/desktop build` — production build (bundle
  disabled at this slice; will produce a signed installer later)
- `pnpm -F @cloudpunch/desktop typecheck` — TS strict typecheck of the
  UI
- `pnpm -F @cloudpunch/desktop test` — Vitest unit tests

The Rust side is checked from the repo root via:

```
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Status

Phase 2b.1 scaffold: window opens, React renders, Tauri API returns
the app version. No auth, no OS watchers, no outbox yet. Those land
in slices 2b.2 through 2b.9.
