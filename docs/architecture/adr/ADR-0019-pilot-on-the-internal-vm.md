# ADR-0019 — Pilot on the internal VM

- **Status:** Accepted (2026-09-28, decisions set by the project owner);
  §8 added the same day: remote testers reach it through a Cloudflare
  Tunnel at `https://cloudpunch.aptask.com`
- **Date:** 2026-09-28
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0002 (Entra), ADR-0007 (secrets; the dev-only
  exception for `POSTGRES_APP_URL`), ADR-0015 (policy), ADR-0018.
- **Superseded later by:** the AWS `ap-south-1` deployment (not yet
  written).
- **Confidence:** Medium. It is fine for a small internal pilot. It is
  not the production design: one VM, no high availability, and a private
  CA.

## Context

The owner wants three people (two Employees, one Administrator) using
CloudPunch for real, **on the same internal VM** as development
(`cloudpunch-abd`, 172.16.46.54). Until now only the owner's own
identity lived in that database, and the API ran only on the owner's
laptop behind an SSH tunnel. AWS is not ready.

## Decision

1. **A `pilot` environment.**
   - `CLOUDPUNCH_ENV=pilot` may read `POSTGRES_APP_URL`, like `dev`
     (ADR-0007's exception, now for both), from a root-owned file
     `/etc/cloudpunch/api.env` (`root:cloudpunch 0640`).
   - Staging and prod still require Secrets Manager.
   - The pilot trusts only the local proxy (`trustProxy: 127.0.0.1`).
2. **The API runs on the VM** as the `cloudpunch-api` systemd service.
   - It runs as the system user `cloudpunch`, listening on
     `127.0.0.1:8080` only.
   - Hardening: no capabilities, `ProtectSystem=strict`, private
     `/tmp`, and a system-call filter (`@system-service @pkey`; V8 needs
     `pkey_alloc`).
   - It runs the TypeScript directly with `tsx` (the workspace packages
     export TS, so `node dist/server.js` doesn't run yet).
   - Code is shipped with `git archive` over SSH, so no Git credentials
     live on the VM.
3. **HTTPS by Caddy on 443**, with Caddy's own private CA
   (`tls internal`, root valid to 2036).
   - The **pilot desktop build pins that CA root** (`CLOUDPUNCH_BUILD_CA_PEM`)
     for API calls only. Microsoft sign-in uses only the system roots.
   - The same build carries the address `https://172.16.46.54`
     (`CLOUDPUNCH_BACKEND_URL` at build time). A run-time variable still
     overrides it, for development.
4. **Network.**
   - The network admin opened 443 to the VM and made its IP static.
   - `ufw` also limits 443 to private and VPN ranges (10/8,
     172.16/12, 192.168/16, 100.64/10), so a public address is refused
     even if the edge ever lets one through.
   - Postgres stays on localhost. SSH stays key-only.
5. **Data safety.**
   - A nightly `pg_dump` at 02:30 goes to `/var/backups/cloudpunch`,
     kept 14 days.
   - Unattended security upgrades are on.
6. **People and roles.**
   - Testers get **Entra app-role assignments** on the CloudPunch API:
     Employee, plus Administrator for one person.
   - They also get an employee record linked by their Entra object id.
   - Roles come only from the token (invariant 6); the database stores
     none.
7. **Installer.**
   - An unsigned NSIS installer, per-user, so no admin rights are
     needed. Windows shows "unknown publisher" once, which the owner
     accepted.

8. **Remote access through a Cloudflare Tunnel** (added 2026-09-28).
   The testers work from home and nobody uses the company VPN, so
   172.16.46.54 is out of their reach.
   - `aptask.com`'s DNS is on Cloudflare, so the VM runs **`cloudflared`**
     (tunnel **cloudpunch**, id `e02aec2a-06b9-4b69-b795-c92e5c7b55a1`).
     The owner installed it as a systemd service with its token.
   - The tunnel publishes **`https://cloudpunch.aptask.com`** →
     `http://localhost:8080`. It connects **outbound only**, so no inbound
     port or public IP is needed.
   - TLS for the testers is Cloudflare's publicly trusted certificate.
     Cloudflare → VM runs inside the encrypted tunnel, and the last hop is
     loopback inside the VM.
   - The API still trusts only `127.0.0.1` as proxy; `cloudflared` is
     that proxy.
   - The **pilot build now points at `https://cloudpunch.aptask.com` and
     carries no private CA**, since the system roots suffice. Caddy on
     443 with its private CA stays for office-network use.
   - Every request still needs a valid Entra token with a CloudPunch role
     (invariant 6).
   - Follow-up: add a Cloudflare rate-limiting rule in front of `/v1/*`.

9. **The installer is published at the service address** (added
   2026-09-28, owner request: "put the setup file online, ApTask only").
   - `https://cloudpunch.aptask.com` shows the CloudPunch page (brand
     logo, reversed in dark mode). It has a **Download for Windows**
     button for the newest release, **What's new** notes, and the
     earlier versions.
   - The server serves `/download/windows` from
     `/opt/cloudpunch/downloads/windows` (`DOWNLOADS_DIR`), described by
     `releases.json`.
   - **Cloudflare Access protects `/download*`** so only ApTask accounts
     can download. Access sits only on that path; the app's `/v1`
     traffic and the page itself are not behind it.
   - `scripts/publish-installer.sh "note" …` publishes a build. It
     refuses a build that doesn't point at the public address, and
     refuses to re-publish a version with a different file, so every
     update must bump the version. It keeps the newest 3 installers.

## Consequences

- **Positive:** real use without waiting for AWS. The setup is small,
  inspectable, and reversible.
- **Negative:**
  - One VM is a single point of failure, and backups sit on the same
    disk.
  - If the VM is compromised, the pilot CA key is exposed with it. That
    CA is trusted only by the pilot build and only for our API.
  - Every future pilot build needs the same CA root, or the CA must be
    re-issued and the app re-installed.
- **Follow-ups:**
  - Copy backups off the VM.
  - Replace `tsx` with a bundled build.
  - Code-sign the installer (2b.9).
  - Move to AWS.

## Alternatives considered

- **A public certificate via a DNS name.** Better long-term, but it
  needs DNS access that wasn't at hand. The pinned private CA is safe for
  an internal pilot.
- **Opening the API to the internet.** Rejected: the testers are on the
  internal network or VPN.
- **Waiting for AWS.** Rejected by the owner: the pilot should start now.
