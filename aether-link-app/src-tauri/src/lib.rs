use std::os::windows::io::AsRawHandle;
use std::{
    env, io, mem,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    ptr, thread,
    time::{Duration, Instant},
};

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Mutex};

use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;
const STARTUP_REGISTRY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_REGISTRY_VALUE: &str = "WonRemoteViewer";
const AGENT_REGISTRY_VALUE: &str = "WonRemoteAgent";
const LOCAL_API_HOST: &str = "127.0.0.1";
const LOCAL_API_PORT: u16 = 8787;
const FIREBASE_API_KEY: Option<&str> = option_env!("VITE_WONREMOTE_FIREBASE_API_KEY");
const FIREBASE_AUTH_DOMAIN: Option<&str> = option_env!("VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN");
const FIREBASE_PROJECT_ID: Option<&str> = option_env!("VITE_WONREMOTE_FIREBASE_PROJECT_ID");
const FIREBASE_APP_ID: Option<&str> = option_env!("VITE_WONREMOTE_FIREBASE_APP_ID");
const FIREBASE_STORAGE_BUCKET: Option<&str> = option_env!("VITE_WONREMOTE_FIREBASE_STORAGE_BUCKET");
const FIREBASE_MESSAGING_SENDER_ID: Option<&str> =
    option_env!("VITE_WONREMOTE_FIREBASE_MESSAGING_SENDER_ID");

pub struct Job {
    handle: HANDLE,
}

unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> Result<Self, std::io::Error> {
        unsafe {
            let handle = CreateJobObjectW(ptr::null(), ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let res = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );

            if res == 0 {
                let err = std::io::Error::last_os_error();
                windows_sys::Win32::Foundation::CloseHandle(handle);
                return Err(err);
            }

            Ok(Job { handle })
        }
    }

    pub fn assign(&self, process: &std::process::Child) -> Result<(), std::io::Error> {
        unsafe {
            let proc_handle = process.as_raw_handle() as HANDLE;
            let res = AssignProcessToJobObject(self.handle, proc_handle);
            if res == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

pub struct AgentState {
    pub child_process: Arc<Mutex<Option<std::process::Child>>>,
    pub status: Arc<Mutex<String>>,
    pub status_menu_item: Arc<Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            child_process: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new("Offline".to_string())),
            status_menu_item: Arc::new(Mutex::new(None)),
        }
    }
}

fn is_agent_registered() -> bool {
    default_agent_config_path()
        .as_ref()
        .is_some_and(|config_path| config_has_registered_device_id(config_path))
}

fn config_has_registered_device_id(config_path: &Path) -> bool {
    if !config_path.exists() {
        return false;
    }

    let Ok(content) = std::fs::read_to_string(config_path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };

    json.get("registeredDeviceId")
        .and_then(|v| v.as_str())
        .is_some_and(|device_id| !device_id.trim().is_empty())
}

