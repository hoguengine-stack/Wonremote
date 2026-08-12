use std::ffi::OsStr;
use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
use std::{
    env, io, mem,
    net::{SocketAddr, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    process::Command,
    ptr, thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Once,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
#[cfg(target_arch = "x86")]
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::CreateMutexW;
#[cfg(target_arch = "x86")]
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
};
#[cfg(target_arch = "x86")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, LoadIconW, LoadImageW,
    RegisterClassW, HICON, IDI_APPLICATION, IMAGE_ICON, LR_DEFAULTSIZE, LR_LOADFROMFILE, WM_APP,
    WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_RBUTTONDBLCLK, WM_RBUTTONUP, WNDCLASSW, WS_EX_TOOLWINDOW,
    WS_OVERLAPPED,
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
const DEFAULT_APP_MODE: Option<&str> = option_env!("WONREMOTE_DEFAULT_APP_MODE");
const PUBLIC_FIREBASE_API_KEY: &str = "AIzaSyDb1Ihymmrt1SSYvbOAB2NjRV9PiWMY2y8";
const PUBLIC_FIREBASE_AUTH_DOMAIN: &str = "wonremote-a7fd3.firebaseapp.com";
const PUBLIC_FIREBASE_PROJECT_ID: &str = "wonremote-a7fd3";
const PUBLIC_FIREBASE_APP_ID: &str = "1:52940136204:web:b4b4ff3e57c215e5dc3329";
const PUBLIC_FIREBASE_STORAGE_BUCKET: &str = "wonremote-a7fd3.appspot.com";
const PUBLIC_FIREBASE_MESSAGING_SENDER_ID: &str = "52940136204";
const PORTABLE_MARKER_FILENAME: &str = "wonremote-portable.json";
const UPDATE_HANDOFF_PREFIX: &str = "[WonRemoteUpdateHandoff]";
const UPDATE_CHECK_PREFIX: &str = "[WonRemoteUpdateCheck]";
const VIEWER_UPDATE_INITIAL_DELAY: Duration = Duration::from_secs(3);
const VIEWER_UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(15 * 60);
#[cfg(target_arch = "x86")]
const WIN32_AGENT_TRAY_ID: u32 = 37;
#[cfg(target_arch = "x86")]
const WM_WONREMOTE_AGENT_TRAY: u32 = WM_APP + 37;
static PANIC_LOGGER: Once = Once::new();
static VIEWER_UPDATE_CHECK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static VIEWER_RESTART_AFTER_CHECK_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(serde::Deserialize, serde::Serialize)]
struct ViewerUpdateCheck {
    available: bool,
    #[serde(rename = "latestVersion")]
    latest_version: String,
}

struct NodeResourcePaths {
    root: PathBuf,
    node: PathBuf,
    agent: PathBuf,
    server: PathBuf,
    poc: PathBuf,
}

struct SingleInstanceGuard {
    handle: HANDLE,
}

unsafe impl Send for SingleInstanceGuard {}
unsafe impl Sync for SingleInstanceGuard {}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

pub struct Job {
    handle: HANDLE,
}

unsafe impl Send for Job {}
unsafe impl Sync for Job {}

#[cfg(target_arch = "x86")]
pub struct Win32AgentTray {
    hwnd: HWND,
    icon: HICON,
}

#[cfg(target_arch = "x86")]
unsafe impl Send for Win32AgentTray {}
#[cfg(target_arch = "x86")]
unsafe impl Sync for Win32AgentTray {}

#[cfg(target_arch = "x86")]
impl Drop for Win32AgentTray {
    fn drop(&mut self) {
        unsafe {
            let mut notify_data: NOTIFYICONDATAW = mem::zeroed();
            notify_data.cbSize = mem::size_of::<NOTIFYICONDATAW>() as u32;
            notify_data.hWnd = self.hwnd;
            notify_data.uID = WIN32_AGENT_TRAY_ID;
            let _ = Shell_NotifyIconW(NIM_DELETE, &notify_data as *const _);
            if !self.icon.is_null() {
                let _ = DestroyIcon(self.icon);
            }
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

impl Job {
    pub fn new() -> Result<Self, std::io::Error> {
        unsafe {
            let handle = CreateJobObjectW(ptr::null(), ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;

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
            CloseHandle(self.handle);
        }
    }
}

fn single_instance_mutex_name(is_agent: bool) -> &'static str {
    if is_agent {
        r"Local\WonRemote.Agent.SingleInstance"
    } else {
        r"Local\WonRemote.Viewer.SingleInstance"
    }
}

#[cfg(not(target_arch = "x86"))]
fn agent_tray_enabled() -> bool {
    true
}

#[cfg(target_arch = "x86")]
fn agent_tray_enabled() -> bool {
    false
}

fn to_wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn try_acquire_single_instance(is_agent: bool) -> Result<Option<SingleInstanceGuard>, io::Error> {
    try_acquire_single_instance_named(single_instance_mutex_name(is_agent))
}

fn try_acquire_single_instance_named(name: &str) -> Result<Option<SingleInstanceGuard>, io::Error> {
    let name_w = to_wide_null(name);
    unsafe {
        let handle = CreateMutexW(ptr::null_mut(), 0, name_w.as_ptr());
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }

        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            Ok(None)
        } else {
            Ok(Some(SingleInstanceGuard { handle }))
        }
    }
}

pub struct AgentState {
    pub child_process: Arc<Mutex<Option<std::process::Child>>>,
    pub status: Arc<Mutex<String>>,
    pub status_menu_item: Arc<Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>>,
    #[cfg(target_arch = "x86")]
    win32_tray: Arc<Mutex<Option<Win32AgentTray>>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            child_process: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new("Offline".to_string())),
            status_menu_item: Arc::new(Mutex::new(None)),
            #[cfg(target_arch = "x86")]
            win32_tray: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for AgentState {
    fn default() -> Self {
        Self::new()
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
    let Ok(json) = parse_json_config(&content) else {
        return false;
    };

    json.get("registeredDeviceId")
        .and_then(|v| v.as_str())
        .is_some_and(|device_id| !device_id.trim().is_empty())
}

fn parse_json_config(content: &str) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::from_str(content.trim_start_matches('\u{feff}'))
}

fn runtime_log_file_from_appdata(appdata: &Path) -> PathBuf {
    appdata
        .join("WonRemote")
        .join("logs")
        .join("wonremote-tauri.log")
}

fn agent_install_id_file_from_appdata(appdata: &Path) -> PathBuf {
    appdata.join("WonRemote").join("agent-install-id")
}

fn normalize_agent_install_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return None;
    }
    Some(value.to_string())
}

fn load_or_create_agent_install_id(
    identity_path: &Path,
    config_path: Option<&Path>,
    legacy_install_id: &str,
) -> Result<String, String> {
    if let Ok(existing) = std::fs::read_to_string(identity_path) {
        if let Some(install_id) = normalize_agent_install_id(&existing) {
            return Ok(install_id);
        }
    }

    let config_install_id = config_path
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| parse_json_config(&content).ok())
        .and_then(|json| {
            json.get("installId")
                .and_then(|value| value.as_str())
                .and_then(normalize_agent_install_id)
        });
    let install_id = config_install_id
        .or_else(|| normalize_agent_install_id(legacy_install_id))
        .ok_or_else(|| "Agent install id is invalid.".to_string())?;

    if let Some(parent) = identity_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(identity_path, &install_id).map_err(|error| error.to_string())?;
    Ok(install_id)
}

