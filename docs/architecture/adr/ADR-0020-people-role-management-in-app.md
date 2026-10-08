# ADR-0020 — People: assign CloudPunch roles in the app

- **Status:** Accepted (2026-09-28, design chosen by the project owner)
- **Date:** 2026-09-28
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0002 (Entra app roles are the RBAC source;
  invariant 6), ADR-0019 (pilot VM).
- **Confidence:** Medium-high. It uses documented Graph flows (OBO,
  `appRoleAssignedTo`). One thing to verify live: whether a non-admin
  owner of the enterprise app can assign roles with the delegated
  permission. Global Admins can.

## Context

Adding a tester meant two separate trips: the Entra portal (app-role
assignment) and a script (employee record). The owner asked for
Administrators and HR to do it **inside CloudPunch**, picking people
from the directory.

## Decision

1. **Roles stay in Entra.**
   - People writes Entra **app-role assignments** on the CloudPunch API
     service principal. It never keeps its own role list.
   - The token's `roles` claim remains the only thing the server trusts
     (invariant 6).
2. **Acting on behalf of the signed-in person.**
   - The backend exchanges the caller's API token for a Microsoft Graph
     token (on-behalf-of) carrying *their* delegated rights:
     `User.ReadBasic.All` (search the directory) and
     `AppRoleAssignment.ReadWrite.All` (assign roles).
   - Microsoft checks the caller's own directory rights on every call.
     The server holds **no standing directory power**.
   - CloudPunch proves its identity with a **certificate** (client
     assertion), not a shared secret. The private key was generated on
     the VM and never left it (`/etc/cloudpunch/entra-obo.key`,
     `root:cloudpunch 0640`). Only the public certificate is uploaded
     to Entra.
3. **CloudPunch's own limits, on top of Entra's:**
   - an Administrator (`admin.role.assign`) may give or remove any role;
   - HR (`hr.employee.write`) may give or remove **Employee and Manager
     only**;
   - nobody removes their own Administrator role, and the last
     Administrator can't be removed.
4. **Employee records follow roles.** Giving someone Employee creates
   their employee record from the directory entry (given name, surname,
   email, object id), if they have none. The manual seed step goes
   away.
   _Amended 2026-10-08 (owner):_ Manager and HR create the record too,
   because a reporting line (ADR-0025 §1) links two employee records,
   and a manager may never install the app. Saving someone's roles
   unchanged adds a missing record, for those given Manager before
   this. Reporting lines offers only Manager and HR as managers.
5. **Audit.** Every change writes an `audit_log` row (`entity_type =
   app_role_assignment`, `action = roles_set`) with the roles before and
   after, the actor and the reason.
6. **Screen.** Settings gets a **People** tab: the list of people with
   CloudPunch roles, a directory search to add someone, and role
   checkboxes. Roles HR can't give are shown disabled.

**One-time Entra setup** (Global Admin; the steps are in
`docs/ops/pilot-vm.md`):
1. Upload the certificate to the **CloudPunch API** app registration.
2. Add the two delegated Microsoft Graph permissions and grant admin
   consent.
3. Make every Administrator and HR user an **owner** of the CloudPunch
   API enterprise application.

## Consequences

- **Positive:**
  - No Entra portal for day-to-day role changes.
  - One place to add a person: role plus employee record, in one step.
  - Every change is audited in CloudPunch *and* in Entra's own audit
    log.
- **Negative:**
  - An owner of the enterprise app can also assign any CloudPunch role
    directly in the Entra portal. CloudPunch's HR limit applies only
    inside CloudPunch. Keep ownership to people trusted with that.
  - Role changes reach a person only at their next sign-in, within an
    hour at most.
  - The certificate expires in 2 years (2028-09-27) and must be renewed
    in Entra.
- **Follow-ups:**
  - Show the audit history in People.
  - Deactivate the employee record when someone loses Employee.
  - Group-based assignment, if HR prefers groups.

## Alternatives considered

- **App-only Graph permission (`AppRoleAssignment.ReadWrite.All` as an
  application permission).** Rejected: that is effectively tenant-admin
  power held by the server. An app with it can grant itself anything.
- **Roles in CloudPunch's database.** Rejected: it breaks invariant 6
  and splits the source of truth.
- **A client secret instead of a certificate.** Rejected: the secret
  would have to be copied through a person, and it is replayable if it
  leaks.