fn spawn_agent_only_process(
    app_handle: tauri::AppHandle,
    agent_state: &AgentState,
    job: &Job,
    resource_dir: &Path,
    api_url: Option<&str>,
) -> Result<(), io::Error> {
    {
        let mut child_guard = agent_state.child_process.lock().unwrap();
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill();
        }
    }

    *agent_state.status.lock().unwrap() = "Connecting".to_string();

    if let Some(menu_item) = &*agent_state.status_menu_item.lock().unwrap() {
        let _ = menu_item.set_text("Status: Connecting");
    }

    let mut command = if cfg!(debug_assertions) {
        let cwd = app_root_from_manifest();
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "npm run agent:watch"]);
        cmd.current_dir(&cwd);
        cmd
    } else {
        let node_path = bundled_node_path(resource_dir);
        let agent_path = resource_dir.join("agent").join("index.mjs");
        let poc_path = resource_dir.join("bin").join("wonremote-poc.exe");

        ensure_resource_exists(&node_path, "bundled Node runtime")?;
        ensure_resource_exists(&agent_path, "bundled Agent")?;
        ensure_resource_exists(&poc_path, "bundled Rust PoC")?;

        let mut cmd = Command::new(&node_path);
        cmd.arg(&agent_path);
        cmd.arg("--watch");
        cmd.env("WONREMOTE_POC_PATH", &poc_path);
        cmd.env("WONREMOTE_APP_DIR", resource_dir);
        cmd.env("NODE_ENV", "production");
        cmd
    };

    if let Some(url) = api_url {
        command.env("WONREMOTE_API_URL", url);
    } else {
        command.env("WONREMOTE_API_URL", "http://127.0.0.1:8787");
    }
    apply_firebase_env(&mut command);

    add_no_window(&mut command);

    command.stdout(std::process::Stdio::piped());

    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("Failed to open stdout");

    job.assign(&child)?;

    {
        let mut child_guard = agent_state.child_process.lock().unwrap();
        *child_guard = Some(child);
    }

    let status_clone = agent_state.status.clone();
    let status_menu_item_clone = agent_state.status_menu_item.clone();
    let app_handle_clone = app_handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut unregistered_detected = false;
        for line in reader.lines() {
            if let Ok(line_str) = line {
                println!("[Agent Output] {}", line_str);
                if line_str.contains("[Error] Agent unregistered") {
                    unregistered_detected = true;
                }
                let new_status = if line_str.contains("[Status] Connecting") {
                    Some("Connecting")
                } else if line_str.contains("[Status] Online") {
                    Some("Online")
                } else if line_str.contains("[Status] Offline") {
                    Some("Offline")
                } else {
                    None
                };

                if let Some(status_str) = new_status {
                    *status_clone.lock().unwrap() = status_str.to_string();
                    if let Some(menu_item) = &*status_menu_item_clone.lock().unwrap() {
                        let _ = menu_item.set_text(format!("Status: {status_str}"));
                    }
                }
            }
        }
        if unregistered_detected {
            if let Some(window) = app_handle_clone.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn get_app_mode() -> String {
    if launched_as_agent() {
        "agent".to_string()
    } else {
        "viewer".to_string()
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveConfigInput {
    business_number: String,
    install_id: String,
    registered_device_id: String,
    version: String,
    api_url: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GetConfigOutput {
    business_number: String,
    install_id: String,
    registered_device_id: String,
    version: String,
    api_url: String,
}

#[tauri::command]
fn save_agent_config(
    app: tauri::AppHandle,
    config: SaveConfigInput,
    agent_state: tauri::State<'_, AgentState>,
    job: tauri::State<'_, Job>,
) -> Result<(), String> {
    let config_path =
        default_agent_config_path().ok_or_else(|| "Failed to get config path".to_string())?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json_content = serde_json::json!({
        "businessNumber": config.business_number,
        "installId": config.install_id,
        "registeredDeviceId": config.registered_device_id,
        "version": config.version,
        "apiUrl": config.api_url,
    });
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&json_content).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    set_startup_registry(true, true).map_err(|e| e.to_string())?;

    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    start_local_api_server_for_mode(&job, &resource_dir).map_err(|e| e.to_string())?;
    spawn_agent_only_process(
        app.clone(),
        &agent_state,
        &job,
        &resource_dir,
        Some(&config.api_url),
    )
    .map_err(|e| e.to_string())?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    Ok(())
}

#[tauri::command]
fn restart_agent_process(
    app: tauri::AppHandle,
    agent_state: tauri::State<'_, AgentState>,
    job: tauri::State<'_, Job>,
) -> Result<(), String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;

    start_local_api_server_for_mode(&job, &resource_dir).map_err(|e| e.to_string())?;

    let mut api_url = None;
    if let Some(config_path) = default_agent_config_path() {
        if config_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(url) = json.get("apiUrl").and_then(|v| v.as_str()) {
                        api_url = Some(url.to_string());
                    }
                }
            }
        }
    }

    spawn_agent_only_process(
        app.clone(),
        &agent_state,
        &job,
        &resource_dir,
        api_url.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_agent_config() -> Option<GetConfigOutput> {
    let config_path = default_agent_config_path()?;
    if !config_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    Some(GetConfigOutput {
        business_number: json
            .get("businessNumber")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        install_id: json
            .get("installId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        registered_device_id: json
            .get("registeredDeviceId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        version: json
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or(env!("CARGO_PKG_VERSION"))
            .to_string(),
        api_url: json
            .get("apiUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("http://127.0.0.1:8787")
            .to_string(),
    })
}

fn add_no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn spawn_managed(job: &Job, command: &mut Command, label: &str) -> Result<(), io::Error> {
    let mut child = command
        .spawn()
        .map_err(|err| io::Error::new(err.kind(), format!("failed to spawn {label}: {err}")))?;

    if let Err(err) = job.assign(&child) {
        let _ = child.kill();
        return Err(io::Error::new(
            err.kind(),
            format!("failed to assign {label} to cleanup job: {err}"),
        ));
    }

    Ok(())
}

fn default_agent_config_path() -> Option<PathBuf> {
    if let Some(config_path) = env::var_os("WONREMOTE_AGENT_CONFIG") {
        return Some(PathBuf::from(config_path));
    }

    env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|base_dir| base_dir.join("WonRemote").join("agent-config.json"))
}

fn executable_name_requests_agent() -> bool {
    env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
        })
        .is_some_and(|stem| executable_stem_requests_agent(&stem))
}

fn executable_stem_requests_agent(stem: &str) -> bool {
    stem.to_ascii_lowercase().contains("agent")
}

fn launched_as_agent() -> bool {
    let args: Vec<String> = std::env::args().collect();
    args.iter().any(|arg| arg == "--agent")
        || env::var("WONREMOTE_RUN_AS_AGENT").is_ok()
        || executable_name_requests_agent()
}

fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("runtime").join("node.exe")
}

