# ADR-0034 — One-click desktop releases built on GitHub, pulled by the pilot server

- **Status:** Accepted (2026-10-08, the owner chose the recommended answer to each question)
- **Date:** 2026-10-08
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0019 §9 (downloads on the pilot VM, behind
  Cloudflare Access), ADR-0022 (signed auto-update), ADR-0026 (Mac app:
  Developer ID and notarization), ADR-0007 (secrets).
- **Confidence:** High on the shape (Tauri builds on GitHub's Windows
  and macOS runners are routine). Medium on the Mac signing step until
  the first run, because it moves the certificate out of the Mac's
  keychain.

## Context

Every desktop release today is two manual builds on two machines:

- `build-windows.ps1 -Publish` on the owner's PC;
- `build-mac.sh --publish` on the owner's Mac. That needs the Mac's
  copy up to date, the SSH key loaded, the right Apple ID and two
  passwords.

On 2026-10-08 that went wrong three ways:

- notarization failed with the wrong Apple ID;
- publishing failed because the SSH key wasn't loaded;
- Windows had 0.1.23 for an hour before Mac did, because the Mac's
  copy hadn't been pulled.

`build-mac.sh` now catches each of those (#128). The real fix is to stop
depending on a person's machines for a release.

Facts that shape the decision:

- **The repository is public.** Anything a workflow uploads (release
  assets, and artifacts while they're kept) can be downloaded by others.
  The pilot's downloads are deliberately behind Cloudflare Access
  (ADR-0019 §9), so publishing installers openly on GitHub would undo
  that.
- **The pilot server can't be reached from GitHub.** It is on ApTask's
  internal network. Only the Cloudflare Tunnel reaches it, and that
  serves the site, not SSH. It does reach the internet (it already
  fetches the IP database daily, `cloudpunch-dbip-update.timer`).
- **The updater checks signatures itself.** Each app refuses an update
  that isn't signed with CloudPunch's updater key (ADR-0022). So the
  path a file takes to the server doesn't decide whether people run a
  tampered update; the signature does.
- **Windows isn't Authenticode-signed today**, only updater-signed.
  That doesn't change here.

## Decision

### 1. The owner starts a release with one click

A **Release** workflow (`.github/workflows/release.yml`):

- **Run by hand.** It runs from GitHub's _Actions → Release → Run
  workflow_ on `main`, with a "what's new" box (one note per line). It
  never runs on a push, a tag or a pull request, so nobody outside can
  start it.
- **The version comes from the code**, not the form:
  `apps/desktop/src-tauri/tauri.conf.json`, bumped in a PR as now. The
  workflow refuses a version that is already released.
- **Approval gate.** The jobs that use the signing keys run in a GitHub
  environment named `release`, with the owner as its required reviewer.
  A run waits for the owner's approval before any secret is available
  to it, even if someone else with write access starts it.
- **Pinned actions.** Third-party actions are pinned to a commit hash,
  not a tag.

### 2. Both builds on GitHub's runners

They run in parallel:

- **Windows** (`windows-latest`): the NSIS installer, signed for
  auto-update. This is what `build-windows.ps1` does today.
- **Mac** (`macos-latest`): the universal app.
  - Signed with the Developer ID certificate, imported from a secret
    into a temporary keychain that's deleted after the job.
  - Notarized as `admin@aptask.com` with the app-specific password, as
    `build-mac.sh` does today.

Both builds use the pilot configs (`tauri.pilot*.conf.json`), so the
apps point at `https://cloudpunch.aptask.com`. The workflow runs the
same checks `publish-installer.sh` runs before anything is published.

### 3. Delivery: encrypted on GitHub, pulled by the pilot server

- **Encrypted before upload.** Each job encrypts its files with
  [age](https://age-encryption.org) to the pilot server's public key
  before uploading them as workflow artifacts. They're kept 1 day and
  are useless to anyone without the server's private key. A manifest
  goes with them: version, notes, sizes, sha256 and updater signatures.
- **The server pulls them.** A new timer on the server,
  `cloudpunch-release-pull.timer`, runs every 5 minutes. It looks for
  the newest successful Release run whose version isn't published yet.
  It then:
  - downloads the artifacts with a read-only GitHub token (fine-grained,
    this repository, _Actions: read_ only);
  - decrypts them and checks the sha256 values;
  - publishes them the way `publish-installer.sh` does: files in
    `/opt/cloudpunch/downloads/{windows,macos}`, the release added to
    `releases.json`, the newest 3 kept.

  So a release reaches both platforms within about 5 minutes of the
  workflow finishing, with nothing left on GitHub after a day.
- **One copy of the publishing logic.** The publishing steps move into
  one server-side script, used by both the timer and
  `publish-installer.sh`.

### 4. The manual scripts stay

`build-windows.ps1 -Publish` and `build-mac.sh --publish` keep working
as the fallback when GitHub is down or a release is urgent.

### 5. Secrets

These live in the `release` environment, never in the repo. Each one
is also in the password manager (ADR-0007).

| Secret                               | What                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | `updater.key` (the same key as today)                     |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password                                              |
| `APPLE_CERTIFICATE`                  | the Developer ID Application certificate and key, `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD`         | the `.p12` export password                                |
| `APPLE_ID`                           | `admin@aptask.com`                                        |
| `APPLE_PASSWORD`                     | the app-specific password made under it                   |
| `APPLE_TEAM_ID`                      | the 10-character Team ID                                  |

Two more aren't secrets:

- `RELEASE_AGE_RECIPIENT`, the server's age public key, is an
  environment variable.
- The server's age private key and its GitHub token live only on the
  server, in `/etc/cloudpunch/release-pull.env` (root, 0600).

## Owner steps (once, about 20 minutes)

1. **Mac:** in Keychain Access, export _Developer ID Application:
   ApTask…_ with its private key as a `.p12`, with a new password. Then
   run `base64 -i cert.p12 | pbcopy`, paste it into the secret, and
   delete the `.p12`.
2. **GitHub:** _Settings → Environments → New environment_ `release`,
   with yourself as required reviewer. Add the secrets above.
3. **GitHub:** create a fine-grained token: this repository only,
   _Actions: read_, expiring in a year. Paste it when the server setup
   asks for it.
4. **Server:** one runbook command creates the age key, stores the
   token and starts the timer. It prints the age public key to paste
   into `RELEASE_AGE_RECIPIENT`.

## Rollout (small PRs)

1. This ADR.
2. The server side: the publishing logic as one script, the pull
   timer, and the setup command. `publish-installer.sh` uses the same
   script.
3. The workflow. Its first run is the next version bump, and the
   manual scripts stay ready in case it fails.

## Consequences

- **Positive:**
  - A release is a version-bump PR plus one click, then the owner's
    approval. Windows and Mac publish together, from the same commit.
  - No passwords typed at release time, and no SSH keys or Apple IDs
    on anyone's machine for a normal release.
  - Builds come from `main` exactly as merged, on clean machines.
- **Negative:**
  - The Developer ID certificate's private key leaves the Mac's
    keychain and becomes a GitHub secret. Anyone who can approve the
    `release` environment can sign as ApTask. Keep that to the owner.
  - GitHub's macOS runners are slower (about 15 to 25 minutes with
    notarization). They are free for a public repository.
  - Another moving part on the server (a timer and a token that
    expires yearly). An expired token shows in the timer's log, and the
    manual scripts still work.
- **Follow-ups:**
  - Authenticode-sign the Windows installer, to remove the SmartScreen
    warning (needs a code-signing certificate).
  - In production (AWS), the pull becomes a copy to S3 (see the
    production ADR).

## Alternatives considered

- **Public GitHub Releases, downloaded by the server.** Simplest, but
  the installers would be public. Rejected while downloads are meant
  to be behind Cloudflare Access (question 1).
- **A self-hosted runner on the pilot server.** It can reach the
  downloads folder directly, but it's Linux: it can't build Windows or
  Mac apps. It would also run workflow code on the production server.
  Rejected.
- **An upload endpoint on the API**, behind a Cloudflare Access service
  token. It works, but it adds a write path to the internet-facing
  server for something a pull does without one. Rejected.
- **Make the repository private.** Removes the exposure concern, but
  private repos pay for macOS minutes. It's a bigger call than this ADR
  (question 1, option c).

## Questions for the owner

1. **Delivery:**
   - (a) _Recommended:_ encrypted artifacts that the server pulls;
     nothing readable is left on GitHub;
   - (b) plain public GitHub Releases: simpler, but anyone can download
     the installers;
   - (c) make the repository private, then (b) without the exposure,
     paying for macOS minutes.
2. **Trigger:**
   - (a) _Recommended:_ you click _Run workflow_ and type the notes;
   - (b) automatically, whenever a version bump merges, with notes
     taken from the CHANGELOG.
3. **Approval:** you as the required reviewer of the `release`
   environment (_recommended_), or no approval step.

## Owner's answers (2026-10-08)

The recommended answer to each:

1. **Delivery:** encrypted artifacts that the server pulls.
2. **Trigger:** the owner clicks _Run workflow_ and types the notes.
3. **Approval:** the owner is the required reviewer of the `release`
   environment.

Production stays on this server for now (ADR-0035), so the pull timer
is the delivery route, not S3.
