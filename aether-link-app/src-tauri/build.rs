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
    export_public_firebase_env_from_dotenv();
    tauri_build::build()
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
