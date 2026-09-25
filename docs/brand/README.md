# CloudPunch brand assets

Source: the logo supplied by the project owner (2026-09-25). Every other
asset is derived from it; if a vector original becomes available, put it
here and regenerate.

| File | What | Used for |
|---|---|---|
| `cloudpunch-logo.png` | Full logo (cloud + "CloudPunch"), transparent, trimmed | Source for the in-app and browser logos; docs; future web dashboard |
| `cloudpunch-mark.png` | The cloud-and-clock mark alone, 1024×1024, transparent | Source for icons |
| `cloudpunch-app-icon.png` | The mark on a white rounded tile, 1024×1024 | App icon source (`tauri icon`) |

## All formats

| Folder | Files | Use |
|---|---|---|
| `logo/` | `cloudpunch-logo-{240,480,960,1920}w.png` | Full logo, transparent, on light backgrounds |
| | `cloudpunch-logo-reversed-*.png` / `.webp` | Navy parts in white, for dark or navy backgrounds |
| | `cloudpunch-logo-navy-*.png`, `cloudpunch-logo-white-*.png` | One-colour versions (print, watermarks, single-colour UIs) |
| | `cloudpunch-logo-on-white.jpg`, `cloudpunch-logo-on-navy.jpg` | Flat, padded, for email and documents that can't do transparency |
| | `cloudpunch-logo.webp` | Web |
| `mark/` | `cloudpunch-mark{,-reversed,-navy,-white}-{16…1024}.png` | The cloud mark alone, square, transparent |
| `app-icon/` | `cloudpunch-app-icon-{16…1024}.png`, `cloudpunch.ico` | The mark on a white rounded tile (app icon) |
| `favicon/` | `favicon.ico`, `favicon-{16,32,192,512}.png`, `apple-touch-icon.png` | Future web dashboard |

## Colours

| Name | Hex | Where |
|---|---|---|
| Navy | `#012456` | "Cloud", dark half of the cloud, clock ticks |
| Blue | `#018AFE` | "Punch", light half of the cloud |
| Teal | `#00BFB5` | The check mark |

## Rules

- **On dark backgrounds, use the reversed logo** (navy parts in white),
  or the white-tile app icon. The navy half of the cloud and wordmark
  disappears on dark surfaces. The app's dark theme uses the reversed
  logo.
- **Small sizes (under 32 px) use the mark, not the full logo.**
- The tray icon is the tiled mark plus a status-colour dot
  (ADR-0013 §3).

## Where it appears

- App icon (taskbar, Start menu, Alt-Tab, `.exe`, future installer):
  `apps/desktop/src-tauri/icons/`
- Tray: `apps/desktop/src-tauri/icons/tray-base.rgba` + `tray.rs`
- Main window header and sign-in screen:
  `apps/desktop/src/assets/cloudpunch-logo.png` via `ui/Logo.tsx`
- Browser page after sign-in:
  `apps/desktop/src-tauri/icons/signed-in-logo.png`

## Regenerating

The derived files were produced with Pillow: trim to content, split the
mark from the wordmark, pad the mark to a square, add the white tile,
and resize. Then run `npx tauri icon ../../docs/brand/cloudpunch-app-icon.png`
from `apps/desktop`.
