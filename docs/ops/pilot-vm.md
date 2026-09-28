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
| HTTPS | Caddy, `/etc/caddy/Caddyfile`, port 443 | `tls internal`. CA root at `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`; the same file is in `apps/desktop/pilot/pilot-ca.pem` |
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

From PowerShell, so the vendored OpenSSL builds:

```powershell
cd apps\desktop
$env:CLOUDPUNCH_BACKEND_URL='https://cloudpunch.aptask.com'
Remove-Item Env:CLOUDPUNCH_BUILD_CA_PEM -ErrorAction SilentlyContinue   # public cert: no pinned CA
pnpm tauri build --config src-tauri/tauri.pilot.conf.json
```

The output is `target\release\bundle\nsis\CloudPunch_<version>_x64-setup.exe`.
It is unsigned, so Windows shows "unknown publisher" once: **More info
→ Run anyway**. It installs per user, and no admin rights are needed.

## Publish an installer (the website's Download button)

Every release that people should get is published, so it shows on
`https://cloudpunch.aptask.com` with its notes:

1. **Bump the version.** Set the same new version in
   `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/package.json`.
   The script refuses to re-publish a version with a different file.
2. **Build the pilot installer** (above).
3. **Publish it** with one line per change:
   ```sh
   scripts/publish-installer.sh "Idle popup after 2 minutes" "Clock-in popup at 8 am ET"
   ```
   It checks the build points at `https://cloudpunch.aptask.com`,
   uploads the file, and adds the release to
   `/opt/cloudpunch/downloads/windows/releases.json`. The page shows it
   straight away, and the newest 3 installers are kept.

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
