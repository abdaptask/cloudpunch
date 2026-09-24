# greytHR ↔ CloudPunch integration — Field mapping RFC

- **Status:** Draft. Awaiting confirmation of greytHR API entitlement
  and receipt of the current official API documentation.
- **Owner:** Abdulla Sheikh (`abdulla@aptask.com`).
- **Related:** ADR-0005 (source of truth), ADR-0006 (integration
  strategy).
- **Distribution:** intended for the ApTask project owner, ApTask
  security review, and greytHR (Greytip Software) customer success /
  API team.

## 1. Purpose

This RFC proposes the exact field-level mapping between CloudPunch
(the employee time-and-attendance system ApTask is building) and
greytHR (ApTask's HR and payroll system of record). It is written to
be reviewable by both ApTask stakeholders and by greytHR support.

CloudPunch will not be built against unofficial or reverse-engineered
endpoints. This document names the endpoints and fields we require
and asks greytHR to confirm which are available on our subscription.

Nothing in this RFC commits either side to any specific integration
timeline. Implementation follows only after:

1. Greytip Software confirms API access on ApTask's greytHR plan.
2. Official current API documentation is provided to ApTask.
3. This mapping is signed off by the project owner.

## 2. Information requested from greytHR

Please provide, or point us to authoritative documentation for, each
of the following:

**A. Access and authentication**
1. Product edition (greytHR SaaS / Enterprise / on-prem) and tenant
   subdomain in use for ApTask.
2. Whether API access is enabled on our current subscription (yes /
   no / add-on required).
3. Authentication model — OAuth 2.0 client credentials, API key,
   session-based, or other. Please include token lifetimes and
   scopes.
4. Sandbox / test tenant availability.

**B. Endpoints and rate limits**
5. Base URL (production and sandbox).
6. Rate limits per endpoint or globally (requests per second,
   per minute, per day).
7. Behaviour on limit breach (429 with `Retry-After`? Silent drop?
   Circuit break?).
8. Pagination model (cursor / offset / page).
9. Bulk endpoints (batch reads, batch writes) if available.

**C. Capabilities per data domain (yes / no / plan-dependent)**
10. **Employee master read** — full list of active employees;
    include cursor / delta support (`modifiedSince`).
11. **Employee detail read** by employee ID.
12. **Holiday calendar read** by year and location.
13. **Approved leave read** by date range with pagination.
14. **Shift assignment read** by employee and date range.
15. **Attendance write** — daily-total form, punch-level form, both?
16. **Attendance regularisation** submission and status.
17. **Timesheet write** (if separate from attendance).
18. **Webhooks** — for termination, employee updates, or others?
    Signing method?
19. **Bulk import** UI in greytHR for XLSX/CSV — supported file
    formats, field templates, and idempotency behaviour.

**D. Data conventions**
20. Employee ID format (numeric, alphanumeric, length).
21. Employment status vocabulary (Active / Resigned / Terminated /
    Notice / Absconded / etc.).
22. Timezone assumption for attendance timestamps (server local, UTC,
    or per-employee).
23. Support for versioned attendance records (upsert vs. append).

Once we have written answers to these, this RFC's tables in §4 and §5
move from "Proposed" to "Confirmed" for each row.

## 3. Legend for mapping tables

- **Direction** — `→` means CloudPunch reads from greytHR; `←` means
  CloudPunch writes to greytHR.
- **Status** — `Confirmed` (greytHR field name is verified),
  `Proposed` (best-effort based on public knowledge; needs greytHR
  confirmation), `TBD` (dependent on question in §2).
- **Required** — whether CloudPunch's operation requires this field.
  Required-`no` fields improve fidelity but are optional.

## 4. Inbound field mapping (greytHR → CloudPunch)

Populates the CloudPunch employee, department, location, shift,
holiday, and leave tables. Refresh cadence per ADR-0006 §3.

| greytHR field (best-known name) | Status | CloudPunch table.column | Required | Notes |
|---|---|---|---|---|
| `EmployeeID` | Proposed | `employee.greythr_employee_id` (unique, immutable once set) | yes | Primary key on greytHR side. Never renamed. |
| `EmployeeNumber` | Proposed | `employee.employee_number` | yes | Used in match rule 2 (ADR-0005 §4). |
| `OfficialEmailID` | Proposed | `employee.work_email` | yes | Case-insensitive. Used in match rule 3. |
| `FirstName` / `MiddleName` / `LastName` | Proposed | `employee.given_name` / `middle_name` / `family_name` | yes | |
| `DisplayName` | Proposed | `employee.display_name` | no | If unavailable, we compose from given + family. |
| `DateOfJoining` | Proposed | `employee.hire_date` | no | |
| `DateOfLeaving` (a.k.a. `RelievingDate`) | Proposed | `employee.termination_date` | no | If set and ≤ today with status ≠ Active, triggers termination flow (ADR-0005 §8). |
| `EmployeeStatus` | Proposed | `employee.status` (mapped enum) | yes | Vocabulary mapping in §6. |
| `Department` (name + code) | Proposed | `department.name` / `department.code` (upsert), then `employee.department_id` | yes | |
| `Location` / `OfficeLocation` | Proposed | `location.name` / `location.code` (upsert), then `employee.location_id` | no | |
| `CostCenter` (code) | Proposed | `cost_center.code` (upsert), then `employee.cost_center_id` | no | |
| `ReportingManagerID` (greytHR employee ID) | Proposed | `employee.reporting_manager_id` (FK resolved after full-employee-set upsert) | yes | Resolved in a second pass to allow forward references. |
| `ShiftCode` / `DefaultShiftCode` | Proposed | `shift.code` (upsert), then `employee.default_shift_id` | no | |
| `WorkSchedule` details (start/end/break) per `ShiftCode` | Proposed | `shift.*` fields | no | Referenced from shift record. |
| `WorkEmail` / `AlternateEmail` | Proposed | `employee.work_email` (primary) + notification profile | no | Alternate stored for notifications only. |
| `PhoneNumber` (work) | TBD | `employee_contact.work_phone` | no | Only if greytHR permits and DPIA allows. |
| **Holidays** endpoint | | | | |
| `HolidayCalendarCode` | Proposed | `holiday_calendar.code` (upsert) | yes | Location- or company-scoped per greytHR configuration. |
| `HolidayName` | Proposed | `holiday.name` | yes | |
| `HolidayDate` | Proposed | `holiday.date` | yes | |
| `HolidayType` (public / restricted / optional) | Proposed | `holiday.type` (enum) | no | |
| `AppliesToLocations` | Proposed | `holiday_scope` linking table | no | |
| **Leave** endpoint | | | | |
| `LeaveRecordID` | Proposed | `leave_record.greythr_leave_id` (unique) | yes | |
| `EmployeeID` | Proposed | resolves to `leave_record.employee_id` via employee master | yes | |
| `LeaveType` (Casual / Sick / Earned / Paid / Unpaid / Comp Off) | Proposed | `leave_record.type` (enum) | yes | Mapping in §6. |
| `FromDate` / `ToDate` | Proposed | `leave_record.start_date` / `end_date` | yes | |
| `DayFraction` (full / half / quarter) | Proposed | `leave_record.day_fraction` | no | Optional but useful for daily-hours calc. |
| `LeaveStatus` (Approved / Pending / Rejected / Cancelled) | Proposed | `leave_record.status` | yes | CloudPunch only mirrors **Approved** leave for clock-blocking. |
| `ApprovedBy` | Proposed | `leave_record.approved_by_employee_id` (resolved) | no | Display only. |
| **Shift-assignment** endpoint | | | | |
| `ShiftAssignmentID` | Proposed | `shift_assignment.greythr_id` (unique) | yes | |
| `EmployeeID` | Proposed | `shift_assignment.employee_id` | yes | |
| `ShiftCode` | Proposed | `shift_assignment.shift_id` | yes | |
| `EffectiveFrom` / `EffectiveTo` | Proposed | `shift_assignment.effective_from` / `effective_to` | yes | Null `effective_to` = ongoing. |

## 5. Outbound field mapping (CloudPunch → greytHR)

Sends approved payable attendance only. Exports require a committed
`approval` and a locked `timesheet_version` (ADR-0004 invariants).

**When we call:** each day at 05:30 IST for the prior day's approved
attendance; also immediately when a manager approves a timesheet
outside the daily window; also as part of payroll-period-close batch.

| CloudPunch source | Status | greytHR field (proposed) | Required | Notes |
|---|---|---|---|---|
| `timesheet.attendance_date` | Proposed | `AttendanceDate` | yes | Local date in `Asia/Kolkata`. |
| `employee.greythr_employee_id` | Proposed | `EmployeeID` | yes | |
| `timesheet.approved_clock_in_at` | Proposed | `InTime` | yes | Local time, HH:MM:SS. If greytHR accepts UTC, we send UTC + offset. |
| `timesheet.approved_clock_out_at` | Proposed | `OutTime` | yes | |
| `timesheet.regular_hours` | Proposed | `RegularHours` | yes | Decimal hours to 2 places. |
| `timesheet.overtime_hours` | Proposed | `OvertimeHours` | no | If greytHR field exists on our plan. |
| `timesheet.paid_break_minutes` | Proposed | `PaidBreakMins` | no | |
| `timesheet.unpaid_break_minutes` | Proposed | `UnpaidBreakMins` | no | |
| `timesheet.attendance_status` (derived) | Proposed | `Status` (P / A / HD / WFH / LEAVE / HOL) | yes | Vocabulary mapping in §6. |
| `shift.code` | Proposed | `ShiftCode` | no | Only if the employee has a shift assignment. |
| `leave_record.type` (when whole day is leave) | Proposed | `LeaveType` | conditional | Sent only when day is a leave day. |
| `timesheet.adjustment_reason` | Proposed | `Remarks` | no | Manager-approved reason string. |
| `timesheet.id` (UUID) | Proposed | `ExternalReferenceID` | yes | Enables lookup back to CloudPunch source. |
| `sync_export.idempotency_key` (see ADR-0006 §4) | TBD | `ClientRef` or `IdempotencyKey` | ideally | If greytHR does not accept it, we still store it locally and dedupe on our side via `checkAttendanceExists`. |
| `timesheet.approval_status` | Proposed | `ApprovalStatus` | no | Always `Approved` at time of export. |
| `timesheet.project_id.code` (per allocation) | Proposed | `ProjectCode` | no | Only if project-allocation is enabled and greytHR accepts. |
| `cost_center.code` (per allocation) | Proposed | `CostCenter` | no | |

Retries follow ADR-0006 §5. Duplicate exports use the idempotency
key + `checkAttendanceExists` gate to avoid double-writes even if
greytHR does not natively deduplicate.

## 6. Vocabulary mapping

**Employment status:**

| greytHR value (assumed) | CloudPunch `employee.status` | Downstream effect |
|---|---|---|
| `Active` | `active` | Full access. |
| `Resigned` (before last working day) | `active` (with `notice_period=true` flag) | Full access; flagged in admin UI. |
| `Terminated` / `Relieved` / `Left` | `terminated` | Sessions closed, App Roles revoked. |
| `Absconded` | `terminated` (with reason `absconded`) | Same as terminated. |
| `On Leave` (long-term) | `on_leave` | Cannot clock in; timesheet blocked. |

**Leave type:**

| greytHR type (assumed) | CloudPunch `leave_record.type` |
|---|---|
| `Casual Leave` | `casual` |
| `Sick Leave` | `sick` |
| `Earned Leave` / `Privilege Leave` | `earned` |
| `Paid Leave` (unspecified) | `paid` |
| `Loss of Pay` / `Unpaid` | `unpaid` |
| `Comp Off` | `comp_off` |
| `Maternity` / `Paternity` | `parental` |
| `Bereavement` | `bereavement` |
| Other | `other` |

**Attendance status (outbound):**

| CloudPunch condition | greytHR `Status` |
|---|---|
| Approved with hours ≥ full-day threshold | `P` |
| Approved with hours between half-day and full-day thresholds | `HD` |
| Approved with hours < half-day threshold and reason `wfh` | `WFH` |
| No approved attendance, no leave, not a holiday | `A` |
| Whole day is an approved leave record | `LEAVE` |
| Whole day is a holiday for the employee's calendar | `HOL` |

Half-day and full-day thresholds are policy-configurable and default
to values expected by greytHR (to be confirmed against §2 Q22).

## 7. Sync cadence proposal

Restated from ADR-0006 §3 for greytHR's reference. Cadences are
tuneable within greytHR rate limits.

| Job | Cadence | Notes |
|---|---|---|
| Employee master full sync | Weekly (Sunday 02:00 IST) | Reconciliation only. |
| Employee master delta sync | Every 15 min | Requires `modifiedSince` (§2 Q10). |
| Holiday calendar | Nightly (03:00 IST) | Low volume. |
| Approved leave delta | Every 30 min | |
| Shift assignments delta | Every 30 min | |
| Termination signal | Real-time if webhook available (§2 Q18); else via 15-min delta | |
| Approved attendance export | Daily 05:30 IST for prior day + on-demand per approval | Idempotent. |
| Payroll period close export | On period close + on-demand | Bulk, idempotent. |
| Health probe | Every minute | |

## 8. CSV fallback (if the API is limited or unavailable)

Per ADR-0006 §9. Files exchanged via S3 (or SFTP, if greytHR
prefers). Filename convention:

- Outbound (CloudPunch → greytHR): `cloudpunch_attendance_YYYY-MM-DD.xlsx`
  with a matching `manifest.json` including `batch_id`, `idempotency_key`
  per row, `row_count`, `sha256_hash`.
- Inbound (greytHR → CloudPunch): CSV per domain (`employees.csv`,
  `holidays.csv`, `leave.csv`, `shifts.csv`) with a `manifest.json`
  including `generated_at` and `row_count`.

Bulk-import into greytHR is done by an ApTask admin using greytHR's
existing UI. CloudPunch marks the batch as `EXPORTED` in the
reconciliation dashboard once the admin confirms upload success.

## 9. Security posture

- Credentials stored in AWS Secrets Manager (ADR-0007 §2).
- TLS 1.2+ on all API calls.
- HMAC-SHA256 webhook signature verification if greytHR supports
  webhooks.
- Redaction on every log line; PII scrubbed by dedicated middleware.
- No employee PII from raw event data (mouse, keyboard, device,
  anomaly) is ever sent to greytHR unless a specific business
  requirement is approved in a future RFC.

## 10. Open questions for the project owner

Independent of greytHR's answers, ApTask needs to decide:

1. Whether outbound export sends per-day punches or only daily totals
   (depends on greytHR's supported endpoints, but ApTask should have
   a preference).
2. Whether we mirror greytHR's leave records for display in the
   CloudPunch employee view (recommendation: yes; it prevents
   employees from clocking in on days they are supposed to be off).
3. Whether project / cost-centre allocation is a Phase 2 feature
   (recommendation: yes — MVP does not require it).
4. Retention of exported files (CSV fallback) — default 3 years,
   matches `time_event`.
5. Which ApTask team member is the day-to-day integration owner post-
   launch.

## 11. Sign-off

| Party | Name | Role | Date |
|---|---|---|---|
| ApTask project owner | Abdulla Sheikh | Approver | _(pending)_ |
| ApTask security | TBD | Reviewer | _(pending)_ |
| greytHR customer success | TBD | Provider | _(pending)_ |
| greytHR API/product | TBD | Reviewer | _(pending)_ |

Once all four parties have signed off, this document is versioned into
Git under the tag `greythr-mapping-v1.0` and referenced from ADR-0006
as the mapping of record.

## 12. Change log

- 2026-09-23 — v0.1 draft, awaiting greytHR API entitlement
  confirmation.
