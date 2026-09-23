# Desktop app icons

Icon files (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`,
`icon.ico`) are added when we start producing installers in Phase 2b.9.
At the current slice `bundle.active` is `false` in `tauri.conf.json`,
so no icons are required for `cargo check` or `tauri dev` runs.

When the time comes, generate them via the Tauri CLI:

```
pnpm -F @cloudpunch/desktop tauri icon path/to/master-logo.png
```

The master logo must be at least 1024×1024 PNG with transparency.
