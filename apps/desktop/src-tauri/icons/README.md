# Desktop app icons

Generated from the brand app icon (`docs/brand/cloudpunch-app-icon.png`:
the CloudPunch mark on a white rounded tile, 1024×1024) with:

```
cd apps/desktop && npx tauri icon ../../docs/brand/cloudpunch-app-icon.png
```

That writes every size here (Windows `.ico`, macOS `.icns`, the store
logos, and Android/iOS sets Tauri emits even though we don't ship them).

Two files are ours, not Tauri's:

- `tray-base.rgba`: the 32×32 tray tile as raw RGBA. `tray.rs` draws
  the status dot on it at run time, so no image decoding is needed.
- `signed-in-logo.png`: the logo on the browser page shown after
  sign-in (`auth/loopback.rs`, embedded as a data URI).

Regenerate all of them from `docs/brand/` if the logo changes (see
`docs/brand/README.md`).
