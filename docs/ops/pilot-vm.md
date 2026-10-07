# Pilot VM runbook (ADR-0019)

Host `cloudpunch-abd`, `ssh aptask@172.16.46.54` (key only). The API is
public at **`https://cloudpunch.aptask.com`** through a Cloudflare Tunnel
(ADR-0019 §8). On the office network it is also at `https://172.16.46.54`
(Caddy, private CA).

## What runs where

| Piece | Where | Notes |
|---|---|---|
| API | `cloudpunch-api.service`, user `cloudpunch`, `127.0.0.1:8080` | code in `/opt/cloudpunch/app` (`REVISION` file); previous deploy in `app.prev` |
| Secrets | `/etc/cloudpunch/api.env` (`root:cloudpunch 0640`) | `CLOUDPUNCH_ENV=pilot`, Entra ids, `POSTGRES_APP_URL`. Never copy or print it |
| HTTPS | Caddy, `/etc/caddy/Caddyfile`, port 443 | Source: `infra/pilot/Caddyfile`, installed by `scripts/install-caddyfile.sh` (backs up, validates, reloads). Drops client `Cf-*` headers (ADR-0029). `tls internal`. CA root at `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`; the same file is in `apps/desktop/pilot/pilot-ca.pem` |
| Database | Postgres 16, localhost only, DB `cloudpunch_dev` | roles `cloudpunch_migrator` (DDL) and `cloudpunch_app` (data) |
| Backups | cron `/etc/cron.d/cloudpunch-backup`, 02:30 nightly | `/var/backups/cloudpunch/*.dump`, 14 days, **on the same disk** |
| Public access | `cloudflared.service` (tunnel **cloudpunch**, id `e02aec2a-06b9-4b69-b795-c92e5c7b55a1`) | Cloudflare dashboard → Zero Trust → Networks → Tunnels → cloudpunch → Public Hostname: `cloudpunch.aptask.com` → **HTTP** `localhost:8080` (HTTPS here gives 502) |
| Firewall | `ufw` | 22 from anywhere (key only); 443 from 10/8, 172.16/12, 192.168/16, 100.64/10 |
| Node / pnpm | `/opt/node` (v20, SHA-256-verified tarball), pnpm 9.15.0 via corepack (`COREPACK_HOME=/opt/corepack`) | |

## Everyday

```sh
systemctl status cloudpunch-api caddy
sudo journalctl -u cloudpunch-api -f            # API logs (JSON)
curl -fsS http://127.0.0.1:8080/readyz          # on the VM
```

## Deploy

From a clean checkout of what should run:

```sh
scripts/deploy-pilot.sh        # ships HEAD, installs, restarts, checks /livez; rolls back if it fails
```

Rollback by hand: `sudo systemctl stop cloudpunch-api && sudo rm -rf /opt/cloudpunch/app && sudo mv /opt/cloudpunch/app.prev /opt/cloudpunch/app && sudo systemctl start cloudpunch-api`.

## Migrations

These run from the laptop through the SSH tunnel, as before
(`ssh -N -L 55432:localhost:5432 aptask@172.16.46.54`):

```sh
cd apps/backend && npx tsx --env-file=.env.local scripts/migrate.ts
```

Apply a migration **before** deploying code that needs it.

## People: one-time Entra setup (ADR-0020)

People lets Administrators and HR assign CloudPunch roles in the app.
It needs these, once, by a Global Admin:

1. **Certificate.** Go to **App registrations → CloudPunch API →
   Certificates & secrets → Certificates → Upload certificate**, and pick
   `docs/ops/pilot-entra-obo.crt`. Its SHA-1 thumbprint is
   `DEC502051BF50A89C0E93673E32F48B0EAB295E1` and it expires 2028-09-27.
   The private key is only on the VM (`/etc/cloudpunch/entra-obo.key`).
2. **Permissions.** On the same app, go to **API permissions → Add a
   permission → Microsoft Graph → Delegated permissions**, add
   `User.ReadBasic.All` and `AppRoleAssignment.ReadWrite.All`, then
   **Grant admin consent for ApTask**.
3. **Owners.** Go to **Enterprise applications → CloudPunch API →
   Owners → Add**, and add each Administrator and HR person who manages
   roles.

