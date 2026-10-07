# ADR-0021 — Welcome emails from noreply@aptask.com

- **Status:** Accepted (2026-09-28, choices set by the project owner);
  sender changed to cloudpunch@aptask.com (amendment 2026-10-07)
- **Date:** 2026-09-28
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0020 (People; same certificate), ADR-0019 (pilot VM,
  website).
- **Confidence:** Medium-high. It uses Exchange Online "RBAC for
  Applications", Microsoft's documented way to limit an app to named
  mailboxes. It will only be verified live once the Exchange steps are
  done.

## Context

When an Administrator or HR gives someone a CloudPunch role, that person
should get an email telling them what to do. The owner asked for:
- sender **noreply@aptask.com**, shown as **ApTask CloudPunch**;
- Cc **support@aptask.com**, **abdulla@aptask.com** and
  **nileshd@aptask.com**;
- the email must tell people to write to **support@aptask.com** if they
  have issues.

## Decision

1. **CloudPunch sends as noreply with its own token**, not the
   signed-in admin's. The owner chose this over "on behalf of the admin",
   which would need Send As rights per admin.
   - The token uses the same certificate as ADR-0020 (client
     credentials).
   - **What it may do is set in Exchange, not Entra:** the Exchange role
     "Application Mail.Send" with a management scope of
     `PrimarySmtpAddress -eq 'noreply@aptask.com'`. It can send only as
     that one mailbox.
   - **Mail.Send is deliberately not granted in Entra**, because that
     would mean any mailbox in the tenant.
2. **Settings, not code.** The following are server settings in
   `/etc/cloudpunch/api.env`, so changing them needs no release:
   - `WELCOME_FROM` (the sender);
   - `WELCOME_CC` (the always-copied list);
   - `SUPPORT_EMAIL` (named in the email);
   - `PUBLIC_SITE_URL` (the download link).
   The display name "ApTask CloudPunch" is the noreply mailbox's own
   display name in Exchange, because Microsoft shows the mailbox's name.
3. **Content.** The email covers:
   - download from the website, the "unknown publisher" step, and
     signing in with the ApTask account;
   - how to clock in, breaks and meetings;
   - idle, calls and the 8 am reminder;
   - what CloudPunch records and never records;
   - where to get help: support@aptask.com.
   - It includes the newest published version, and an optional personal
     note from the admin.
   - Names and notes are HTML-escaped. The recipient is never also on
     Cc.
4. **In People.**
   - Giving someone **Employee** opens *Send a welcome email?* with a
     preview (From, To, Cc, Subject) and an optional note.
   - Anyone with Employee has a **Send welcome email** button for
     resends.
   - HR and Administrators can both send.
5. **Safety.**
   - Every send is audited (`audit_log`, `welcome_email` /
     `welcome_sent`, with to and cc).
   - A second email to the same person within 10 minutes is refused.
     The check reads the audit log, so it holds across restarts.

## Consequences

- **Positive:**
  - People know what to do, and support is always in the loop.
  - The sending power is limited to one mailbox by Exchange itself.
- **Negative:**
  - Renaming the noreply mailbox's display name to "ApTask CloudPunch"
    changes how *all* its mail appears. If other systems send as noreply,
    either accept that or use a dedicated mailbox, for example
    cloudpunch-noreply@. Changing `WELCOME_FROM` and the Exchange scope
    is enough.
  - The certificate now also backs the send token. When it's renewed
    (2028-09-27), both People and welcome emails need the new one.

## Alternatives considered

- **On behalf of the admin** (`Mail.Send.Shared` plus Send As for each
  admin). Rejected by the owner: setup per admin.
- **App `Mail.Send` granted in Entra.** Rejected: it would allow sending
  as anyone in the tenant.
- **An external email service (SMTP relay or SendGrid).** Rejected: a
  new vendor and a new secret, and noreply@aptask.com is already in
  Microsoft 365.

## Amendment (2026-10-07): sent from cloudpunch@aptask.com

The owner decided not to rename noreply@aptask.com: other systems send
from it, and its display name would change for all of them (the risk
this ADR's Consequences named). Instead:

- A new **free shared mailbox, cloudpunch@aptask.com**, display name
  **ApTask CloudPunch**, is the sender. The owner creates it.
- `WELCOME_FROM=cloudpunch@aptask.com` on the VM.
- The Exchange management scope is `PrimarySmtpAddress -eq
  'cloudpunch@aptask.com'`, so CloudPunch can send only as that
  mailbox and has no access to noreply@ at all.
- Replies and bounces to welcome emails land in cloudpunch@, apart
  from noreply's other mail.

Everything else above stands (own token, Exchange RBAC for
Applications, no `Mail.Send` in Entra, the Cc list). The setup steps in
`docs/ops/pilot-vm.md` use the new mailbox.
