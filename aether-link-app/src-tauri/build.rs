use std::{collections::HashMap, fs, path::Path};

const FIREBASE_VITE_KEYS: [&str; 6] = [
    "VITE_WONREMOTE_FIREBASE_API_KEY",
    "VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN",
    "VITE_WONREMOTE_FIREBASE_PROJECT_ID",
    "VITE_WONREMOTE_FIREBASE_APP_ID",
    "VITE_WONREMOTE_FIREBASE_STORAGE_BUCKET",
    "VITE_WONREMOTE_FIREBASE_MESSAGING_SENDER_ID",
];

fn main() {
    println!("cargo:rerun-if-env-changed=WONREMOTE_DEFAULT_APP_MODE");
    if let Ok(default_mode) = std::env::var("WONREMOTE_DEFAULT_APP_MODE") {
        if !default_mode.trim().is_empty() {
            println!("cargo:rustc-env=WONREMOTE_DEFAULT_APP_MODE={}", default_mode.trim());
        }
    }
    ensure_dist_poc_resource_exists_for_cargo_metadata();
    ensure_dist_poc_vc_runtime_exists_for_cargo_metadata();
    ensure_dist_native_node_datachannel_exists_for_cargo_metadata();
    export_public_firebase_env_from_dotenv();
    tauri_build::build()
}

fn ensure_dist_poc_resource_exists_for_cargo_metadata() {
    let dist_poc_path = Path::new("../dist-poc/wonremote-poc.exe");
    println!("cargo:rerun-if-changed={}", dist_poc_path.display());
    if dist_poc_path.exists() {
        return;
    }

    if let Some(parent) = dist_poc_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let existing_release_poc = Path::new("../../aether-link-poc/target/release/wonremote-poc.exe");
    if existing_release_poc.exists() {
        let _ = fs::copy(existing_release_poc, dist_poc_path);
    } else {
        let _ = fs::write(dist_poc_path, []);
    }
}

fn ensure_dist_poc_vc_runtime_exists_for_cargo_metadata() {
    let dist_runtime_path = Path::new("../dist-poc/vcruntime140.dll");
    println!("cargo:rerun-if-changed={}", dist_runtime_path.display());
    if dist_runtime_path.exists() {
        return;
    }

    if let Some(parent) = dist_runtime_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let target = std::env::var("TARGET").unwrap_or_default();
    let system_runtime = if target.starts_with("i686-") {
        Path::new(&system_root).join("SysWOW64").join("vcruntime140.dll")
    } else {
        Path::new(&system_root).join("System32").join("vcruntime140.dll")
    };

    if system_runtime.exists() {
        let _ = fs::copy(system_runtime, dist_runtime_path);
    } else {
        let _ = fs::write(dist_runtime_path, []);
    }
}

fn ensure_dist_native_node_datachannel_exists_for_cargo_metadata() {
    let native_dir = Path::new("../dist-native/node-datachannel");
    println!("cargo:rerun-if-changed={}", native_dir.display());
    if native_dir.exists() {
        return;
    }

    let _ = fs::create_dir_all(native_dir);
    let package_json = native_dir.join("package.json");
    let unavailable_module = native_dir.join("unavailable.mjs");
    let _ = fs::write(
        package_json,
        r#"{"name":"node-datachannel","version":"0.0.0-wonremote-placeholder","type":"module","exports":{".":"./unavailable.mjs","./polyfill":"./unavailable.mjs"}}"#,
    );
    let _ = fs::write(
        unavailable_module,
        "throw new Error('node-datachannel placeholder created for cargo metadata only. Run npm run build before packaging.');\n",
    );
}

fn export_public_firebase_env_from_dotenv() {
    let dotenv_path = Path::new("../.env");
    println!("cargo:rerun-if-changed={}", dotenv_path.display());

    let dotenv_values = read_dotenv(dotenv_path);
    for key in FIREBASE_VITE_KEYS {
        if std::env::var_os(key).is_some() {
            continue;
        }
        if let Some(value) = dotenv_values.get(key).filter(|value| !value.trim().is_empty()) {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn read_dotenv(path: &Path) -> HashMap<String, String> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };

    content
        .lines()
        .filter_map(parse_dotenv_line)
        .collect::<HashMap<_, _>>()
}

fn parse_dotenv_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let (key, value) = trimmed.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }

    Some((key.to_string(), trim_dotenv_value(value).to_string()))
}

fn trim_dotenv_value(value: &str) -> &str {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
}