fn agent_show_window_request_file_from_appdata(appdata: &Path) -> PathBuf {
    appdata.join("WonRemote").join("agent-show-window.request")
}

fn runtime_log_path() -> Option<PathBuf> {
    env::var_os("APPDATA").map(|appdata| runtime_log_file_from_appdata(&PathBuf::from(appdata)))
}

fn agent_show_window_request_path() -> Option<PathBuf> {
    env::var_os("APPDATA")
        .map(|appdata| agent_show_window_request_file_from_appdata(&PathBuf::from(appdata)))
}

fn request_existing_agent_window() -> io::Result<()> {
    if let Some(path) = agent_show_window_request_path() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, runtime_log_timestamp())?;
    }
    Ok(())
}

fn consume_agent_show_window_request() -> bool {
    let Some(path) = agent_show_window_request_path() else {
        return false;
    };
    if !path.exists() {
        return false;
    }
    std::fs::remove_file(path).is_ok()
}

fn start_agent_show_window_request_watcher(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        if consume_agent_show_window_request() {
            show_main_window_with_log(&app, "agent-show-window-request");
        }
    });
}

#[cfg(target_arch = "x86")]
fn tray_tooltip(tooltip: &str) -> [u16; 128] {
    let mut destination = [0u16; 128];
    let wide = to_wide_null(tooltip);
    let copy_len = wide.len().min(destination.len());
    destination[..copy_len].copy_from_slice(&wide[..copy_len]);
    destination
}

#[cfg(target_arch = "x86")]
fn win32_agent_tray_class_name() -> Vec<u16> {
    to_wide_null("WonRemoteAgentWin32Tray")
}

#[cfg(target_arch = "x86")]
fn start_win32_agent_tray(icon_path: &Path) -> io::Result<Win32AgentTray> {
    unsafe {
        let class_name = win32_agent_tray_class_name();
        let wnd_class = WNDCLASSW {
            lpfnWndProc: Some(win32_agent_tray_proc),
            lpszClassName: class_name.as_ptr(),
            ..mem::zeroed()
        };

        RegisterClassW(&wnd_class);

        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            ptr::null(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        );
        if hwnd.is_null() {
            return Err(io::Error::last_os_error());
        }

        let mut notify_data: NOTIFYICONDATAW = mem::zeroed();
        notify_data.cbSize = mem::size_of::<NOTIFYICONDATAW>() as u32;
        notify_data.hWnd = hwnd;
        notify_data.uID = WIN32_AGENT_TRAY_ID;
        notify_data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        notify_data.uCallbackMessage = WM_WONREMOTE_AGENT_TRAY;
        let icon_path_wide: Vec<u16> = icon_path.as_os_str().encode_wide().chain(Some(0)).collect();
        let loaded_icon = LoadImageW(
            ptr::null_mut(),
            icon_path_wide.as_ptr(),
            IMAGE_ICON,
            0,
            0,
            LR_DEFAULTSIZE | LR_LOADFROMFILE,
        ) as HICON;
        let icon = if loaded_icon.is_null() {
            append_runtime_log(
                "tray",
                &format!(
                    "agent icon load failed path={} error={}",
                    icon_path.display(),
                    io::Error::last_os_error()
                ),
            );
            LoadIconW(ptr::null_mut(), IDI_APPLICATION)
        } else {
            loaded_icon
        };
        notify_data.hIcon = icon;
        notify_data.szTip = tray_tooltip("WonRemote Agent");

        if Shell_NotifyIconW(NIM_ADD, &notify_data as *const _) == 0 {
            let error = io::Error::last_os_error();
            if !loaded_icon.is_null() {
                let _ = DestroyIcon(loaded_icon);
            }
            DestroyWindow(hwnd);
            return Err(error);
        }

        append_runtime_log("tray", "agent x86 Win32 shell tray registered");
        Ok(Win32AgentTray {
            hwnd,
            icon: loaded_icon,
        })
    }
}

#[cfg(target_arch = "x86")]
unsafe extern "system" fn win32_agent_tray_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_WONREMOTE_AGENT_TRAY {
        match lparam as u32 {
            WM_LBUTTONUP | WM_LBUTTONDBLCLK | WM_RBUTTONUP | WM_RBUTTONDBLCLK => {
                let _ = std::panic::catch_unwind(|| {
                    append_runtime_log("tray", "agent x86 Win32 tray open requested");
                    if let Err(error) = request_existing_agent_window() {
                        append_runtime_log(
                            "tray",
                            &format!("agent x86 Win32 tray open request failed: {error}"),
                        );
                    }
                });
                return 0;
            }
            _ => return 0,
        }
    }

    DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[cfg(target_arch = "x86")]
fn start_arch_specific_agent_tray(app: &tauri::App, agent_state: &tauri::State<'_, AgentState>) {
    append_runtime_log("tray", "agent x86 Win32 tray starting");
    let icon_path = if cfg!(debug_assertions) {
        app_root_from_manifest()
            .join("src-tauri")
            .join("icons")
            .join("agent.ico")
    } else {
        match app.path().resource_dir() {
            Ok(resource_dir) => resource_dir.join("icons").join("agent.ico"),
            Err(error) => {
                append_runtime_log(
                    "tray",
                    &format!("agent resource directory unavailable: {error}"),
                );
                show_main_window_with_log(app.handle(), "agent-icon-resource-failed");
                return;
            }
        }
    };
    match start_win32_agent_tray(&icon_path) {
        Ok(tray) => {
            let mut tray_guard = agent_state.win32_tray.lock().unwrap();
            *tray_guard = Some(tray);
        }
        Err(error) => {
            append_runtime_log("tray", &format!("agent x86 Win32 tray failed: {error}"));
            show_main_window_with_log(app.handle(), "agent-win32-tray-failed");
        }
    }
}

#[cfg(not(target_arch = "x86"))]
fn start_arch_specific_agent_tray(_app: &tauri::App, _agent_state: &tauri::State<'_, AgentState>) {}

fn append_runtime_log_entry(log_path: &Path, component: &str, message: &str) -> io::Result<()> {
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    let sanitized_message = message.replace(['\r', '\n'], " ");
    writeln!(
        file,
        "{} [{}] {}",
        runtime_log_timestamp(),
        component,
        sanitized_message
    )
}

fn append_runtime_log(component: &str, message: &str) {
    if let Some(log_path) = runtime_log_path() {
        let _ = append_runtime_log_entry(&log_path, component, message);
    }
}

fn runtime_log_timestamp() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("epoch_ms={}", duration.as_millis()),
        Err(_) => "epoch_ms=unknown".to_string(),
    }
}

fn panic_payload_to_string(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = if let Some(value) = info.payload().downcast_ref::<&str>() {
        (*value).to_string()
    } else if let Some(value) = info.payload().downcast_ref::<String>() {
        value.clone()
    } else {
        "non-string panic payload".to_string()
    };
    let location = info
        .location()
        .map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        })
        .unwrap_or_else(|| "unknown location".to_string());

    format!("panic at {location}: {payload}")
}