fn app_root_from_manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live under the app root")
        .to_path_buf()
}

fn ensure_resource_exists(path: &Path, label: &str) -> Result<(), io::Error> {
    if path.exists() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{label} is missing: {}", path.display()),
        ))
    }
}

fn firebase_config_value(runtime_key: &str, build_value: Option<&str>) -> Option<String> {
    env::var(runtime_key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| build_value.map(str::to_string).filter(|value| !value.trim().is_empty()))
}

fn firebase_mode_configured() -> bool {
    has_required_firebase_values(
        firebase_config_value("WONREMOTE_FIREBASE_API_KEY", FIREBASE_API_KEY),
        firebase_config_value("WONREMOTE_FIREBASE_AUTH_DOMAIN", FIREBASE_AUTH_DOMAIN),
        firebase_config_value("WONREMOTE_FIREBASE_PROJECT_ID", FIREBASE_PROJECT_ID),
        firebase_config_value("WONREMOTE_FIREBASE_APP_ID", FIREBASE_APP_ID),
    )
}

fn has_required_firebase_values(
    api_key: Option<String>,
    auth_domain: Option<String>,
    project_id: Option<String>,
    app_id: Option<String>,
) -> bool {
    api_key.is_some() && auth_domain.is_some() && project_id.is_some() && app_id.is_some()
}

