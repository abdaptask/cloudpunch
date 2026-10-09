; ADR-0036 §1: uninstalling stops CloudPunch starting at sign-in. The app
; writes this value itself on every start (src/autostart.rs), so an
; update that runs this hook gets it back on the next start.
!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CloudPunch"
!macroend
