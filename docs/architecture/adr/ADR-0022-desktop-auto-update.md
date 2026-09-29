# ADR-0022 — Desktop auto-update at the first sign-in of the day

- **Status:** Accepted (2026-09-29, approved by the project owner)
- **Date:** 2026-09-29
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0001 (Tauri updater chosen), ADR-0007 §6 (updater
  signing key; amended here for the pilot), ADR-0018 §4 (first sign-in of
  the day), ADR-0019 (pilot VM, website, `publish-installer.sh`).
- **Confidence:** Medium-high (about 85%). The Tauri 2 updater plugin is
  the documented mechanism and the pilot installer already installs per
  user (no admin prompt). Not yet verified: a real 0.1.x → 0.1.y update on
  a pilot laptop, and that the plugin sends our `Authorization` header on
  the download as well as the check (§3).

## Context

Every release so far means each tester downloads and runs the new
installer by hand. The owner asked that:
- the app **updates itself**;
- an update **never loses that day's data**;
- ideally it happens **when they sign in for the day for the first time**.

What the app does today on a restart (verified in code):
- Every punch is written to the encrypted local outbox (SQLCipher,
  phase 2b.3) before it's sent, so unsent events survive a restart.
- The day's timeline is rebuilt from the outbox on start
  (`Agent::restore_today`, test
  `today_is_journaled_and_restored_after_a_restart`).
- **But the app always starts clocked out.** An open session is closed at
  the last recovered heartbeat. So a restart *while clocked in* would end
  the person's session: nothing is lost, but they'd have to clock in
  again, and the gap would show on their day.

That last point decides *when* an update may install.

## Decision

1. **Use the Tauri 2 updater plugin** (`tauri-plugin-updater`), as
   ADR-0001 planned. Every update is signed with our Ed25519 key, and the
   app refuses any file whose signature doesn't match the public key
   built into it.
2. **Download early, install only at a safe moment.**
   - The app checks at start and every 4 hours, and downloads a new
     version quietly in the background.
   - It **installs only when all of these hold:**
     - the person is **clocked out**;
     - nothing is tracked yet in the current working day
       (`worked_today == false`, ADR-0016 §1).
   - Unsent events need no special handling: they're already on disk in
     the outbox and are sent after the restart.
   - **When:** at the first Windows sign-in, unlock or wake of the day
     (the same signal ADR-0018 §4 uses), or at app start if those
     conditions hold. That's normally first thing in the morning, before
     they clock in.
   - It installs quietly (NSIS passive mode) and restarts the app, which
     takes a few seconds. The 8 am clock-in popup then works as usual.
   - **Clocked in means no restart, ever.** The update waits for the next
     safe moment.
   - The tray tooltip shows "Update ready: restarts next time you
     sign in" so it's never a surprise.
3. **Served by the API, not the website.** `/download*` is behind
   Cloudflare Access, which the desktop app can't sign in to.
   - `GET /v1/desktop/update/windows/{current_version}` returns the Tauri
     update manifest (version, notes, signature, URL), or 204 when there's
     nothing newer. It requires the app's normal Entra bearer token.
   - The installer itself is served from `/v1/desktop/update/files/...`
     with the same token.
   - So no Cloudflare rule changes, and no public path.
   - **Fallback, if the plugin won't send our header on the download:**
     serve the signed file from a public `/updates/*` path that skips
     Access. That's acceptable because it's the same installer anyone at
     ApTask can download, and the app won't run anything unsigned.
4. **Publishing stays one command.** The pilot build signs the update
   (the `TAURI_SIGNING_PRIVATE_KEY` environment variable), and
   `scripts/publish-installer.sh` also uploads the signature and records
   it in `releases.json`. The newest release there is what the app is
   offered. The website Download button is unchanged.
5. **Signing key for the pilot (amends ADR-0007 §6 until AWS).**
   - Generated once with `pnpm tauri signer generate`, protected by a
     password.
   - The private key and password live on the owner's build machine,
     with a backup in the owner's password manager. They are never
     committed and never put on the VM.
   - ADR-0007 §6 (AWS Secrets Manager, release job) applies once the
     production build pipeline exists.
6. **Privacy (invariant 1).** The check sends only the app's version and
   the token it already sends on every call. Nothing new is collected.
   The API logs the version, which also tells us who is on an old build.

## Consequences

- **Positive:**
  - Publishing a release reaches every tester within a day, with no
    action from them.
  - A session is never cut short by an update.
  - The same mechanism carries to production. Only the key custody moves
    (ADR-0007 §6).
- **Negative:**
  - **One last manual install.** Copies installed today can't update
    themselves, so testers install the first version with the updater
    by hand.
  - **If the signing key is lost**, updates stop until everyone
    reinstalls by hand with a new key. If it leaks, someone with access
    to our update path could push a build. Hence the password and the
    backup rules in §5.
  - Someone who stays clocked in for days, or never signs out or unlocks,
    gets the update late. The next reboot or morning unlock catches it.
  - The install needs no admin prompt only because the pilot installer is
    per-user (`installMode: currentUser`). A per-machine install would
    prompt for admin on every update.
- **Risks to verify in the first build:**
  - The NSIS update keeps `%APPDATA%` (outbox, enrollment, key store).
    This is expected, because uninstall is what removes data, but it's
    tested on a real laptop before we rely on it.
  - A restart while an idle or clock-in popup is open. Covered by the
    "clocked out, nothing today" rule, but tested.

## Alternatives considered

- **Install as soon as it's downloaded.** Rejected: it could restart the
  app mid-session and clock the person out.
- **Install at clock-out.** Rejected as the main trigger because the
  owner asked for first sign-in. It would also restart the app while the
  person is still reading their end-of-day summary. It's kept as an
  option if first sign-in proves too rare.
- **Ask the user ("Update now?").** Rejected: the owner wants it
  automatic, and a prompt at 8 am competes with the clock-in popup.
- **Serve updates from the website behind Access.** Not possible: the
  desktop app can't complete a Cloudflare Access login.
- **A custom updater (download and run the installer ourselves).**
  Rejected: it would redo signature checking that Tauri already does
  well.
