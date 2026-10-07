# ADR-0032 — Connection location is on from the start, with no separate announcement

- **Status:** Accepted (2026-10-07, the owner decided)
- **Date:** 2026-10-07
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Supersedes:** ADR-0029 §7 ("Privacy notice first"). The rest of
  ADR-0029 (what is recorded, when, sources, who sees it, 30-day
  retention) stands unchanged.
- **Confidence:** High on the decision (the owner's, stated directly).
  Medium on its legal footing: no legal review was asked for (owner's
  call, as with ADR-0012 and ADR-0029).

## Context

ADR-0029 built connection-location recording (IP, approximate city,
state, country, internet provider; 30 days) and shipped it **off**
(`connections.record = false`). Its §7 said employees would be told
before it was switched on, and the privacy notice described it as
"only once ApTask turns it on", with the notice's general promise of
30 days' warning before collection expands.

The owner (2026-10-07):

> "i dont have to announce it to anyone that we are checking where
> they are connecting from.. we need to know that they dont.. we need
> to catch people that are misrepresenting the data if at all."

Facts that shape the decision:

- The privacy notice has **never been distributed**. Its header still
  reads "Template draft … before being shown to employees". So there
  is no promise to anyone yet that a silent switch-on would break.
- Each employee can already see their **own** connection history in
  the app (account menu → Where you connect from, ADR-0029 §5). The
  owner did not ask to hide it.
- Under India's DPDP Act 2023, processing personal data "for the
  purposes of employment" is a legitimate use (s. 7). That is a reading,
  not legal advice.

## Decision

1. **No separate announcement.** The owner may switch recording on
   (Settings → Connections) at any time. There is no waiting period
   and no message to employees before or after.
2. **Purpose, stated plainly:** to confirm where work is done from and
   to **detect misrepresented work location**, shared accounts, or
   connections nobody expected.
3. **The privacy notice describes it as part of what CloudPunch
   records, from the start.** "Only once ApTask turns it on" is
   removed, and the purpose above is written in. Because the notice
   hasn't been given to anyone, this is its baseline content, not a
   change, so its "30 days' warning" clause does not apply to it. That
   clause stays for any *future* expansion.
4. **Nothing else in ADR-0029 changes:** same fields, no GPS, no
   Wi-Fi names, nothing from the laptop; Managers see only their own
   reports, Administrators everyone, HR and Auditors never; every view
   is audited; rows are deleted after 30 days; the employee still sees
   their own history.

## Consequences

- **Positive:**
  - The owner can start collecting now, while the pilot is running.
  - People who route through a VPN or misreport where they work are
    not tipped off by an announcement.
- **Negative:**
  - **Evidence quality.** IP location is approximate: a VPN, a mobile
    hotspot or an office network can show the wrong city. A record is
    a reason to look further, not proof on its own.
  - **Visible anyway.** Because each person sees their own history, a
    careful person may notice it and change how they work. Hiding it
    from them would be a separate decision (and a desktop change).
  - **Notice before use in a dispute.** If ApTask ever acts on this
    data against someone, the notice they were given (if any) will be
    looked at. The notice should be given to employees before that
    happens; this ADR does not set a date.
  - No legal review was done.

## Alternatives considered

- **Keep ADR-0029 §7 (announce, wait 30 days):** rejected by the
  owner; it warns exactly the people it is meant to catch.
- **Record without mentioning it in the notice at all:** rejected; the
  notice lists everything CloudPunch records, and leaving one item out
  would make it inaccurate wherever it is eventually shown.
- **Hide the history from the employee too:** not asked for; would
  make records harder to explain if challenged.
