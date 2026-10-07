# ADR-0029 — Connection location: IP, city, state and provider

- **Status:** Accepted (2026-09-30, the owner approved); §7 superseded
  by ADR-0032 (on from the start, no separate announcement)
- **Date:** 2026-09-30
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0004 (event model and the no-content invariant),
  ADR-0019 (pilot behind Cloudflare Tunnel), ADR-0025 (audited views).
  Changes the employee privacy notice.
- **Confidence:** High for the IP (Cloudflare passes it). Medium for city
  and state: IP location is often one city off, and a VPN shows the
  VPN's location. Medium for the provider name.

## Context

The owner wants to see where people connect from, whenever they're
connected: the IP address, city, state and internet provider, and
ideally whether it's mobile data or a home/office line (2026-09-30).

- **Who sees it:** Administrators and Managers only. Managers see only
  their own reports (invariant 5).
- **Cost:** nothing paid.
- **Retention:** 30 calendar days.

The privacy notice (`docs/policy/employee-privacy-notice.md`) says
CloudPunch doesn't record "your physical location or GPS coordinates",
and that employees are told before anything on that list is added.

## Decision

### 1. What is recorded

One row per device per **network change**, in a new table
`device_connection`:
- `employee_id`, `device_id`;
- `ip` (as the API sees it);
- `city`, `region` (state), `country`;
- `asn` and `provider` (e.g. "Reliance Jio Infocomm", "Bharti Airtel");
- `first_seen_at`, `last_seen_at`.

No GPS, no Wi-Fi names, nothing from the laptop itself: it's all derived
on the server from the connection the app already makes. The desktop
app doesn't change.

### 2. When

- **At every authenticated request** from the desktop app, the API
  compares the IP with that device's current row (kept in memory).
- **Same IP:** `last_seen_at` is updated at most every 15 minutes.
- **New IP:** a new row. So the history shows each place and network
  the person worked from, and when.

### 3. Where the data comes from (all free)

- **IP:** `CF-Connecting-IP` from Cloudflare. The API trusts it only
  from the local tunnel (`trustProxy: 127.0.0.1`, ADR-0019).
- **City, state, country:** Cloudflare's **"Add visitor location
  headers"** managed transform (`cf-ipcity`, `cf-region`,
  `cf-ipcountry`). The owner turns it on in the Cloudflare dashboard
  (Rules → Transform Rules → Managed Transforms). Nothing is sent to a
  third party beyond Cloudflare, which already carries the traffic.
- **Provider:** the free **DB-IP "IP to ASN Lite"** database (CC BY 4.0,
  monthly, no account), kept on the VM and read locally. The screen
  credits "IP data by DB-IP".

### 4. Mobile vs. broadband

**Not recorded as a fact.** The free data only names the provider, and
in India the big providers (Jio, Airtel) sell both mobile and home
broadband, sometimes on the same network number. Knowing which one it
is reliably needs a paid database, which the owner declined.
The screen shows the provider name only.

### 5. Who sees it

- **Where:** Team → person → **Connections** (last 30 days), and the
  current city on the Team list.
- **Who:** Administrator (everyone) and Manager (own reports only).
  Not HR, not Auditor, not the employee's peers. Each view is written to
  the audit log, like other team views (ADR-0025).
- **The employee** sees their own connection history in the app, so
  nothing is hidden from them.

### 6. Retention: 30 calendar days

A nightly job deletes rows whose `last_seen_at` is more than 30 days
old. `device_connection` is not `time_event`, so the append-only rule
doesn't apply. The job runs as the migrator role; the app role can't
delete.

### 7. Privacy notice first

> Superseded by ADR-0032 (2026-10-07): no announcement or waiting
> period; the notice describes it from the start. Kept for history.


- New section: what's recorded, why (to confirm work location and spot
  shared or unexpected connections), who sees it, 30 days.
- "Your physical location or GPS coordinates" is reworded: CloudPunch
  records the approximate city from the internet connection, never GPS.
- Employees are told before it's switched on (the notice's own promise).
  It ships **off** (`connections.record = false`) and the owner turns it
  on in Settings after telling people.
- Under India's DPDP Act 2023 this is personal data used for employment
  purposes, so the notice is what matters. No legal review was asked
  for (owner's call, as with ADR-0012).

## Consequences

- **Positive:**
  - Admins and managers see where and on what network people work,
    with no cost and no change to the desktop app.
  - Short retention limits the exposure.
- **Negative:**
  - IP location is approximate. A VPN or a corporate proxy shows the
    VPN's or office's location. Today the testers in India all appear
    from one IP (202.71.156.179), probably the office network.
  - Needs one Cloudflare dashboard switch, and a monthly update of the
    DB-IP file (a cron job on the VM).
  - It's a change employees will notice, and the notice must go out first.

## Alternatives considered

- **Paid databases** (MaxMind GeoIP2 Connection Type, ipinfo) for mobile
  vs. broadband: declined by the owner (cost).
- **Free web APIs** (ip-api.com and similar): their free tiers are
  non-commercial only, and they'd send every employee's IP to a third
  party.
- **GPS or Wi-Fi location from the laptop:** rejected; far more
  invasive, needs OS permission, and breaks the privacy notice's GPS
  promise.
- **Only at sign-in:** the owner wants it whenever they're connected.

## Amendment (2026-10-01): implementation choices

The owner approved these while planning the build:

- **Reading the DB-IP file:** the `maxmind` npm package reads DB-IP's
  `.mmdb` file directly (DB-IP publishes the ASN Lite database in that
  format).
- **IPv6:** two IPv6 addresses in the same `/64` count as the same
  connection, so a laptop that changes its IPv6 address every few
  minutes (privacy addresses) doesn't add a row each time. IPv4
  addresses are compared exactly.
- **Correction to Context:** the API's logs on 2026-10-01 show testers
  arriving from six different addresses, IPv4 and IPv6, not just
  202.71.156.179. The tunnel goes straight to the API on
  `localhost:8080` (not through Caddy), so Cloudflare's headers reach
  it. Whether the location headers are present is still unverified;
  the recorder logs that once, without their values.
- **Viewing needs a desktop release.** Recording needs no desktop
  change, but the Team, Settings and own-history screens are in the
  desktop app (the web dashboard has no code yet).
