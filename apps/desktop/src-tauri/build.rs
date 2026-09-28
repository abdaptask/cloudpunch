use std::path::PathBuf;

fn main() {
    // A pilot build may carry the pilot server's CA root (ADR-0019):
    // CLOUDPUNCH_BUILD_CA_PEM names a PEM file, copied into OUT_DIR for
    // `backend_http.rs` to include. Other builds get an empty file.
    println!("cargo:rerun-if-env-changed=CLOUDPUNCH_BUILD_CA_PEM");
    println!("cargo:rerun-if-env-changed=CLOUDPUNCH_BACKEND_URL");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("pilot_ca.pem");
    let pem = match std::env::var("CLOUDPUNCH_BUILD_CA_PEM") {
        Ok(path) if !path.trim().is_empty() => {
            println!("cargo:rerun-if-changed={path}");
            let pem = std::fs::read(&path)
                .unwrap_or_else(|e| panic!("CLOUDPUNCH_BUILD_CA_PEM {path}: {e}"));
            assert!(
                pem.starts_with(b"-----BEGIN CERTIFICATE-----"),
                "CLOUDPUNCH_BUILD_CA_PEM must be a PEM certificate"
            );
            pem
        }
        _ => Vec::new(),
    };
    std::fs::write(&out, pem).expect("write pilot_ca.pem");

    tauri_build::build()
}