fn install_panic_logger() {
    PANIC_LOGGER.call_once(|| {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            append_runtime_log("panic", &panic_payload_to_string(info));
            default_hook(info);
        }));
    });
}

fn run_logged_action<F>(component: &str, action: &str, operation: F)
where
    F: FnOnce(),
{
    append_runtime_log(component, &format!("{action}: start"));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation));
    if result.is_err() {
        append_runtime_log(component, &format!("{action}: panic caught"));
    } else {
        append_runtime_log(component, &format!("{action}: done"));
    }
}

fn show_main_window_with_log(app: &tauri::AppHandle, reason: &str) {
    append_runtime_log("window", &format!("{reason}: show requested"));
    let Some(window) = app.get_webview_window("main") else {
        append_runtime_log("window", &format!("{reason}: main window not found"));
        return;
    };

    match window.show() {
        Ok(_) => append_runtime_log("window", &format!("{reason}: show ok")),
        Err(error) => append_runtime_log("window", &format!("{reason}: show failed: {error}")),
    }
    match window.set_focus() {
        Ok(_) => append_runtime_log("window", &format!("{reason}: focus ok")),
        Err(error) => append_runtime_log("window", &format!("{reason}: focus failed: {error}")),
    }
}

fn spawn_agent_only_process(
    app_handle: tauri::AppHandle,
    agent_state: &AgentState,
    job: &Job,
    resource_dir: &Path,
    api_url: Option<&str>,
) -> Result<(), io::Error> {
    append_runtime_log(
        "agent-process",
        &format!(
            "spawn requested resource_dir={} api_url={}",
            resource_dir.display(),
            api_url.unwrap_or("http://127.0.0.1:8787")
        ),
    );
    {
        let mut child_guard = agent_state.child_process.lock().unwrap();
        if let Some(mut child) = child_guard.take() {
            append_runtime_log(
                "agent-process",
                "stopping existing agent child before restart",
            );
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
        let resources = node_resource_paths(resource_dir);
        append_runtime_log(
            "agent-process",
            &format!(
                "production resources node={} agent={} poc={}",
                resources.node.display(),
                resources.agent.display(),
                resources.poc.display()
            ),
        );

        ensure_resource_exists(&resources.node, "bundled Node runtime")?;
        ensure_resource_exists(&resources.agent, "bundled Agent")?;
        ensure_resource_exists(&resources.poc, "bundled Rust PoC")?;

        let mut cmd = Command::new(&resources.node);
        cmd.arg(&resources.agent);
        cmd.arg("--watch");
        cmd.env("WONREMOTE_POC_PATH", &resources.poc);
        cmd.env("WONREMOTE_APP_DIR", &resources.root);
        cmd.env("NODE_ENV", "production");
        cmd
    };

    command.env("WONREMOTE_BUILD_ARCH", runtime_build_arch());
    command.env("WONREMOTE_PACKAGE_KIND", packaged_update_kind(resource_dir));
    command.env("WONREMOTE_UPDATE_PRODUCT", "agent");
    command.env("WONREMOTE_TAURI_UPDATE_BROKER", "1");
    if let Ok(host_exe_path) = env::current_exe() {
        command.env("WONREMOTE_HOST_EXE_PATH", node_compatible_path(&host_exe_path));
    }
    if let Some(url) = api_url {
        command.env("WONREMOTE_API_URL", url);
    } else {
        command.env("WONREMOTE_API_URL", "http://127.0.0.1:8787");
    }
    apply_firebase_env(&mut command);

    add_no_window(&mut command);

    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    append_runtime_log("agent-process", "spawning agent child");
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            append_runtime_log("agent-process", &format!("spawn failed: {error}"));
            return Err(error);
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        append_runtime_log(
            "agent-process",
            &format!("job assign failed; child terminated: {error}"),
        );
        return Err(io::Error::new(
            error.kind(),
            format!("failed to assign Agent child to cleanup job: {error}"),
        ));
    }

    {
        let mut child_guard = agent_state.child_process.lock().unwrap();
        *child_guard = Some(child);
    }

    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line_str) => {
                        eprintln!("[Agent Error] {}", line_str);
                        append_runtime_log("agent-stderr", &line_str);
                    }
                    Err(error) => {
                        append_runtime_log("agent-stderr", &format!("read failed: {error}"));
                        break;
                    }
                }
            }
            append_runtime_log("agent-stderr", "reader ended");
        });
    } else {
        append_runtime_log("agent-stderr", "stderr pipe unavailable");
    }

    if let Some(stdout) = stdout {
        let status_clone = agent_state.status.clone();
        let status_menu_item_clone = agent_state.status_menu_item.clone();
        let app_handle_clone = app_handle.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut unregistered_detected = false;
            let mut update_handoff_started = false;
            for line in reader.lines() {
                let line_str = match line {
                    Ok(value) => value,
                    Err(error) => {
                        append_runtime_log("agent-stdout", &format!("read failed: {error}"));
                        break;
                    }
                };
                println!("[Agent Output] {}", line_str);
                append_runtime_log("agent-stdout", &line_str);
                if !update_handoff_started {
                    match parse_update_handoff_request(&line_str).and_then(|request| {
                        request.map_or(Ok(false), launch_brokered_update_handoff)
                    }) {
                        Ok(true) => update_handoff_started = true,
                        Ok(false) => {}
                        Err(error) => append_runtime_log("updater-broker", &error),
                    }
                }
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
            append_runtime_log("agent-stdout", "reader ended");
            if unregistered_detected {
                show_main_window_with_log(&app_handle_clone, "agent-unregistered");
            }
        });
    } else {
        append_runtime_log("agent-stdout", "stdout pipe unavailable");
    }

    Ok(())
}

fn parse_update_handoff_request(line: &str) -> Result<Option<PathBuf>, String> {
    let Some(encoded) = line.strip_prefix(UPDATE_HANDOFF_PREFIX) else {
        return Ok(None);
    };
    if encoded.is_empty() || encoded.len() > 16_384 {
        return Err("Rejected malformed Agent update handoff request.".to_string());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Rejected invalid Agent update handoff encoding.".to_string())?;
    let script_path = String::from_utf8(decoded)
        .map_err(|_| "Rejected non-UTF8 Agent update handoff path.".to_string())?;
    if script_path.contains('\0') {
        return Err("Rejected Agent update handoff path containing NUL.".to_string());
    }
    Ok(Some(PathBuf::from(script_path)))
}

fn validate_update_handoff_script_path(script_path: &Path) -> Result<PathBuf, String> {
    let updates_root = default_agent_config_path()
        .and_then(|path| path.parent().map(|parent| parent.join("updates")))
        .ok_or_else(|| "Agent update directory is unavailable.".to_string())?;
    validate_update_handoff_script_path_in_root(script_path, &updates_root)
}

fn validate_update_handoff_script_path_in_root(
    script_path: &Path,
    updates_root: &Path,
) -> Result<PathBuf, String> {
    if !script_path.is_absolute() || script_path.extension() != Some(OsStr::new("ps1")) {
        return Err(
            "Rejected non-absolute or non-PowerShell Agent update handoff path.".to_string(),
        );
    }
    let file_name = script_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| {
            "Rejected Agent update handoff path without a valid filename.".to_string()
        })?;
    if !(file_name.starts_with("run-installer-update-")
        || file_name.starts_with("run-portable-update-"))
    {
        return Err(
            "Rejected Agent update handoff script with an unexpected filename.".to_string(),
        );
    }

    let canonical_root = std::fs::canonicalize(updates_root)
        .map_err(|error| format!("Agent update directory is unavailable: {error}"))?;
    let canonical_script = std::fs::canonicalize(script_path)
        .map_err(|error| format!("Agent update handoff script is unavailable: {error}"))?;
    if canonical_script.parent() != Some(canonical_root.as_path()) {
        return Err(
            "Rejected Agent update handoff script outside the update directory.".to_string(),
        );
    }
    Ok(canonical_script)
}

