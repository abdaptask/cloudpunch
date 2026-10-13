# ADR-0041 — Email when someone connects from a new place

- **Status:** Accepted (2026-10-13, the owner answered the questions
  below)
- **Date:** 2026-10-13
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0029 (connection location: city, region, country and
  provider from Cloudflare and DB-IP, kept 30 days), ADR-0032 (recorded
  without an announcement), ADR-0037 (email from cloudpunch@aptask.com,
  recipients when there's no manager).
- **Confidence:** High. It reuses the connection rows, the mail sender
  and the "once only" pattern already running.

## Context

The owner asked (2026-10-13): "one email to be sent to the admin and
manager if the location of log in has changed for their team member."
Their answers:

- **What counts:** a **city or country** the person hasn't connected
  from in the last 30 days. A new internet provider or address in the
  same city doesn't count (a phone hotspot or a router restart would
  otherwise send email).
- **When:** **right away, once per new place**.
- **Who:** the person's **manager, copied to Administrators**; with no
  manager, Administrators only. **Not HR** (HR doesn't see connections
  in the app either, ADR-0029 §5).
- **Privacy:** proceed, and the **privacy notice says managers may be
  told** when someone works from a new location.

## Decision

1. **When it's checked:** when the server records a **new network**
   for a computer (a new `device_connection` row, ADR-0029 §2), which
   is rare; ordinary requests write nothing and check nothing.
2. **What is a new place:** the row has a city and country, the person
   has at least one earlier connection in the last 30 days (a first
   ever connection is not a change), and none of those earlier ones has
   the same city and country (compared ignoring case).
3. **Once only:** a `location_alert` row (person, city, country, date
   sent) is claimed before sending, unique per person, place and day
   (invariant 4). Migration 0016, append-only. A failed send is logged
   and not retried (the place is then known, so it won't be sent
   later either); the next new place sends as normal.
4. **The email:** from cloudpunch@aptask.com. Subject "Roshni Sahani is
   connecting from a new place". Body: the new place and provider, the
   time (in the manager's view, India time), and the places they used
   in the last 30 days. No IP address, no device details. A link to
   their connections in the admin console.
5. **Recipients:** the manager (To), Administrators (Cc), using the
   roles each was last seen with (ADR-0037 §3). Not the person.
6. **Switch:** `alerts.location_emails` in the company-wide policy,
   **off by default**, shown in **Rules → Connection location** under
   "Record where people connect from". It does nothing while recording
   is off.
7. **Never in the way:** checking and sending run after the request is
   answered; any error is logged, not returned.

## Consequences

- Managers learn the same day when someone starts working from another
  city. Travel, a move, or a VPN exit in another city all send one email
  per new place.
- Cloudflare's city for a mobile network can be wrong or jump between
  nearby cities; the 30-day memory keeps that to one email per place.
- The privacy notice needs a line before this is switched on.

## Alternatives considered

- **A daily digest:** fewer emails but late; not chosen.
- **Any new provider or address:** far more emails; not chosen.
- **Tell the person too:** not asked for; may come with the privacy
  notice.

## Plan

1. This ADR.
2. Migration 0016, the check after a new connection row, the email,
   the setting in Rules (desktop 0.1.35 for the toggle; the server part
   works on its own once the setting is on).
3. The privacy notice line (HR/legal to review with the rest of the
   notice).