fn apply_firebase_env(command: &mut Command) {
    let values = [
        (
            "WONREMOTE_FIREBASE_API_KEY",
            firebase_config_value("WONREMOTE_FIREBASE_API_KEY", FIREBASE_API_KEY),
        ),
        (
            "WONREMOTE_FIREBASE_AUTH_DOMAIN",
            firebase_config_value("WONREMOTE_FIREBASE_AUTH_DOMAIN", FIREBASE_AUTH_DOMAIN),
        ),
        (
            "WONREMOTE_FIREBASE_PROJECT_ID",
            firebase_config_value("WONREMOTE_FIREBASE_PROJECT_ID", FIREBASE_PROJECT_ID),
        ),
        (
            "WONREMOTE_FIREBASE_APP_ID",
            firebase_config_value("WONREMOTE_FIREBASE_APP_ID", FIREBASE_APP_ID),
        ),
        (
            "WONREMOTE_FIREBASE_STORAGE_BUCKET",
            firebase_config_value("WONREMOTE_FIREBASE_STORAGE_BUCKET", FIREBASE_STORAGE_BUCKET),
        ),
        (
            "WONREMOTE_FIREBASE_MESSAGING_SENDER_ID",
            firebase_config_value(
                "WONREMOTE_FIREBASE_MESSAGING_SENDER_ID",
                FIREBASE_MESSAGING_SENDER_ID,
            ),
        ),
    ];

    for (key, value) in values {
        if let Some(value) = value {
            command.env(key, value);
        }
    }
}

fn local_api_addr() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], LOCAL_API_PORT))
}

fn is_local_api_health_response(response: &str) -> bool {
    response.starts_with("HTTP/1.1 200") && response.contains("\"ok\":true")
}

fn is_local_api_healthy() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&local_api_addr(), Duration::from_millis(250))
    else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    let request =
        format!("GET /api/health HTTP/1.1\r\nHost: {LOCAL_API_HOST}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    is_local_api_health_response(&response)
}

fn wait_for_local_api_healthy(timeout: Duration) -> bool {
    let started_at = Instant::now();
    while started_at.elapsed() <= timeout {
        if is_local_api_healthy() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn start_dev_api_server_if_needed(job: &Job) -> Result<(), io::Error> {
    if is_local_api_healthy() {
        return Ok(());
    }

    let cwd = app_root_from_manifest();
    let mut server_cmd = Command::new("cmd");
    server_cmd.args(["/c", "npm run api"]);
    server_cmd.current_dir(&cwd);
    add_no_window(&mut server_cmd);
    spawn_managed(job, &mut server_cmd, "dev API server")?;

    if wait_for_local_api_healthy(Duration::from_secs(8)) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "dev API server did not become healthy on 127.0.0.1:8787",
        ))
    }
}

fn start_production_api_server_if_needed(job: &Job, resource_dir: &Path) -> Result<(), io::Error> {
    if is_local_api_healthy() {
        return Ok(());
    }

    let node_path = bundled_node_path(resource_dir);
    let server_path = resource_dir.join("server").join("index.mjs");

    ensure_resource_exists(&node_path, "bundled Node runtime")?;
    ensure_resource_exists(&server_path, "bundled API server")?;

    let mut server_cmd = Command::new(&node_path);
    server_cmd.arg(&server_path);
    server_cmd.env("WONREMOTE_API_PORT", LOCAL_API_PORT.to_string());
    server_cmd.env("NODE_ENV", "production");
    server_cmd.env("WONREMOTE_APP_DIR", resource_dir);
    add_no_window(&mut server_cmd);
    spawn_managed(job, &mut server_cmd, "production API server")?;

    if wait_for_local_api_healthy(Duration::from_secs(8)) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "production API server did not become healthy on 127.0.0.1:8787",
        ))
    }
}

fn start_local_api_server_for_mode(job: &Job, resource_dir: &Path) -> Result<(), io::Error> {
    if firebase_mode_configured() {
        return Ok(());
    }

    if cfg!(debug_assertions) {
        start_dev_api_server_if_needed(job)
    } else {
        start_production_api_server_if_needed(job, resource_dir)
    }
}

fn set_registry_value(
    path: &str,
    value_name: &str,
    value: Option<&str>,
) -> Result<(), std::io::Error> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    if let Some(value) = value {
        let (key, _) = hkcu.create_subkey(path)?;
        key.set_value(value_name, &value)?;
    } else {
        if let Ok(key) = hkcu.open_subkey_with_flags(path, KEY_WRITE) {
            let _ = key.delete_value(value_name);
        }
    }

    Ok(())
}

