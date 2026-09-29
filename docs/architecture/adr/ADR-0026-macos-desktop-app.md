# ADR-0026 — The macOS desktop app

- **Status:** Accepted (2026-09-29, the owner's answers below)
- **Date:** 2026-09-29
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0001 (Tauri 2; macOS signing, hardened runtime and
  notarization planned), ADR-0003 (OS watchers), ADR-0007 (keys),
  ADR-0012 (call type), ADR-0019 (pilot website), ADR-0022 (auto-update),
  ADR-0024 (presence check).
- **Confidence:** Medium. The architecture is already cross-platform: the
  core, sync, outbox, UI and sign-in are shared, and the key store uses
  `keyring` with `apple-native`. The unknowns are all macOS APIs:
  - call-type detection needs macOS 14 or later (§2);
  - signing and notarization need an Apple account;
  - and nothing has been compiled for macOS yet.

## Context

The owner asked to start the macOS app. Today:
- **Shared, no change needed:** the state machine, reminders, presence
  check, outbox (SQLCipher), sync, updater logic, all screens, and
  Entra sign-in (system browser with a loopback redirect).
- **Windows-only:** every OS watcher (idle, lock, sleep, network,
  mic/camera, call type), local time of day, the sign-in time for the
  8 am popup, and packaging (NSIS).
  - The non-Windows fallbacks are placeholders, for example UTC for
    local time (`reminders.rs`, `clock_in_prompt.rs`).
- **CI builds and tests Rust on Windows only.** No macOS build has ever
  run.
- **This machine is Windows.** A macOS app can't be built or signed on
  Windows. It needs a Mac, or a macOS CI runner.

## Decision

### 1. Target

- **Minimum: macOS 14 Sonoma** (owner: a few Mac users, all on 14 or
  later). Call-type detection works on every supported Mac.
- **One universal build** for Apple Silicon and Intel.
- **In the menu bar,** the macOS counterpart of the tray. The pinned
  strip works as it does on Windows.

### 2. Watchers, metadata only (invariant 1)

| Signal | macOS source | Permission prompt |
|---|---|---|
| Last input (idle, presence check) | `CGEventSourceSecondsSinceLastEventType` | None |
| Screen lock / unlock | `com.apple.screenIsLocked` / `…Unlocked` (distributed notifications) | None |
| Sleep / wake | `NSWorkspace` will-sleep / did-wake | None |
| Sign-in time (8 am popup) | Session start, plus the latest unlock and wake | None |
| Network up/down | `NWPathMonitor` | None |
| Mic or camera in use | Core Audio `DeviceIsRunningSomewhere`; CoreMediaIO for the camera | None |
| Call type (Teams / Zoom / other) | Core Audio process objects (macOS 14+): which process's bundle id is capturing input, matched to the ADR-0012 allowlist | **To verify** on the owner's Mac |
| Local time of day | `localtime_r` (replaces the UTC fallback) | None |

- Never used: app names beyond the allowlist match, window titles,
  screen content, Input Monitoring, and Accessibility.
- **The presence check (ADR-0024) works unchanged:** it only needs the
  last-input time.

### 3. Packaging and trust

- **Deliverables:**
  - a `.dmg` for the website;
  - `.app.tar.gz` plus `.sig` for the updater (ADR-0022, same signing
    key).
- **Apple Developer ID signing, hardened runtime, notarization and
  stapling** (as ADR-0001 planned). Without them, macOS 15 blocks the app
  until each user opens System Settings → Privacy & Security → Open
  Anyway. That's poor for a pilot.
  - This **needs an Apple Developer Program membership** (US$99 a year,
    in ApTask's name) and a Developer ID certificate.

### 4. Updates and website

- **Update API:** `/v1/desktop/update/darwin/:current` and
  `/files/darwin/:file` alongside Windows.
- **Releases:** `releases.json` per platform (`downloads/windows`,
  `downloads/macos`), and `publish-installer.sh` gains a platform
  argument.
- **The landing page** shows **Download for Mac** next to Windows, still
  behind Cloudflare Access.

### 5. Build and test

- **CI:** a `macos-latest` job that compiles, lints (clippy) and tests
  the Rust core on macOS on every PR. Private-repo macOS minutes are
  billed at a higher rate.
- **Signed builds:** on a Mac the owner controls (like today's Windows
  builds), or later a CI job holding the Apple and updater keys
  (ADR-0007 key custody).
- **Real-machine tests** on at least one Apple Silicon Mac before any
  tester gets it.

### Delivery (small PRs)

1. **CI macOS job,** and make the crate compile and pass tests on macOS
   (placeholders for the watchers).
2. **Idle, lock/unlock, sleep/wake, network, local time, sign-in time.**
3. **Mic/camera in use, then call type** (with the macOS 14 check).
4. **Packaging:** `.dmg`, signing and notarization, the `.app.tar.gz`
   updater artefact.
5. **Update API for darwin,** per-platform releases, and Download for
   Mac.
6. **Pilot on one or two Macs.**

## Consequences

- **Positive:**
  - Mac users get the same app, rules and privacy guarantees.
  - Most of the code is already shared.
- **Negative:**
  - A yearly Apple fee and a second build machine or runner.
  - Call type on macOS 13 is always "other".
  - macOS API behaviour (especially the Core Audio process list) must
    be verified on real hardware.
  - A second installer to publish for each release.

## Alternatives considered

- **Unsigned pilot builds.** Possible for one or two internal testers
  who follow the Gatekeeper steps, but not for rollout.
- **Mac App Store.** Rejected: the sandbox limits the system-wide
  signals, and it adds a review cycle.
- **Cross-compiling from Windows.** Not possible for signed macOS apps.

## Owner's answers (2026-09-29)

1. **Mac users:** a few, all on macOS 14 or later, so the minimum is
   macOS 14.
2. **Apple Developer Program:** ApTask already has an account. It's
   used for Developer ID signing and notarization.
3. **Build and test Mac:** the owner's Mac, as with Windows builds today.
4. **CI:** a `macos-latest` job on every PR (added in delivery step 1).
