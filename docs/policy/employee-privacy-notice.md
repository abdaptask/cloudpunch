# CloudPunch — Employee privacy notice

- **Status:** Template draft. Requires review by apTask HR and by
  legal counsel qualified under India's Digital Personal Data
  Protection Act, 2023 (DPDPA) before being shown to employees.
- **Last updated:** 2026-09-23.
- **Intended audience:** every apTask employee who uses CloudPunch.

This notice explains, in plain language, what CloudPunch records about
your workday, what it does not record, why, who can see the data, how
long we keep it, and what you can do about it.

If anything in this notice is unclear or feels wrong, please raise it
with your HR business partner or the CloudPunch administrator listed
at the end.

## What CloudPunch is

CloudPunch is apTask's internal system for recording your work hours,
breaks, and attendance. It replaces manual timesheets and pushes
approved attendance to greytHR for payroll processing.

CloudPunch has three parts you interact with:

- A **desktop app** you install on your work computer (Windows or
  macOS), which records when you clock in, clock out, and take breaks.
- A **web dashboard** where you can view your own timesheets, request
  corrections, and certify each week.
- A **backend service** that stores and processes your time records
  securely.

## What CloudPunch records

The desktop app records **only the events needed to track working
time**. These are:

- The time you **clock in** and the time you **clock out**.
- The time you **start a break** and the time you **end a break**.
- Whether your **screen is locked or your computer is asleep**
  (yes / no + when the state changed).
- Whether your **keyboard or mouse has been used recently** (yes / no
  + how long since the last activity). We do **not** record what you
  typed or where you moved the pointer.
- Whether **any application on your computer is currently using the
  microphone or camera**, and if so **what kind of call it is**: a
  Microsoft Teams call, a Zoom call, or another call. This lets CloudPunch recognise that you are
  on a call, not interrupt you with idle prompts, and show the kind of
  call on your timeline. We record **only the kind of call** — not the
  app's name for any other app, not any audio or video, not what was
  said, and not the meeting name or participants.