fn launch_brokered_update_handoff(script_path: PathBuf) -> Result<bool, String> {
    let script_path = validate_update_handoff_script_path(&script_path)?;
    let mut command = Command::new("powershell.exe");
    command
        .args(brokered_update_powershell_args())
        .arg(&script_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    add_no_window(&mut command);
    command
        .spawn()
        .map_err(|error| format!("Agent update broker failed to start PowerShell: {error}"))?;
    append_runtime_log(
        "updater-broker",
        &format!("started verified handoff script={}", script_path.display()),
    );
    Ok(true)
}

fn brokered_update_powershell_args() -> [&'static str; 7] {
    [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]
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

    if let Err(error) = set_startup_registry(true, true) {
        append_runtime_log(
            "agent-registration",
            &format!("startup registry update failed after config save: {error}"),
        );
    }

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
                if let Ok(json) = parse_json_config(&content) {
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
    let json = parse_json_config(&content).ok()?;
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

#[tauri::command]
fn get_or_create_agent_install_id(legacy_install_id: String) -> Result<String, String> {
    let appdata = env::var_os("APPDATA").ok_or_else(|| "APPDATA is unavailable.".to_string())?;
    let identity_path = agent_install_id_file_from_appdata(&PathBuf::from(appdata));
    let config_path = default_agent_config_path();
    load_or_create_agent_install_id(&identity_path, config_path.as_deref(), &legacy_install_id)
}

#[tauri::command]
fn wake_device(
    mac_address: String,
    broadcast: Option<String>,
    port: Option<u16>,
) -> Result<(), String> {
    let packet = build_magic_packet(&mac_address)?;
    let broadcast_addr = broadcast.unwrap_or_else(|| "255.255.255.255".to_string());
    let target = format!("{}:{}", broadcast_addr, port.unwrap_or(9));
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    socket
        .send_to(&packet, target)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn build_magic_packet(mac_address: &str) -> Result<[u8; 102], String> {
    let mac = parse_mac_address(mac_address)?;
    let mut packet = [0xff_u8; 102];
    for chunk in packet[6..].chunks_exact_mut(6) {
        chunk.copy_from_slice(&mac);
    }
    Ok(packet)
}

fn parse_mac_address(mac_address: &str) -> Result<[u8; 6], String> {
    let hex: String = mac_address
        .chars()
        .filter(|ch| *ch != ':' && *ch != '-' && *ch != '.')
        .collect();
    if hex.len() != 12 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Invalid MAC address.".to_string());
    }

    let mut bytes = [0_u8; 6];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let start = index * 2;
        *byte = u8::from_str_radix(&hex[start..start + 2], 16)
            .map_err(|_| "Invalid MAC address.".to_string())?;
    }
    Ok(bytes)
}

fn add_no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn spawn_managed(job: &Job, command: &mut Command, label: &str) -> Result<(), io::Error> {
    append_runtime_log("process", &format!("spawning {label}"));
    let mut child = command.spawn().map_err(|err| {
        append_runtime_log("process", &format!("failed to spawn {label}: {err}"));
        io::Error::new(err.kind(), format!("failed to spawn {label}: {err}"))
    })?;

    if let Err(err) = job.assign(&child) {
        let _ = child.kill();
        append_runtime_log(
            "process",
            &format!("failed to assign {label} to cleanup job: {err}"),
        );
        return Err(io::Error::new(
            err.kind(),
            format!("failed to assign {label} to cleanup job: {err}"),
        ));
    }

    append_runtime_log("process", &format!("{label} spawned and assigned"));
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
        || default_mode_requests_agent()
        || executable_name_requests_agent()
}

fn agent_launch_should_show_window(is_agent: bool) -> bool {
    let args: Vec<String> = std::env::args().collect();
    agent_launch_should_show_window_from_args(is_agent, &args)
}

fn args_request_background_agent(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--agent")
}

fn agent_launch_should_show_window_from_args(is_agent: bool, args: &[String]) -> bool {
    is_agent && (args_request_show_window(args) || !args_request_background_agent(args))
}

fn args_request_show_window(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.to_ascii_lowercase().as_str(),
            "--show-window" | "--open" | "--register"
        )
    })
}

fn default_mode_requests_agent() -> bool {
    mode_value_requests_agent(DEFAULT_APP_MODE)
        || env::var("WONREMOTE_DEFAULT_APP_MODE")
            .ok()
            .is_some_and(|mode| mode_value_requests_agent(Some(&mode)))
}

fn mode_value_requests_agent(mode: Option<&str>) -> bool {
    mode.is_some_and(|value| value.eq_ignore_ascii_case("agent"))
}

fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("runtime").join("node.exe")
}

fn bundled_agent_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("agent").join("index.mjs")
}

fn node_resource_paths(resource_dir: &Path) -> NodeResourcePaths {
    let root = node_compatible_path(resource_dir);
    NodeResourcePaths {
        node: bundled_node_path(&root),
        agent: bundled_agent_path(&root),
        server: root.join("server").join("index.mjs"),
        poc: root.join("bin").join("wonremote-poc.exe"),
        root,
    }
}

fn node_compatible_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(unc_path) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc_path}"));
    }
    if let Some(drive_path) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(drive_path);
    }
    path.to_path_buf()
}

fn runtime_build_arch() -> &'static str {
    if env::consts::ARCH == "x86" {
        "x86"
    } else {
        "x64"
    }
}

fn packaged_update_kind(resource_dir: &Path) -> &'static str {
    let marker_path = resource_dir.join(PORTABLE_MARKER_FILENAME);
    if let Ok(serialized) = std::fs::read_to_string(marker_path) {
        if let Ok(marker) = serde_json::from_str::<serde_json::Value>(&serialized) {
            if marker.get("schemaVersion").and_then(|value| value.as_u64()) == Some(1) {
                match marker.get("packageKind").and_then(|value| value.as_str()) {
                    Some("portable") => return "portable",
                    Some("portable-agent") => return "portable-agent",
                    _ => {}
                }
            }
        }
    }

    // v0.1.39 and earlier portable archives did not contain a marker. Their stable
    // executable names are not installed by NSIS, so this safely migrates them.
    let has_portable_agent = resource_dir.join("WonRemote Agent.exe").is_file();
    if has_portable_agent && resource_dir.join("WonRemote Viewer.exe").is_file() {
        return "portable";
    }
    if has_portable_agent {
        return "portable-agent";
    }
    "installer"
}

fn normalize_installer_restart_mode(restart_mode: &str) -> Result<&str, String> {
    match restart_mode {
        "viewer" | "agent" => Ok(restart_mode),
        _ => Err("Installer restart mode must be viewer or agent.".to_string()),
    }
}

