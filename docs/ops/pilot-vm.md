# Pilot VM runbook (ADR-0019)

Host `cloudpunch-abd`, `ssh aptask@172.16.46.54` (key only). The API is
at `https://172.16.46.54`, reachable from the internal network and VPN
only.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| API | `cloudpunch-api.service`, user `cloudpunch`, `127.0.0.1:8080` | code in `/opt/cloudpunch/app` (`REVISION` file); previous deploy in `app.prev` |
| Secrets | `/etc/cloudpunch/api.env` (`root:cloudpunch 0640`) | `CLOUDPUNCH_ENV=pilot`, Entra ids, `POSTGRES_APP_URL`. Never copy or print it |
| HTTPS | Caddy, `/etc/caddy/Caddyfile`, port 443 | `tls internal`. CA root at `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`; the same file is in `apps/desktop/pilot/pilot-ca.pem` |
| Database | Postgres 16, localhost only, DB `cloudpunch_dev` | roles `cloudpunch_migrator` (DDL) and `cloudpunch_app` (data) |
| Backups | cron `/etc/cron.d/cloudpunch-backup`, 02:30 nightly | `/var/backups/cloudpunch/*.dump`, 14 days, **on the same disk** |
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

## Add a tester

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
$env:CLOUDPUNCH_BACKEND_URL='https://172.16.46.54'
$env:CLOUDPUNCH_BUILD_CA_PEM="$PWD\pilot\pilot-ca.pem"
pnpm tauri build --config src-tauri/tauri.pilot.conf.json
```

The output is `target\release\bundle\nsis\CloudPunch_<version>_x64-setup.exe`.
It is unsigned, so Windows shows "unknown publisher" once: **More info
→ Run anyway**. It installs per user, and no admin rights are needed.

## Restore a backup

```sh
sudo systemctl stop cloudpunch-api
sudo -u postgres pg_restore --clean --if-exists -d cloudpunch_dev /var/backups/cloudpunch/cloudpunch-YYYY-MM-DD.dump
sudo systemctl start cloudpunch-api
```

A restore rewrites history. Get the owner's OK first, and remember that
`time_event` is append-only by design.
