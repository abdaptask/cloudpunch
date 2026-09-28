# ADR-0017 — Pinned mini strip, and minimise pins it

- **Status:** Accepted (2026-09-28, choices approved by the project owner)
- **Date:** 2026-09-28
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0013 (tray residency; the close dialog), ADR-0008
  (idle prompt window), ADR-0016 (day history).
- **Confidence:** Medium-high. Pinning, placement and sizing are unit
  tested. On Windows, minimise is detected from the `Resized` event plus
  `is_minimized()`, which is expected but has not been checked on every
  Windows build. Minimise-to-pin on macOS is **not verified** (see
  Consequences). The pin button works on both.

## Context

Employees keep CloudPunch open all day, but the full window (420 px
wide, up to most of the screen height) covers their work. The owner
wants it to "stick to the desktop" when minimised: a small view that
stays visible and shows at a glance whether they are on the clock.
The owner also asked that the full window stop filling small screens.

## Decision

### 1. The strip

The main window can turn into a **strip**: 320 px wide and 56–220 px
tall (it follows its content), borderless and always on top. It shows:

- a status light, with an amber pulse while the idle prompt waits or
  the shift runs long;
- the live session timer, or the hours worked today when clocked out;
- **one contextual action**: Clock in, End break, I'm back, or Break
  (which offers Bio / Meal).
- On hover, today's worked and break totals and the break choices.

**Clock out is not on the strip.** It asks first (ADR-0013, owner
request), and it does that in the full window. While the idle prompt
is pending, the strip offers no action: the prompt window has the
answers (ADR-0008).

### 2. How it is turned on and off

- **Pin button** in the header ("Pin to desktop").
- **Minimise pins it.** While signed in, minimising the main window
  restores it straight away as the strip. Signed out, minimise is
  ordinary.
- **A pinned strip that gets minimised comes back.** This covers Show
  desktop and Win+M, so it stays on the desktop.
- **Unpin**: double-click the strip, or its ⤢ button. The full window
  returns to where it was.
- **Sign-out unpins** (in Rust), so a strip is never left behind for a
  signed-out user.
- **Close while pinned** unpins first, so the close dialog of
  ADR-0013 §1 can ask its question.

### 3. Where it goes

The first time, the strip goes to the top-right of the screen the window
is on, 16 px in from the edge. After a drag, the spot is kept in
`strip.json` in the app data folder. That file holds only two numbers,
nothing about the user. A saved spot is used only if the strip's top
edge would still be on an attached screen; otherwise the strip goes back
to the default.

### 4. Least privilege

Pinning, unpinning, always-on-top, borders and size all stay in **Rust
commands** (`pin_window`, `unpin_window`, `pin_status`, `fit_window`),
as before. The page gets **one** new window permission,
`core:window:allow-start-dragging`, so the borderless strip can be
moved. It is granted to the `main` window only, in its own capability
file (`capabilities/main-window.json`). The idle-prompt window gets
nothing new. Starting a drag lets the page move its own window only;
it cannot resize, close or show other windows.

A drag starts only after the mouse moves 4 px with the button held.
That keeps click and double-click working, and avoids Tauri's
`data-tauri-drag-region`, where a double-click maximises the window.

### 5. The full window on small screens

The full window now grows to at most about **70% of the work area**
(never less than 560 px, never past the work area less 40 px). The
status card and actions stay fixed at the top, and the details scroll
under them.

## Consequences

- **Positive:** The status is visible all day without covering work.
  The strip has fewer actions than the full window, so a mis-click
  can't clock anyone out. The strip adds no content capture (no data
  about other apps), so no-content-capture invariant 1 is unchanged.
- **Negative:** One new webview permission (start dragging, main window
  only). Minimise no longer puts the app in the taskbar. The strip keeps
  its taskbar entry, and the tray still works.
- **macOS:** Tauri 2 has no minimise event. Whether macOS sends
  `Resized` on minimise (and so pins the strip) is **not verified**. The
  pin button is the supported way there until we test it in phase 2b.8.
- **Follow-ups:** Verify minimise-to-pin on Windows 10 and on macOS.
  Consider letting policy hide the strip for roles that don't need it.

## Alternatives considered

- **Pin button only, minimise stays ordinary.** Simpler, but it doesn't
  match the owner's request that the app stick to the desktop when
  minimised.
- **A second, separate strip window.** Two webviews would both need the
  state and auth listeners, and focus rules get harder to follow.
  Resizing the one main window is simpler and keeps one source of truth.
- **`data-tauri-drag-region`.** Its double-click maximises the window,
  which conflicts with double-click to unpin.
- **Clock out on the strip.** Rejected: clock-out asks first (owner
  request), and a one-click clock-out on an always-on-top strip is easy
  to hit by accident.