fn schedule_viewer_restart(executable: &Path) -> Result<(), String> {
    let executable = executable
        .to_string_lossy()
        .replace('\'', "''");
    let script = format!(
        "Start-Sleep -Milliseconds 750; Start-Process -FilePath '{executable}'"
    );
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command"])
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    add_no_window(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to schedule Viewer restart: {error}"))
}

#[tauri::command]
fn start_installer_update(
    app: tauri::AppHandle,
    restart_mode: String,
    restart_after_check: Option<bool>,
) -> Result<(), String> {
    let restart_mode = normalize_installer_restart_mode(&restart_mode)?;
    let resources = node_resource_paths(&app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?);

    ensure_resource_exists(&resources.node, "bundled Node runtime")
        .map_err(|error| error.to_string())?;
    ensure_resource_exists(&resources.agent, "bundled updater").map_err(|error| error.to_string())?;

    let build_arch = runtime_build_arch();
    let package_kind = packaged_update_kind(&resources.root);
    let restart_executable = node_compatible_path(&env::current_exe().map_err(|error| error.to_string())?);
    let is_viewer_update = restart_mode == "viewer";
    if is_viewer_update && restart_after_check.unwrap_or(false) {
        VIEWER_RESTART_AFTER_CHECK_REQUESTED.store(true, Ordering::Release);
    }
    if is_viewer_update && VIEWER_UPDATE_CHECK_IN_FLIGHT.swap(true, Ordering::AcqRel) {
        append_runtime_log("viewer-native-update", "signed update check already running");
        return Ok(());
    }
    let mut command = Command::new(&resources.node);
    command
        .arg(&resources.agent)
        .args(["--update-once", "--restart-mode", restart_mode])
        .arg("--restart-executable")
        .arg(&restart_executable)
        .env("NODE_ENV", "production")
        .env("WONREMOTE_APP_DIR", &resources.root)
        .env("WONREMOTE_BUILD_ARCH", build_arch)
        .env("WONREMOTE_PACKAGE_KIND", package_kind)
        .env("WONREMOTE_UPDATE_PRODUCT", restart_mode)
        .env("WONREMOTE_TAURI_UPDATE_BROKER", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    add_no_window(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if is_viewer_update {
                VIEWER_UPDATE_CHECK_IN_FLIGHT.store(false, Ordering::Release);
            }
            append_runtime_log("updater", &format!("spawn failed: {error}"));
            return Err(error.to_string());
        }
    };
    let update_handoff_started = Arc::new(AtomicBool::new(false));
    if let Some(stdout) = child.stdout.take() {
        let update_handoff_started = Arc::clone(&update_handoff_started);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        append_runtime_log("updater-stdout", &line);
                        if !update_handoff_started.load(Ordering::Acquire) {
                            match parse_update_handoff_request(&line).and_then(|request| {
                                request.map_or(Ok(false), launch_brokered_update_handoff)
                            }) {
                                Ok(true) => update_handoff_started.store(true, Ordering::Release),
                                Ok(false) => {}
                                Err(error) => append_runtime_log("updater-broker", &error),
                            }
                        }
                    }
                    Err(error) => {
                        append_runtime_log("updater-stdout", &format!("read failed: {error}"));
                        break;
                    }
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => append_runtime_log("updater-stderr", &line),
                    Err(error) => {
                        append_runtime_log("updater-stderr", &format!("read failed: {error}"));
                        break;
                    }
                }
            }
        });
    }
    let restart_app = app.clone();
    thread::spawn(move || {
        match child.wait() {
            Ok(status) => append_runtime_log("updater", &format!("process exited: {status}")),
            Err(error) => append_runtime_log("updater", &format!("wait failed: {error}")),
        }
        if is_viewer_update {
            VIEWER_UPDATE_CHECK_IN_FLIGHT.store(false, Ordering::Release);
            if VIEWER_RESTART_AFTER_CHECK_REQUESTED.swap(false, Ordering::AcqRel)
                && !update_handoff_started.load(Ordering::Acquire)
            {
                append_runtime_log("tray-menu", "viewer restart after update check completed");
                match env::current_exe().map_err(|error| error.to_string()).and_then(|executable| {
                    schedule_viewer_restart(&executable)
                }) {
                    Ok(()) => restart_app.exit(0),
                    Err(error) => {
                        append_runtime_log("tray-menu", &error);
                        show_main_window_with_log(&restart_app, "viewer-restart-schedule-failed");
                    }
                }
            }
        }
    });
    append_runtime_log(
        "updater",
        &format!(
            "verified updater started restart_mode={restart_mode} arch={build_arch} package={package_kind}"
        ),
    );
    Ok(())
}

#[tauri::command]
fn check_installer_update(app: tauri::AppHandle) -> Result<ViewerUpdateCheck, String> {
    let resources = node_resource_paths(&app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?);
    ensure_resource_exists(&resources.node, "bundled Node runtime")
        .map_err(|error| error.to_string())?;
    ensure_resource_exists(&resources.agent, "bundled updater").map_err(|error| error.to_string())?;

    let mut command = Command::new(&resources.node);
    command
        .arg(&resources.agent)
        .arg("--check-update")
        .env("NODE_ENV", "production")
        .env("WONREMOTE_APP_DIR", &resources.root)
        .env("WONREMOTE_BUILD_ARCH", runtime_build_arch())
        .env("WONREMOTE_PACKAGE_KIND", packaged_update_kind(&resources.root))
        .env("WONREMOTE_UPDATE_PRODUCT", "viewer")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    add_no_window(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("update checker exited with {}", output.status)
        } else {
            detail.to_string()
        });
    }
    let result = stdout
        .lines()
        .find_map(|line| line.strip_prefix(UPDATE_CHECK_PREFIX))
        .ok_or_else(|| "update checker returned no result".to_string())
        .and_then(|payload| serde_json::from_str::<ViewerUpdateCheck>(payload).map_err(|error| error.to_string()))?;
    if result.latest_version.trim().is_empty() {
        return Err("update checker returned an empty version".to_string());
    }
    append_runtime_log(
        "viewer-native-update",
        &format!("manual check completed: version={} available={}", result.latest_version, result.available),
    );
    Ok(result)
}

