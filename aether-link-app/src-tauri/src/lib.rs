use std::os::windows::io::AsRawHandle;
use std::{
    env, io, mem,
    path::{Path, PathBuf},
    process::Command,
    ptr,
};

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
const STARTUP_REGISTRY_VALUE: &str = "AetherLinkViewer";

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
    if let Some(config_path) = env::var_os("AETHER_LINK_AGENT_CONFIG") {
        return Some(PathBuf::from(config_path));
    }

    env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|base_dir| base_dir.join("AetherLink").join("agent-config.json"))
}

fn should_start_embedded_agent() -> bool {
    let forced = env::var("AETHER_LINK_DESKTOP_EMBED_AGENT")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false);
    let has_env_credentials = env::var_os("AETHER_LINK_AGENT_ID").is_some()
        && env::var_os("AETHER_LINK_AGENT_PASSWORD").is_some();
    let has_existing_config = default_agent_config_path()
        .as_ref()
        .is_some_and(|config_path| config_path.exists());

    forced || has_env_credentials || has_existing_config
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

fn set_startup_registry(enable: bool) -> Result<(), std::io::Error> {
    if enable {
        let exe_path = std::env::current_exe()?;
        let exe_str = format!("\"{}\"", exe_path.to_string_lossy());
        set_registry_value(
            STARTUP_REGISTRY_PATH,
            STARTUP_REGISTRY_VALUE,
            Some(&exe_str),
        )
    } else {
        set_registry_value(STARTUP_REGISTRY_PATH, STARTUP_REGISTRY_VALUE, None)
    }
}

fn is_startup_registered() -> bool {
    registry_value_exists(STARTUP_REGISTRY_PATH, STARTUP_REGISTRY_VALUE)
}

fn start_dev_processes(job: &Job) -> Result<(), io::Error> {
    let cwd = app_root_from_manifest();

    let mut server_cmd = Command::new("cmd");
    server_cmd.args(["/c", "npm run api"]);
    server_cmd.current_dir(&cwd);
    add_no_window(&mut server_cmd);
    spawn_managed(job, &mut server_cmd, "dev API server")?;

    if should_start_embedded_agent() {
        let mut agent_cmd = Command::new("cmd");
        agent_cmd.args(["/c", "npm run agent:watch"]);
        agent_cmd.current_dir(&cwd);
        add_no_window(&mut agent_cmd);
        spawn_managed(job, &mut agent_cmd, "dev agent")?;
    }

    Ok(())
}

fn start_production_processes(job: &Job, resource_dir: &Path) -> Result<(), io::Error> {
    let node_path = bundled_node_path(resource_dir);
    let server_path = resource_dir.join("server").join("index.mjs");
    let agent_path = resource_dir.join("agent").join("index.mjs");
    let poc_path = resource_dir.join("bin").join("aether-link-poc.exe");

    ensure_resource_exists(&node_path, "bundled Node runtime")?;
    ensure_resource_exists(&server_path, "bundled API server")?;
    ensure_resource_exists(&agent_path, "bundled Agent")?;
    ensure_resource_exists(&poc_path, "bundled Rust PoC")?;

    let mut server_cmd = Command::new(&node_path);
    server_cmd.arg(&server_path);
    server_cmd.env("AETHER_LINK_API_PORT", "8787");
    server_cmd.env("NODE_ENV", "production");
    server_cmd.env("AETHER_LINK_APP_DIR", resource_dir);
    add_no_window(&mut server_cmd);
    spawn_managed(job, &mut server_cmd, "production API server")?;

    if should_start_embedded_agent() {
        let mut agent_cmd = Command::new(&node_path);
        agent_cmd.arg(&agent_path);
        agent_cmd.arg("--watch");
        agent_cmd.env("AETHER_LINK_API_URL", "http://127.0.0.1:8787");
        agent_cmd.env("AETHER_LINK_POC_PATH", &poc_path);
        agent_cmd.env("AETHER_LINK_APP_DIR", resource_dir);
        agent_cmd.env("NODE_ENV", "production");
        add_no_window(&mut agent_cmd);
        spawn_managed(job, &mut agent_cmd, "production agent")?;
    }

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let job = Job::new()?;

            if cfg!(debug_assertions) {
                start_dev_processes(&job)?;
            } else {
                let resource_dir = app.path().resource_dir()?;
                start_production_processes(&job, &resource_dir)?;
            }

            app.manage(job);

            // System Tray Menu Setup
            let quit_i = MenuItemBuilder::new("Exit").id("quit").build(app)?;
            let open_i = MenuItemBuilder::new("Open Viewer").id("open").build(app)?;
            let startup_i = CheckMenuItemBuilder::new("Run at Startup")
                .id("toggle_startup")
                .checked(is_startup_registered())
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
                            if let Err(e) = set_startup_registry(next_checked) {
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

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run AetherLink Viewer desktop shell");
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    #[test]
    fn test_registry_toggle_uses_isolated_test_key() {
        let test_value_name = format!("AetherLinkViewerTest{}", std::process::id());
        let test_path = r"Software\AetherLink\Tests\Run";

        let _ = set_registry_value(test_path, &test_value_name, None);
        assert!(!registry_value_exists(test_path, &test_value_name));

        set_registry_value(
            test_path,
            &test_value_name,
            Some(r#""C:\AetherLink\viewer.exe""#),
        )
        .expect("failed to set isolated registry value");
        assert!(registry_value_exists(test_path, &test_value_name));

        set_registry_value(test_path, &test_value_name, None)
            .expect("failed to clear isolated registry value");
        assert!(!registry_value_exists(test_path, &test_value_name));
    }
}