After that, open CloudPunch → Settings → **People**, search for a
person, tick their roles and Save. Their employee record is created
automatically.

## Welcome emails: one-time Exchange setup (ADR-0021)

CloudPunch sends welcome emails **as cloudpunch@aptask.com only**
(ADR-0021 amendment; noreply@ is left alone for its other uses). Exchange
enforces that; **don't** add `Mail.Send` under API permissions in Entra,
because that would allow any mailbox.

1. **Mailbox.** Create the shared mailbox `cloudpunch@aptask.com` (no
   licence needed) with the display name **ApTask CloudPunch**, in the
   Exchange admin center → Recipients → Mailboxes → Add a shared
   mailbox. Only CloudPunch sends from it.
2. **Object ID.** Entra → Enterprise applications → **CloudPunch API** →
   Overview → **Object ID**. Use the enterprise app's Object ID, not the
   app registration's.
3. **Exchange Online PowerShell**, as an Exchange admin:
   ```powershell
   Connect-ExchangeOnline -UserPrincipalName abdulla@aptask.com
   New-ServicePrincipal -AppId 63bca00e-a546-4f0c-a076-e2450e52406e -ObjectId <OBJECT-ID> -DisplayName "CloudPunch API"
   New-ManagementScope -Name "CloudPunch mailbox only" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'cloudpunch@aptask.com'"
   New-ManagementRoleAssignment -App 63bca00e-a546-4f0c-a076-e2450e52406e -Role "Application Mail.Send" -CustomResourceScope "CloudPunch mailbox only"
   Test-ServicePrincipalAuthorization -Identity 63bca00e-a546-4f0c-a076-e2450e52406e -Resource cloudpunch@aptask.com
   ```
   The last line should show `Application Mail.Send` with `InScope: True`.
   Changes can take up to about 30 minutes to reach Graph.

If an earlier setup scoped CloudPunch to noreply@, remove that
assignment (`Get-ManagementRoleAssignment -RoleAssignee
63bca00e-a546-4f0c-a076-e2450e52406e`, then
`Remove-ManagementRoleAssignment` on the noreply one) so CloudPunch can
no longer send as noreply@.

**Server settings** (`/etc/cloudpunch/api.env`): `WELCOME_FROM`
(`cloudpunch@aptask.com`),
`WELCOME_CC` (comma-separated), and optionally `SUPPORT_EMAIL` and
`PUBLIC_SITE_URL`. Restart `cloudpunch-api` after changing them.

## Add a tester (without People)

1. **Entra admin center → Enterprise applications → CloudPunch API →
   Users and groups → Add user/group.** Pick the person and the role
   **Employee**. For an admin, add a second assignment with
   **Administrator** (the picker takes one role per assignment).
2. Link them to an employee record:
   ```sh
   cd apps/backend && npx tsx --env-file=.env.local scripts/seed-dev-user.ts \
     --oid <entra object id> --email name@aptask.com --given <First> --family <Last>
   ```
3. Send them the installer (below) and the privacy notice
   (`docs/policy/employee-privacy-notice.md`).

## Build the pilot installer (Windows)

In PowerShell (5.1 or 7), from the repo root:

```powershell
.\scripts\build-windows.ps1 -Publish
```

It asks for the "what's new" notes (one per line, an empty line ends),
then the updater key password (not shown, not saved), builds, and
publishes. Without `-Publish` it only builds. It sets
`CLOUDPUNCH_BACKEND_URL`, clears `CLOUDPUNCH_BUILD_CA_PEM` and points
`TAURI_SIGNING_PRIVATE_KEY` at `%USERPROFILE%\.cloudpunch\updater.key`
(Tauri 2.11 reads the key file's path from it; there's no `_PATH`
variant).

Next to the installer you'll get `CloudPunch_<version>_x64-setup.exe.sig`,
the update signature. `publish-installer.sh` refuses an installer without
a fresh one.

The output is `target\release\bundle\nsis\CloudPunch_<version>_x64-setup.exe`.
It is unsigned, so Windows shows "unknown publisher" once: **More info
→ Run anyway**. It installs per user, and no admin rights are needed.

## Build the Mac installer (ADR-0026)

On the owner's Mac (macOS 14 or later). It makes a universal app (Apple
Silicon and Intel), signs it with ApTask's Developer ID, has Apple
notarize it, and signs the update for auto-update.

