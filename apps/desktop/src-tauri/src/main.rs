// Prevent additional console window on Windows in release; keep the
// console attached in debug for developer visibility.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cloudpunch_desktop_lib::run()
}