- Whether your computer is **online or offline**.
- Your responses to any **prompts** we show you (for example, "still
  working" / "bio break" / "meal break").
- The **version of CloudPunch** you have installed and basic device
  identifiers so we can support you.
- Your **Microsoft work account** identifier so we know which employee
  the events belong to.

That is the complete list. Every piece of it exists in
`packages/event-schema/` inside the CloudPunch source code, and any
attempt to add a field outside that list is blocked by an automated
check in our build process.

## What CloudPunch does NOT record

CloudPunch is intentionally built to **not** record any of the
following:

- **The keys you press** or the text you type. Ever.
- **Screenshots** of your screen, or any form of screen recording.
- **The contents of your clipboard**.
- **The names of files** you open or the folders you use.
- **Your browser history** or the websites you visit.
- **Which applications** you have open or use — other than the kind
  of call described above.
- **Titles** of any windows.
- **Any audio or video** from your microphone or camera.
- **Your physical location or GPS coordinates.**
- Any **health, biometric, financial, or personal messages** data.

If a future version of CloudPunch ever adds any capability from this
list, apTask will notify you separately, explain the reason, and give
you a chance to raise concerns before it becomes active.

## Why we collect what we collect

Every field CloudPunch records exists for one of three reasons:

1. **To calculate payable hours accurately.** Clock-in / clock-out,
   break start / end, and the "how long since your last input" signal
   feed the hours we send to greytHR for your salary.
2. **To respect your time.** The mic/camera in-use signal lets us
   avoid disturbing you with idle prompts when you are clearly on a
   call. Screen-lock and sleep events let us recognise when you are
   away from your computer.
3. **To keep the records honest.** Device version, event ordering,
   and cryptographic signatures let CloudPunch tell whether an event
   really came from your computer or has been tampered with.

## The 5-minute idle prompt

If your computer sees no keyboard or pointer activity for 5 minutes
**and** no microphone or camera is in use, CloudPunch will show you a
prompt asking what you are doing. You can choose:

- **I'm still working** — dismisses the prompt, keeps the timer going.
- **Bio break** — starts a short break (default cap 10 minutes).
- **Meal break** — starts a longer, unpaid break.
- **On a phone call** — you are working on a call not tied to your
  computer.
- **Working away from the computer** — you are working, just not on
  the computer (whiteboard, paperwork, offline meeting).
- **End my shift now** — clocks you out cleanly.

If you do not respond within **30 seconds**, CloudPunch will
automatically clock you out to avoid inflating your hours. The time
you worked up to the moment the prompt appeared is preserved and
counts. The 5-minute idle window and the 30-second grace do not count
toward paid time.

You can adjust these defaults through your admin if the settings do
not fit your team's work.

## Autostart

By default, CloudPunch does **not** start when you sign in to your
computer. You choose when to open it and clock in. Your administrator
can enable autostart if your team prefers, but even when autostart is
on, the app never clocks you in automatically — you still click the
button.

## Who can see your data

Access is on a strict need-to-know basis:

- **You** can see all of your own time records, corrections, and the
  reasons for every edit.
- **Your reporting manager** can see your daily timeline (clock-in,
  clock-out, breaks, states) but not the underlying raw event stream.
  Your manager sees "you were active", "you were on break", and the
  kind of call you were on (for example "Teams call, 3:15–3:45 pm") —
  never what was said.
- **HR** can see the same view as your manager and can access
  employee records, department assignments, and leave history.
- **Payroll** can see approved hours only.
- **Auditors** can see the raw audit trail for compliance reviews.
- **CloudPunch administrators** can configure the system and see
  aggregate operational data (for example, "50 users clocked in
  today"). They can also access individual data during a support
  ticket you have opened, and every such access is logged.

No one outside apTask can see your data. Approved attendance totals
are sent to greytHR for payroll. Raw activity data is never sent to
greytHR.

## Corrections and disputes

If you see a mistake on your timesheet:

- Use the **Request correction** button in the web dashboard. Add a
  short reason. Your manager will review and either approve, reject,
  or ask for more information.
- The original record is never deleted. Corrections create a new
  version alongside the original so the change is auditable.
- If you disagree with your manager's decision, you can escalate to
  HR through the standard grievance channel.

## How long we keep your data

- **Raw time events** — 3 years by default.
- **Timesheets and approvals** — 3 years by default.
- **Audit records** — 7 years, as is standard for wage and hour
  records.
- **Notifications and non-payroll operational data** — 90 days.

After the retention period, records are moved to encrypted archival
storage and eventually deleted, except where legal hold applies.

If you leave apTask, your records are retained per the retention
periods above. They are not immediately deleted because payroll
records typically have a statutory minimum retention.

## Your rights under DPDPA

Under the Digital Personal Data Protection Act, 2023, and apTask
policy, you have the right to:

- **See** the personal data CloudPunch holds about you. Ask through
  the web dashboard's "Download my data" feature or through HR.
- **Correct** inaccurate records through the correction workflow.
- **Ask questions** about how a specific record was produced. Every
  event carries enough metadata to explain itself.
- **Nominate** a person to act on your behalf if you are unable to
  exercise these rights yourself.
- **Withdraw consent** to being monitored electronically. Because
  timekeeping is a condition of employment, withdrawing consent will
  require an alternative arrangement discussed with HR.
- **Complain** to the Data Protection Board of India if you believe
  your rights are being violated.

Requests are answered within the timeline required by DPDPA and
apTask's internal data-request policy.

## Security

- Your login uses your existing Microsoft work account through
  Microsoft Entra ID. CloudPunch does not create or store separate
  passwords for you.
- The data CloudPunch keeps on your computer is stored in an
  encrypted local database.
- Your session tokens live in the Windows Credential Manager or
  macOS Keychain — the same secure storage other apps on your
  computer use.
- Data in transit uses TLS. Data at rest is encrypted with keys held
  in AWS Key Management Service.

## Changes to this notice

If apTask changes how CloudPunch collects or uses your data, this
notice will be updated and every employee will be notified at least
30 days before the change takes effect. Changes that expand what is
collected require a fresh review by HR and legal counsel.

## Contact

- **CloudPunch administrator:** *(to be filled by apTask before
  distribution)*
- **HR:** *(to be filled)*
- **Data protection contact:** *(to be filled — the person or
  address to whom DPDPA requests should be sent)*

---

*This notice is a plain-language explanation, not a legal contract.
For the full legal terms governing CloudPunch's data handling, refer
to your employment agreement and apTask's Data Protection Policy.*