fn registry_value_exists(path: &str, value_name: &str) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey_with_flags(path, KEY_READ) {
        key.get_value::<String, _>(value_name).is_ok()
    } else {
        false
    }
}

fn format_startup_command(exe_path: &Path, is_agent: bool) -> String {
    if is_agent {
        format!("\"{}\" --agent", exe_path.to_string_lossy())
    } else {
        format!("\"{}\"", exe_path.to_string_lossy())
    }
}

fn startup_registry_value_name(is_agent: bool) -> &'static str {
    if is_agent {
        AGENT_REGISTRY_VALUE
    } else {
        STARTUP_REGISTRY_VALUE
    }
}

fn set_startup_registry(enable: bool, is_agent: bool) -> Result<(), std::io::Error> {
    let value_name = startup_registry_value_name(is_agent);
    if enable {
        let exe_path = std::env::current_exe()?;
        let exe_str = format_startup_command(&exe_path, is_agent);
        set_registry_value(STARTUP_REGISTRY_PATH, value_name, Some(&exe_str))
    } else {
        set_registry_value(STARTUP_REGISTRY_PATH, value_name, None)
    }
}

fn is_startup_registered(is_agent: bool) -> bool {
    let value_name = startup_registry_value_name(is_agent);
    registry_value_exists(STARTUP_REGISTRY_PATH, value_name)
}

fn start_dev_processes(job: &Job) -> Result<(), io::Error> {
    start_dev_api_server_if_needed(job)?;
    Ok(())
}

fn start_production_processes(job: &Job, resource_dir: &Path) -> Result<(), io::Error> {
    start_production_api_server_if_needed(job, resource_dir)?;
    Ok(())
}