fn start_viewer_update_watcher(app: tauri::AppHandle) {
    thread::spawn(move || {
        thread::sleep(VIEWER_UPDATE_INITIAL_DELAY);
        loop {
            if let Err(error) = start_installer_update(app.clone(), "viewer".to_string(), None) {
                append_runtime_log(
                    "viewer-native-update",
                    &format!("failed to start signed update check: {error}"),
                );
            }
            thread::sleep(VIEWER_UPDATE_CHECK_INTERVAL);
        }
    });
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

fn firebase_config_value(
    runtime_key: &str,
    build_value: Option<&str>,
    public_value: &str,
) -> Option<String> {
    env::var(runtime_key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            build_value
                .map(str::to_string)
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| Some(public_value.to_string()))
}

fn firebase_disabled() -> bool {
    [
        "WONREMOTE_DISABLE_FIREBASE",
        "VITE_WONREMOTE_DISABLE_FIREBASE",
    ]
    .iter()
    .filter_map(|key| env::var(key).ok())
    .any(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn firebase_mode_configured() -> bool {
    if firebase_disabled() {
        return false;
    }

    has_required_firebase_values(
        firebase_config_value(
            "WONREMOTE_FIREBASE_API_KEY",
            FIREBASE_API_KEY,
            PUBLIC_FIREBASE_API_KEY,
        ),
        firebase_config_value(
            "WONREMOTE_FIREBASE_AUTH_DOMAIN",
            FIREBASE_AUTH_DOMAIN,
            PUBLIC_FIREBASE_AUTH_DOMAIN,
        ),
        firebase_config_value(
            "WONREMOTE_FIREBASE_PROJECT_ID",
            FIREBASE_PROJECT_ID,
            PUBLIC_FIREBASE_PROJECT_ID,
        ),
        firebase_config_value(
            "WONREMOTE_FIREBASE_APP_ID",
            FIREBASE_APP_ID,
            PUBLIC_FIREBASE_APP_ID,
        ),
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
    if firebase_disabled() {
        return;
    }

    let values = [
        (
            "WONREMOTE_FIREBASE_API_KEY",
            firebase_config_value(
                "WONREMOTE_FIREBASE_API_KEY",
                FIREBASE_API_KEY,
                PUBLIC_FIREBASE_API_KEY,
            ),
        ),
        (
            "WONREMOTE_FIREBASE_AUTH_DOMAIN",
            firebase_config_value(
                "WONREMOTE_FIREBASE_AUTH_DOMAIN",
                FIREBASE_AUTH_DOMAIN,
                PUBLIC_FIREBASE_AUTH_DOMAIN,
            ),
        ),
        (
            "WONREMOTE_FIREBASE_PROJECT_ID",
            firebase_config_value(
                "WONREMOTE_FIREBASE_PROJECT_ID",
                FIREBASE_PROJECT_ID,
                PUBLIC_FIREBASE_PROJECT_ID,
            ),
        ),
        (
            "WONREMOTE_FIREBASE_APP_ID",
            firebase_config_value(
                "WONREMOTE_FIREBASE_APP_ID",
                FIREBASE_APP_ID,
                PUBLIC_FIREBASE_APP_ID,
            ),
        ),
        (
            "WONREMOTE_FIREBASE_STORAGE_BUCKET",
            firebase_config_value(
                "WONREMOTE_FIREBASE_STORAGE_BUCKET",
                FIREBASE_STORAGE_BUCKET,
                PUBLIC_FIREBASE_STORAGE_BUCKET,
            ),
        ),
        (
            "WONREMOTE_FIREBASE_MESSAGING_SENDER_ID",
            firebase_config_value(
                "WONREMOTE_FIREBASE_MESSAGING_SENDER_ID",
                FIREBASE_MESSAGING_SENDER_ID,
                PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
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
    let Ok(mut stream) = TcpStream::connect_timeout(&local_api_addr(), Duration::from_millis(1500))
    else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(2000)));

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

    let resources = node_resource_paths(resource_dir);

    ensure_resource_exists(&resources.node, "bundled Node runtime")?;
    ensure_resource_exists(&resources.server, "bundled API server")?;

    let mut server_cmd = Command::new(&resources.node);
    server_cmd.arg(&resources.server);
    server_cmd.env("WONREMOTE_API_PORT", LOCAL_API_PORT.to_string());
    server_cmd.env("NODE_ENV", "production");
    server_cmd.env("WONREMOTE_APP_DIR", &resources.root);
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

pub fn run() {
    install_panic_logger();
    let is_agent = launched_as_agent();
    append_runtime_log(
        "startup",
        &format!(
            "run start mode={} version={} arch={} exe={}",
            if is_agent { "agent" } else { "viewer" },
            env!("CARGO_PKG_VERSION"),
            env::consts::ARCH,
            env::current_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|error| format!("unknown ({error})"))
        ),
    );
    let _single_instance_guard = match try_acquire_single_instance(is_agent) {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            if agent_launch_should_show_window(is_agent) {
                if let Err(error) = request_existing_agent_window() {
                    append_runtime_log(
                        "startup",
                        &format!("failed to request existing agent window: {error}"),
                    );
                }
            }
            append_runtime_log(
                "startup",
                "duplicate instance ignored; existing instance is already running",
            );
            std::process::exit(0);
        }
        Err(error) => {
            append_runtime_log(
                "startup",
                &format!("failed to acquire single-instance guard: {error}"),
            );
            eprintln!("Failed to acquire WonRemote single-instance guard: {error}");
            return;
        }
    };

    tauri::Builder::default()
        .manage(AgentState::new())
        .invoke_handler(tauri::generate_handler![
            get_app_mode,
            save_agent_config,
            get_agent_config,
            get_or_create_agent_install_id,
            restart_agent_process,
            check_installer_update,
            start_installer_update,
            wake_device
        ])
        .setup(move |app| {
            let job = Job::new()?;
            let agent_state = app.state::<AgentState>();

            if is_agent {
                let force_show_window = agent_launch_should_show_window(is_agent);
                start_agent_show_window_request_watcher(app.handle().clone());

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
                            if let Ok(json) = parse_json_config(&content) {
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
                    if force_show_window {
                        show_main_window_with_log(app.handle(), "agent-startup-show-window");
                    }
                } else {
                    // Show window to register
                    show_main_window_with_log(app.handle(), "agent-registration-required");
                }

                if agent_tray_enabled() {
                    if let Some(icon) = app.default_window_icon().cloned() {
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

                        let _tray = TrayIconBuilder::with_id("agent_tray")
                            .icon(icon)
                            .menu(&menu)
                            .on_menu_event(move |app, event| match event.id().as_ref() {
                                "quit" => {
                                    app.exit(0);
                                }
                                "open" => {
                                    run_logged_action("tray-menu", "agent-open", || {
                                        show_main_window_with_log(app, "agent-menu-open");
                                    });
                                }
                                "restart" => {
                                    append_runtime_log("tray-menu", "agent-restart requested");
                                    let agent_state = app.state::<AgentState>();
                                    let job = app.state::<Job>();
                                    let resource_dir = if cfg!(debug_assertions) {
                                        app_root_from_manifest()
                                    } else {
                                        app.path().resource_dir().unwrap()
                                    };

                                    if let Err(e) =
                                        start_local_api_server_for_mode(&job, &resource_dir)
                                    {
                                        append_runtime_log(
                                            "tray-menu",
                                            &format!("agent-restart local api failed: {e}"),
                                        );
                                        eprintln!("Failed to ensure local API server: {}", e);
                                        return;
                                    }

                                    let mut api_url = None;
                                    if let Some(config_path) = default_agent_config_path() {
                                        if let Ok(content) = std::fs::read_to_string(&config_path) {
                                            if let Ok(json) = parse_json_config(&content) {
                                                if let Some(url) =
                                                    json.get("apiUrl").and_then(|v| v.as_str())
                                                {
                                                    api_url = Some(url.to_string());
                                                }
                                            }
                                        }
                                    }
                                    if let Err(error) = spawn_agent_only_process(
                                        app.clone(),
                                        &agent_state,
                                        &job,
                                        &resource_dir,
                                        api_url.as_deref(),
                                    ) {
                                        append_runtime_log(
                                            "tray-menu",
                                            &format!("agent-restart spawn failed: {error}"),
                                        );
                                    }
                                }
                                "toggle_startup" => {
                                    let is_checked = startup_i_clone.is_checked().unwrap_or(false);
                                    let next_checked = !is_checked;
                                    if let Err(e) = set_startup_registry(next_checked, true) {
                                        append_runtime_log(
                                            "tray-menu",
                                            &format!("agent-startup toggle failed: {e}"),
                                        );
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
                                    run_logged_action("tray-click", "agent-left-click", || {
                                        show_main_window_with_log(app, "agent-tray-left-click");
                                    });
                                }
                            })
                            .build(app)?;
                    }
                } else {
                    start_arch_specific_agent_tray(app, &agent_state);
                }
            } else {
                // Viewer Mode Setup
                let resource_dir = if cfg!(debug_assertions) {
                    app_root_from_manifest()
                } else {
                    app.path().resource_dir()?
                };
                start_local_api_server_for_mode(&job, &resource_dir)?;
                start_viewer_update_watcher(app.handle().clone());

                // Show window for Viewer
                show_main_window_with_log(app.handle(), "viewer-startup");

                // System Tray Menu Setup for Viewer
                let open_i = MenuItemBuilder::new("Open Viewer").id("open").build(app)?;
                let restart_i = MenuItemBuilder::new("Restart Viewer")
                    .id("restart")
                    .build(app)?;
                let startup_i = CheckMenuItemBuilder::new("Run at Startup")
                    .id("toggle_startup")
                    .checked(is_startup_registered(false))
                    .build(app)?;
                let quit_i = MenuItemBuilder::new("Exit").id("quit").build(app)?;

                let menu = MenuBuilder::new(app)
                    .items(&[&open_i, &restart_i, &startup_i, &quit_i])
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
                                run_logged_action("tray-menu", "viewer-open", || {
                                    show_main_window_with_log(app, "viewer-menu-open");
                                });
                            }
                            "restart" => {
                                append_runtime_log("tray-menu", "viewer restart with update check requested");
                                if let Err(error) = start_installer_update(
                                    app.clone(),
                                    "viewer".to_string(),
                                    Some(true),
                                ) {
                                    append_runtime_log(
                                        "tray-menu",
                                        &format!("viewer restart update check failed: {error}"),
                                    );
                                }
                            }
                            "toggle_startup" => {
                                let is_checked = startup_i_clone.is_checked().unwrap_or(false);
                                let next_checked = !is_checked;
                                if let Err(e) = set_startup_registry(next_checked, false) {
                                    append_runtime_log(
                                        "tray-menu",
                                        &format!("viewer-startup toggle failed: {e}"),
                                    );
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
                                run_logged_action("tray-click", "viewer-left-click", || {
                                    show_main_window_with_log(app, "viewer-tray-left-click");
                                });
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
                append_runtime_log("window", "close requested; hiding window");
                api.prevent_close();
                if let Err(error) = window.hide() {
                    append_runtime_log("window", &format!("hide failed: {error}"));
                }
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
    fn test_agent_default_compile_mode_enters_agent_mode() {
        assert!(mode_value_requests_agent(Some("agent")));
        assert!(mode_value_requests_agent(Some("AGENT")));
        assert!(!mode_value_requests_agent(Some("viewer")));
        assert!(!mode_value_requests_agent(None));
    }

    #[test]
    fn test_installer_update_restart_mode_is_strictly_validated() {
        assert_eq!(normalize_installer_restart_mode("viewer"), Ok("viewer"));
        assert_eq!(normalize_installer_restart_mode("agent"), Ok("agent"));
        assert!(normalize_installer_restart_mode("Viewer").is_err());
        assert!(normalize_installer_restart_mode("viewer & calc.exe").is_err());
    }

    #[test]
    fn test_update_handoff_request_requires_prefix_and_base64url_utf8() {
        assert_eq!(
            parse_update_handoff_request("ordinary Agent output"),
            Ok(None)
        );

        let script_path =
            r"C:\Users\Tester Name\AppData\Roaming\WonRemote\updates\run-installer-update-123.ps1";
        let encoded = URL_SAFE_NO_PAD.encode(script_path.as_bytes());
        assert_eq!(
            parse_update_handoff_request(&format!("{UPDATE_HANDOFF_PREFIX}{encoded}")),
            Ok(Some(PathBuf::from(script_path)))
        );
        assert!(parse_update_handoff_request(UPDATE_HANDOFF_PREFIX).is_err());
        assert!(parse_update_handoff_request(&format!("{UPDATE_HANDOFF_PREFIX}%%%")).is_err());
    }

    #[test]
    fn test_brokered_update_handoff_uses_a_hidden_noninteractive_powershell_window() {
        assert_eq!(
            brokered_update_powershell_args(),
            [
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]
        );
    }

    #[test]
    fn test_update_handoff_script_must_be_a_direct_owned_update_script() {
        let fixture_root = std::env::temp_dir().join(format!(
            "wonremote-update-broker-test-{}",
            std::process::id()
        ));
        let updates_root = fixture_root.join("updates");
        let outside_root = fixture_root.join("outside");
        std::fs::create_dir_all(&updates_root).expect("failed to create update fixture");
        std::fs::create_dir_all(&outside_root).expect("failed to create outside fixture");

        let valid = updates_root.join("run-portable-update-123.ps1");
        std::fs::write(&valid, b"exit 0").expect("failed to create valid update script");
        assert_eq!(
            validate_update_handoff_script_path_in_root(&valid, &updates_root)
                .expect("valid update script should pass"),
            std::fs::canonicalize(&valid).expect("failed to canonicalize valid fixture")
        );

        let unexpected = updates_root.join("arbitrary.ps1");
        std::fs::write(&unexpected, b"exit 0").expect("failed to create unexpected script");
        assert!(validate_update_handoff_script_path_in_root(&unexpected, &updates_root).is_err());

        let outside = outside_root.join("run-installer-update-escape.ps1");
        std::fs::write(&outside, b"exit 0").expect("failed to create outside script");
        assert!(validate_update_handoff_script_path_in_root(&outside, &updates_root).is_err());

        let _ = std::fs::remove_dir_all(fixture_root);
    }

    #[test]
    fn test_runtime_build_arch_matches_the_compiled_binary() {
        #[cfg(target_arch = "x86")]
        assert_eq!(runtime_build_arch(), "x86");
        #[cfg(not(target_arch = "x86"))]
        assert_eq!(runtime_build_arch(), "x64");
    }

    #[test]
    fn test_packaged_update_kind_distinguishes_installed_and_legacy_portable_layouts() {
        let root = std::env::temp_dir().join(format!(
            "wonremote-package-kind-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("failed to create package-kind fixture");
        assert_eq!(packaged_update_kind(&root), "installer");

        std::fs::write(root.join("WonRemote Agent.exe"), b"fixture")
            .expect("failed to create legacy Agent executable");
        assert_eq!(packaged_update_kind(&root), "portable-agent");

        std::fs::write(root.join("WonRemote Viewer.exe"), b"fixture")
            .expect("failed to create legacy Viewer executable");
        assert_eq!(packaged_update_kind(&root), "portable");

        std::fs::write(
            root.join(PORTABLE_MARKER_FILENAME),
            r#"{"schemaVersion":1,"packageKind":"portable-agent","version":"0.1.40"}"#,
        )
        .expect("failed to create portable marker");
        assert_eq!(packaged_update_kind(&root), "portable-agent");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn test_agent_show_window_flags_are_recognized() {
        assert!(args_request_show_window(&[
            "wonremote-viewer.exe".to_string(),
            "--agent".to_string(),
            "--show-window".to_string(),
        ]));
        assert!(args_request_show_window(&["--open".to_string()]));
        assert!(args_request_show_window(&["--register".to_string()]));
        assert!(!args_request_show_window(&["--agent".to_string()]));
    }

    #[test]
    fn test_agent_launch_visibility_distinguishes_user_and_background_starts() {
        assert!(!agent_launch_should_show_window_from_args(
            false,
            &["wonremote-viewer.exe".to_string()],
        ));
        assert!(!agent_launch_should_show_window_from_args(
            true,
            &["wonremote-viewer.exe".to_string(), "--agent".to_string()],
        ));
        assert!(agent_launch_should_show_window_from_args(
            true,
            &[
                "wonremote-viewer.exe".to_string(),
                "--agent".to_string(),
                "--show-window".to_string(),
            ],
        ));
        assert!(agent_launch_should_show_window_from_args(
            true,
            &["WonRemote Agent.exe".to_string()],
        ));
    }

    #[test]
    fn test_single_instance_mutex_names_are_mode_scoped() {
        assert_ne!(
            single_instance_mutex_name(false),
            single_instance_mutex_name(true)
        );
        assert!(single_instance_mutex_name(false).contains("Viewer"));
        assert!(single_instance_mutex_name(true).contains("Agent"));
    }

    #[test]
    fn test_single_instance_guard_rejects_duplicate_same_mode() {
        let mutex_name = format!(
            "Local\\WonRemote.Test.SingleInstance.{}",
            std::process::id()
        );
        let first = try_acquire_single_instance_named(&mutex_name)
            .expect("first mutex acquisition should not error");
        assert!(first.is_some());

        let second = try_acquire_single_instance_named(&mutex_name)
            .expect("second mutex acquisition should not error");
        assert!(second.is_none());

        drop(first);

        let third = try_acquire_single_instance_named(&mutex_name)
            .expect("mutex should be acquirable after guard drop");
        assert!(third.is_some());
    }

    #[test]
    fn test_agent_tray_is_disabled_on_x86_builds() {
        #[cfg(target_arch = "x86")]
        {
            assert!(!agent_tray_enabled());
        }
        #[cfg(not(target_arch = "x86"))]
        {
            assert!(agent_tray_enabled());
        }
    }

    #[cfg(target_arch = "x86")]
    #[test]
    fn test_win32_agent_tray_constants_are_stable() {
        assert_eq!(WIN32_AGENT_TRAY_ID, 37);
        assert_eq!(WM_WONREMOTE_AGENT_TRAY, WM_APP + 37);
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
    fn test_magic_packet_accepts_common_mac_formats() {
        let packet = build_magic_packet("01:23:45:67:89:ab").expect("valid mac");

        assert_eq!(&packet[0..6], &[0xff; 6]);
        assert_eq!(&packet[6..12], &[0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);
        assert_eq!(&packet[96..102], &[0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);

        let hyphen_packet = build_magic_packet("01-23-45-67-89-AB").expect("valid mac");
        assert_eq!(packet, hyphen_packet);
    }

    #[test]
    fn test_magic_packet_rejects_invalid_mac() {
        assert!(build_magic_packet("01:23:45").is_err());
        assert!(build_magic_packet("not-a-mac").is_err());
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

    #[test]
    fn test_config_registration_accepts_utf8_bom_json() {
        let config_path =
            std::env::temp_dir().join(format!("wonremote-bom-config-{}.json", std::process::id()));
        std::fs::write(
            &config_path,
            "\u{feff}{\"installId\":\"agent-test\",\"registeredDeviceId\":\"123-45-67890:AGENT-TEST\"}",
        )
        .expect("failed to write temp config");

        assert!(config_has_registered_device_id(&config_path));

        let _ = std::fs::remove_file(config_path);
    }

    #[test]
    fn test_runtime_log_path_uses_appdata_wonremote_logs() {
        let appdata = PathBuf::from(r"C:\Users\Test\AppData\Roaming");

        assert_eq!(
            runtime_log_file_from_appdata(&appdata),
            PathBuf::from(r"C:\Users\Test\AppData\Roaming\WonRemote\logs\wonremote-tauri.log"),
        );
    }

    #[test]
    fn test_agent_install_id_survives_config_and_webview_changes() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "wonremote-install-id-test-{}-{unique}",
            std::process::id()
        ));
        let identity_path = agent_install_id_file_from_appdata(&root);
        let config_path = root.join("WonRemote").join("agent-config.json");
        std::fs::create_dir_all(config_path.parent().expect("config parent"))
            .expect("failed to create config directory");
        std::fs::write(&config_path, r#"{"installId":"agent-config-id"}"#)
            .expect("failed to write config");

        let first = load_or_create_agent_install_id(
            &identity_path,
            Some(&config_path),
            "agent-webview-id",
        )
        .expect("config id should initialize persistent identity");
        assert_eq!(first, "agent-config-id");

        std::fs::remove_file(&config_path).expect("failed to remove config");
        let restored = load_or_create_agent_install_id(
            &identity_path,
            Some(&config_path),
            "agent-new-webview-id",
        )
        .expect("persistent identity should survive reinstall state changes");
        assert_eq!(restored, "agent-config-id");

        let _ = std::fs::remove_dir_all(root.join("WonRemote"));
    }

    #[test]
    fn test_agent_show_window_request_path_uses_appdata_wonremote() {
        let appdata = PathBuf::from(r"C:\Users\Test\AppData\Roaming");

        assert_eq!(
            agent_show_window_request_file_from_appdata(&appdata),
            PathBuf::from(r"C:\Users\Test\AppData\Roaming\WonRemote\agent-show-window.request"),
        );
    }

    #[test]
    fn test_runtime_log_append_creates_directory_and_file() {
        let root =
            std::env::temp_dir().join(format!("wonremote-runtime-log-test-{}", std::process::id()));
        let log_path = runtime_log_file_from_appdata(&root);
        let _ = std::fs::remove_dir_all(root.join("WonRemote"));

        append_runtime_log_entry(&log_path, "test", "double-click failure probe")
            .expect("runtime log append should create parent directory and file");

        let content = std::fs::read_to_string(&log_path)
            .expect("runtime log file should be readable after append");
        assert!(content.contains("[test]"));
        assert!(content.contains("double-click failure probe"));

        let _ = std::fs::remove_dir_all(root.join("WonRemote"));
    }

    #[test]
    fn test_node_resource_paths_remove_verbatim_prefixes() {
        for (input, expected_root) in [
            (r"\\?\C:\Program Files\WonRemote", r"C:\Program Files\WonRemote"),
            (r"\\?\UNC\server\share\WonRemote", r"\\server\share\WonRemote"),
        ] {
            let resources = node_resource_paths(Path::new(input));
            assert_eq!(resources.root, PathBuf::from(expected_root));
            for path in [&resources.node, &resources.agent, &resources.server, &resources.poc] {
                assert!(!path.to_string_lossy().starts_with(r"\\?\"));
                assert!(path.starts_with(&resources.root));
            }
        }
    }
}