**One-time setup**

1. **Tools:**
   - `xcode-select --install`;
   - Rust from rustup, then `rustup target add aarch64-apple-darwin x86_64-apple-darwin`;
   - Node 20 (`.nvmrc`);
   - `corepack enable` (for pnpm 9.15).
2. **The repo:** clone it, then run `pnpm install`.
3. **The Developer ID certificate:** Xcode → Settings → Accounts → sign in
   with the ApTask Apple ID → the ApTask team → **Manage Certificates** →
   **+** → **Developer ID Application**. It needs the Account Holder or
   Admin role.
   - Check it: `security find-identity -v -p codesigning` lists
     `Developer ID Application: <ApTask name> (<TEAM ID>)`.
4. **Notarization:** at appleid.apple.com → Sign-In and Security →
   **App-Specific Passwords**, create one named "CloudPunch notarize".
   Keep it in the password manager.
5. **The updater key:** copy `updater.key` from the password manager to
   `~/.cloudpunch/updater.key`. It's the same key as Windows, and it never
   goes into the repo.

**Each release** (after the version bump), in the Mac's own Terminal
(not over SSH to the VM), from the repo root:

```sh
git pull
bash scripts/build-mac.sh admin@aptask.com --publish
```

It finds the certificate and Team ID itself, checks the setup above,
asks for the "what's new" notes, then the app-specific password and the
updater key password (not shown, not saved), and publishes when the
build is done. That needs the Mac's SSH key on the VM (added
2026-09-30). The first time, run `ssh aptask@172.16.46.54 true` and check
the fingerprint is `SHA256:Edg/s3L+tsKU729Ch5CNyW4HHd2CKofxTYYfJ/mYhbg`.

**Output** (under `target/universal-apple-darwin/release/bundle/`):
- `dmg/CloudPunch_<version>_universal.dmg`, for the website;
- `macos/CloudPunch.app.tar.gz` and `.sig`, for auto-update.

Notarization takes a few minutes; the build waits for it. If the Mac
ever can't reach the VM, build without `--publish`, copy the `bundle`
folder and `cloudpunch-desktop` to the same paths on the Windows machine,
and publish from there.

## Publish an installer (the website's Download button)

Every release that people should get is published, so it shows on
`https://cloudpunch.aptask.com` with its notes:

1. **Bump the version.** Set the same new version in
   `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/package.json`.
   The script refuses to re-publish a version with a different file.
2. **Build the pilot installer** (above).
3. **Publish it.** The build scripts do this with `-Publish` /
   `--publish`. By hand, give one line per change (or none, and it asks):
   ```sh
   scripts/publish-installer.sh "Idle popup after 2 minutes" "Clock-in popup at 8 am ET"
   ```
   It checks the build points at `https://cloudpunch.aptask.com`,
   uploads the file, and adds the release to
   `/opt/cloudpunch/downloads/windows/releases.json`. The page shows it
   straight away, and the newest 3 installers are kept.

   Installed apps pick it up within 4 hours and install it at the next
   Windows sign-in, unlock or wake, when the person is clocked out with
   nothing recorded yet that day (ADR-0022). Nobody is restarted while
   clocked in.

**Updater signing key (ADR-0022 §5).** Made once with
`pnpm --dir apps/desktop tauri signer generate -w %USERPROFILE%\.cloudpunch\updater.key`.
Keep the key file and its password in your password manager. If it is
lost, installed apps can't take updates until everyone reinstalls by
hand. The public key is in `tauri.pilot.conf.json` (`plugins.updater`).

**Cloudflare Access (ApTask only).** Go to Zero Trust → Access →
Applications → **cloudpunch-download**. It covers
`cloudpunch.aptask.com/download` and allows emails ending in
`@aptask.com`. Keep it on `/download` only: putting Access in front of
`/v1` would break the app.

## Restore a backup

```sh
sudo systemctl stop cloudpunch-api
sudo -u postgres pg_restore --clean --if-exists -d cloudpunch_dev /var/backups/cloudpunch/cloudpunch-YYYY-MM-DD.dump
sudo systemctl start cloudpunch-api
```

A restore rewrites history. Get the owner's OK first, and remember that
`time_event` is append-only by design.