pub fn run() {
    let is_agent = launched_as_agent();

    tauri::Builder::default()
        .manage(AgentState::new())
        .invoke_handler(tauri::generate_handler![
            get_app_mode,
            save_agent_config,
            get_agent_config,
            restart_agent_process
        ])
        .setup(move |app| {
            let job = Job::new()?;
            let agent_state = app.state::<AgentState>();

            if is_agent {
                // Agent Mode Setup
                let resource_dir = if cfg!(debug_assertions) {
                    app_root_from_manifest()
                } else {
                    app.path().resource_dir()?
                };

                start_local_api_server_for_mode(&job, &resource_dir)?;

                if is_agent_registered() {
                    // Read api_url from config
                    let mut api_url = None;
                    if let Some(config_path) = default_agent_config_path() {
                        if let Ok(content) = std::fs::read_to_string(&config_path) {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                                if let Some(url) = json.get("apiUrl").and_then(|v| v.as_str()) {
                                    api_url = Some(url.to_string());
                                }
                            }
                        }
                    }
                    spawn_agent_only_process(
                        app.handle().clone(),
                        &agent_state,
                        &job,
                        &resource_dir,
                        api_url.as_deref(),
                    )?;
                } else {
                    // Show window to register
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }

                // System Tray Menu Setup for Agent
                let status_i = MenuItemBuilder::new("Status: Connecting")
                    .id("status")
                    .enabled(false)
                    .build(app)?;
                {
                    let mut item_guard = agent_state.status_menu_item.lock().unwrap();
                    *item_guard = Some(status_i.clone());
                }
                let open_i = MenuItemBuilder::new("Open Status").id("open").build(app)?;
                let restart_i = MenuItemBuilder::new("Restart Agent")
                    .id("restart")
                    .build(app)?;
                let startup_i = CheckMenuItemBuilder::new("Run at Startup")
                    .id("toggle_startup")
                    .checked(is_startup_registered(true))
                    .build(app)?;
                let quit_i = MenuItemBuilder::new("Exit").id("quit").build(app)?;

                let menu = MenuBuilder::new(app)
                    .items(&[&status_i, &open_i, &restart_i, &startup_i, &quit_i])
                    .build()?;

                let startup_i_clone = startup_i.clone();

                if let Some(icon) = app.default_window_icon().cloned() {
                    let _tray = TrayIconBuilder::with_id("agent_tray")
                        .icon(icon)
                        .menu(&menu)
                        .on_menu_event(move |app, event| match event.id().as_ref() {
                            "quit" => {
                                app.exit(0);
                            }
                            "open" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            "restart" => {
                                let agent_state = app.state::<AgentState>();
                                let job = app.state::<Job>();
                                let resource_dir = if cfg!(debug_assertions) {
                                    app_root_from_manifest()
                                } else {
                                    app.path().resource_dir().unwrap()
                                };

                                if let Err(e) = start_local_api_server_for_mode(&job, &resource_dir)
                                {
                                    eprintln!("Failed to ensure local API server: {}", e);
                                    return;
                                }

                                let mut api_url = None;
                                if let Some(config_path) = default_agent_config_path() {
                                    if let Ok(content) = std::fs::read_to_string(&config_path) {
                                        if let Ok(json) =
                                            serde_json::from_str::<serde_json::Value>(&content)
                                        {
                                            if let Some(url) =
                                                json.get("apiUrl").and_then(|v| v.as_str())
                                            {
                                                api_url = Some(url.to_string());
                                            }
                                        }
                                    }
                                }
                                let _ = spawn_agent_only_process(
                                    app.clone(),
                                    &agent_state,
                                    &job,
                                    &resource_dir,
                                    api_url.as_deref(),
                                );
                            }
                            "toggle_startup" => {
                                let is_checked = startup_i_clone.is_checked().unwrap_or(false);
                                let next_checked = !is_checked;
                                if let Err(e) = set_startup_registry(next_checked, true) {
                                    eprintln!("Failed to set startup registry: {}", e);
                                    return;
                                }
                                if let Err(e) = startup_i_clone.set_checked(next_checked) {
                                    eprintln!("Failed to set menu checked: {}", e);
                                }
                            }
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                let app = tray.app_handle();
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        })
                        .build(app)?;
                }
            } else {
                // Viewer Mode Setup
                if cfg!(debug_assertions) {
                    start_dev_processes(&job)?;
                } else {
                    let resource_dir = app.path().resource_dir()?;
                    start_production_processes(&job, &resource_dir)?;
                }

                // Show window for Viewer
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                // System Tray Menu Setup for Viewer
                let quit_i = MenuItemBuilder::new("Exit").id("quit").build(app)?;
                let open_i = MenuItemBuilder::new("Open Viewer").id("open").build(app)?;
                let startup_i = CheckMenuItemBuilder::new("Run at Startup")
                    .id("toggle_startup")
                    .checked(is_startup_registered(false))
                    .build(app)?;

                let menu = MenuBuilder::new(app)
                    .items(&[&open_i, &startup_i, &quit_i])
                    .build()?;

                let startup_i_clone = startup_i.clone();

                if let Some(icon) = app.default_window_icon().cloned() {
                    let _tray = TrayIconBuilder::new()
                        .icon(icon)
                        .menu(&menu)
                        .on_menu_event(move |app, event| match event.id().as_ref() {
                            "quit" => {
                                app.exit(0);
                            }
                            "open" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            "toggle_startup" => {
                                let is_checked = startup_i_clone.is_checked().unwrap_or(false);
                                let next_checked = !is_checked;
                                if let Err(e) = set_startup_registry(next_checked, false) {
                                    eprintln!("Failed to set startup registry: {}", e);
                                    return;
                                }
                                if let Err(e) = startup_i_clone.set_checked(next_checked) {
                                    eprintln!("Failed to set menu checked: {}", e);
                                }
                            }
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                let app = tray.app_handle();
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        })
                        .build(app)?;
                }
            }

            app.manage(job);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run WonRemote Viewer desktop shell");
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    #[test]
    fn test_registry_toggle_uses_isolated_test_key() {
        let test_value_name = format!("WonRemoteViewerTest{}", std::process::id());
        let test_path = r"Software\WonRemote\Tests\Run";

        let _ = set_registry_value(test_path, &test_value_name, None);
        assert!(!registry_value_exists(test_path, &test_value_name));

        set_registry_value(
            test_path,
            &test_value_name,
            Some(r#""C:\WonRemote\viewer.exe""#),
        )
        .expect("failed to set isolated registry value");
        assert!(registry_value_exists(test_path, &test_value_name));

        set_registry_value(test_path, &test_value_name, None)
            .expect("failed to clear isolated registry value");
        assert!(!registry_value_exists(test_path, &test_value_name));
    }

    #[test]
    fn test_startup_registry_toggle_agent_uses_isolated_test_key() {
        let test_value_name = format!("WonRemoteAgentTest{}", std::process::id());
        let test_path = r"Software\WonRemote\Tests\Run";

        let _ = set_registry_value(test_path, &test_value_name, None);
        assert!(!registry_value_exists(test_path, &test_value_name));

        set_registry_value(
            test_path,
            &test_value_name,
            Some(r#""C:\WonRemote\viewer.exe" --agent"#),
        )
        .expect("failed to set isolated agent registry value");
        assert!(registry_value_exists(test_path, &test_value_name));

        set_registry_value(test_path, &test_value_name, None)
            .expect("failed to clear isolated agent registry value");
        assert!(!registry_value_exists(test_path, &test_value_name));
    }

    #[test]
    fn test_startup_command_formats_viewer_and_agent_modes() {
        let exe_path = PathBuf::from(r"C:\Program Files\WonRemote\wonremote-viewer.exe");

        assert_eq!(
            format_startup_command(&exe_path, false),
            r#""C:\Program Files\WonRemote\wonremote-viewer.exe""#,
        );
        assert_eq!(
            format_startup_command(&exe_path, true),
            r#""C:\Program Files\WonRemote\wonremote-viewer.exe" --agent"#,
        );
    }

    #[test]
    fn test_agent_exe_name_enters_agent_mode() {
        assert!(executable_stem_requests_agent("WonRemote Agent"));
        assert!(executable_stem_requests_agent("wonremote-agent"));
        assert!(!executable_stem_requests_agent("WonRemote Viewer"));
    }

    #[test]
    fn test_local_api_health_response_requires_ok_payload() {
        assert!(is_local_api_health_response(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}"
        ));
        assert!(!is_local_api_health_response(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nnot-aether-link"
        ));
        assert!(!is_local_api_health_response(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}"
        ));
    }

    #[test]
    fn test_firebase_mode_requires_required_config_values() {
        assert!(has_required_firebase_values(
            Some("api-key".to_string()),
            Some("project.firebaseapp.com".to_string()),
            Some("project-id".to_string()),
            Some("app-id".to_string()),
        ));
        assert!(!has_required_firebase_values(
            Some("api-key".to_string()),
            Some("project.firebaseapp.com".to_string()),
            Some("project-id".to_string()),
            None,
        ));
    }

    #[test]
    fn test_config_registration_requires_registered_device_id() {
        let config_path = std::env::temp_dir().join(format!(
            "wonremote-empty-config-{}.json",
            std::process::id()
        ));
        std::fs::write(&config_path, r#"{"installId":"agent-test"}"#)
            .expect("failed to write temp config");

        assert!(!config_has_registered_device_id(&config_path));

        let _ = std::fs::remove_file(config_path);
    }

    #[test]
    fn test_config_registration_accepts_valid_registered_device_id() {
        let config_path = std::env::temp_dir().join(format!(
            "wonremote-valid-config-{}.json",
            std::process::id()
        ));
        std::fs::write(
            &config_path,
            r#"{"installId":"agent-test","registeredDeviceId":"123-45-67890:AGENT-TEST"}"#,
        )
        .expect("failed to write temp config");

        assert!(config_has_registered_device_id(&config_path));

        let _ = std::fs::remove_file(config_path);
    }
}
