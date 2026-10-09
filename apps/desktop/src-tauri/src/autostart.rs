//! Start CloudPunch when the person signs in to Windows (ADR-0036 §1).
//!
//! - The app writes `HKCU\…\Run` value `CloudPunch` on every start, if
//!   it is missing or points elsewhere, so a moved install or a value
//!   an update removed comes back.
//! - Task Manager's on/off switch lives in a separate `StartupApproved`
//!   value that this never touches, so switching it off sticks.
//! - Started with [`ARG`], the window stays in the tray until the
//!   clock-in popup brings it forward.
//! - The uninstaller removes the value (`installer-hooks.nsh`).

/// Marks a launch by Windows at sign-in.
pub const ARG: &str = "--autostart";

/// The `Run` value name; the uninstall hook deletes the same name.
pub const VALUE_NAME: &str = "CloudPunch";

/// Whether this launch came from the `Run` key.
pub fn launched_at_sign_in<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().skip(1).any(|a| a == ARG)
}

/// What `Run` should hold for `exe`.
pub fn run_value(exe: &std::path::Path) -> String {
    format!("\"{}\" {ARG}", exe.display())
}

/// Make sure `Run` starts this executable. `Ok(true)` when it wrote.
#[cfg(target_os = "windows")]
pub fn register() -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    let exe = std::env::current_exe().map_err(|e| format!("exe path: {e}"))?;
    let wanted = run_value(&exe);
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(RUN)
        .map_err(|e| format!("open Run: {e}"))?;
    if key.get_value::<String, _>(VALUE_NAME).ok().as_deref() == Some(wanted.as_str()) {
        return Ok(false);
    }
    key.set_value(VALUE_NAME, &wanted)
        .map_err(|e| format!("write Run: {e}"))?;
    Ok(true)
}

/// Windows only for now (ADR-0036 §1).
#[cfg(not(target_os = "windows"))]
pub fn register() -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_flag_after_the_program_counts() {
        assert!(launched_at_sign_in(args(&[
            "cloudpunch-desktop.exe",
            "--autostart"
        ])));
        assert!(!launched_at_sign_in(args(&["cloudpunch-desktop.exe"])));
        assert!(!launched_at_sign_in(args(&["--autostart"])));
        assert!(!launched_at_sign_in(args(&[
            "cloudpunch-desktop.exe",
            "--autostarts"
        ])));
    }

    #[test]
    fn the_run_value_quotes_the_path() {
        let exe =
            std::path::Path::new(r"C:\Users\a b\AppData\Local\CloudPunch\cloudpunch-desktop.exe");
        assert_eq!(
            run_value(exe),
            r#""C:\Users\a b\AppData\Local\CloudPunch\cloudpunch-desktop.exe" --autostart"#
        );
    }
}
