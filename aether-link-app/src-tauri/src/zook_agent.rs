use std::{env, fs, os::windows::{ffi::OsStrExt, process::CommandExt}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex, thread, time::{Duration, Instant}};
use windows_sys::Win32::{
    Foundation::{CloseHandle, BOOL, HWND, LPARAM},
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
    System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetDlgItem, GetWindowLongW,
        GetWindowTextW, GetWindowThreadProcessId, PostMessageW, SendMessageTimeoutW,
        BM_CLICK, GWL_STYLE, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_GETTEXT, WM_GETTEXTLENGTH, WM_SETTEXT, WS_DISABLED},
};

static CONFIGURING: Mutex<()> = Mutex::new(());

fn formatted_number(number: &str) -> Result<String, String> {
    if number.len() != 8 || !number.bytes().all(|c| c.is_ascii_digit()) {
        return Err("ZOOK 고유번호는 숫자 8자리로 입력해 주세요.".into());
    }
    Ok(format!("014-{}-{}", &number[..4], &number[4..]))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(super::default_agent_config_path().ok_or("Agent settings path is unavailable.")?.with_file_name("zook-number.json"))
}

fn save_number(path: &Path, number: &str) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid ZOOK settings path.")?).map_err(|e| e.to_string())?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let temp = path.with_extension(format!("{}.{nonce}.tmp", std::process::id()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        file.write_all(serde_json::to_string(number).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

#[tauri::command]
pub fn load_zook_number() -> Result<String, String> {
    if !super::launched_as_agent() { return Err("Agent에서만 사용할 수 있습니다.".into()); }
    read_number(&config_path()?)
}

fn read_number(path: &Path) -> Result<String, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    };
    let number: String = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    formatted_number(&number)?;
    Ok(number)
}

#[tauri::command]
pub async fn configure_zook_agent(number: String) -> Result<String, String> {
    if !super::launched_as_agent() { return Err("Agent에서만 사용할 수 있습니다.".into()); }
    formatted_number(&number)?;
    tauri::async_runtime::spawn_blocking(move || configure_number(&number)).await.map_err(|e| e.to_string())?
}

fn configure_number(number: &str) -> Result<String, String> {
    formatted_number(number)?;
    let _guard = CONFIGURING.try_lock().map_err(|_| "ZOOK 설정이 진행 중입니다.")?;
    let _process_guard = super::try_acquire_single_instance_named(r"Local\WonRemote.Agent.ZookConfiguration")
        .map_err(|e| e.to_string())?.ok_or("ZOOK 설정이 진행 중입니다.")?;
    let path = config_path()?;
    let window = prepare_window()?;
    let formatted = apply_number(window, number, Duration::from_secs(5))?;
    save_number(&path, number).map_err(|e| format!("ZOOK은 대기 중이지만 번호 저장에 실패했습니다: {e}"))?;
    Ok(formatted)
}

pub fn run_cli(args: &[String]) -> Option<i32> {
    if !args.iter().any(|arg| arg == "--configure-zook") { return None; }
    let result = if args.len() == 3 && args[0] == "--agent" && args[1] == "--configure-zook" {
        configure_number(&args[2])
    } else { Err("Invalid ZOOK configuration arguments.".into()) };
    match result {
        Ok(number) => { println!("{}", serde_json::json!({"number": number})); Some(0) }
        Err(error) => { eprintln!("{error}"); Some(1) }
    }
}

#[tauri::command]
pub fn open_zook_notification_settings() -> Result<(), String> {
    if !super::launched_as_agent() { return Err("Agent에서만 사용할 수 있습니다.".into()); }
    let result = std::process::Command::new("explorer.exe").arg("ms-settings:notifications").spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

fn message(window: HWND, message: u32, wparam: usize, lparam: LPARAM) -> Result<usize, String> {
    let mut result = 0;
    if unsafe { SendMessageTimeoutW(window, message, wparam, lparam, SMTO_ABORTIFHUNG | SMTO_BLOCK, 500, &mut result) } == 0 {
        return Err("ZOOK 응답이 없습니다. 실행 상태와 권한을 확인해 주세요.".into());
    }
    Ok(result)
}

fn read_control(window: HWND) -> Result<String, String> {
    let mut buffer = [0u16; 128];
    let count = message(window, WM_GETTEXT, buffer.len(), buffer.as_mut_ptr() as LPARAM)?;
    Ok(String::from_utf16_lossy(&buffer[..count.min(buffer.len() - 1)]))
}

fn set_control(window: HWND, value: &str) -> Result<(), String> {
    let value: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    if message(window, WM_SETTEXT, 0, value.as_ptr() as LPARAM)? == 0 {
        return Err("ZOOK 입력값을 설정하지 못했습니다.".into());
    }
    Ok(())
}

fn control(window: HWND, id: i32, expected_class: &str) -> Result<HWND, String> {
    let child = unsafe { GetDlgItem(window, id) };
    let mut class = [0u16; 32];
    let count = unsafe { GetClassNameW(child, class.as_mut_ptr(), class.len() as i32) };
    if child.is_null() || String::from_utf16_lossy(&class[..count.max(0) as usize]) != expected_class {
        return Err("지원하지 않는 ZOOK 입력 화면입니다. ZOOK Agent 창을 열어 주세요.".into());
    }
    Ok(child)
}

fn click(button: HWND) -> Result<(), String> {
    if unsafe { PostMessageW(button, BM_CLICK, 0, 0) } == 0 {
        return Err("ZOOK 버튼을 실행하지 못했습니다.".into());
    }
    Ok(())
}

fn apply_number(window: HWND, number: &str, timeout: Duration) -> Result<String, String> {
    let formatted = formatted_number(number)?;
    let number_input = control(window, 1003, "Edit")?;
    let password_input = control(window, 1005, "Edit")?;
    let button = control(window, 1001, "Button")?;
    let label = read_control(button)?.replace(char::is_whitespace, "");
    if !enabled(window) || !enabled(button) || unsafe { GetWindowLongW(password_input, GWL_STYLE) } & 0x20 == 0 {
        return Err("ZOOK의 접속 대기 화면을 확인해 주세요.".into());
    }
    if !enabled(number_input) || !enabled(password_input) {
        if enabled(number_input) || enabled(password_input) || label != "대기취소하기" {
            return Err("ZOOK이 이미 접속 중이거나 입력 준비가 되지 않았습니다. ZOOK 창을 확인해 주세요.".into());
        }
        click(button)?;
        let deadline = Instant::now() + timeout;
        loop {
            if enabled(number_input) && enabled(password_input) {
                let label = read_control(button)?.replace(char::is_whitespace, "");
                if label.contains("대기") && !label.contains("취소") { break; }
            }
            if Instant::now() >= deadline {
                return Err("ZOOK 대기가 취소되지 않았습니다. 입력값은 변경하지 않았습니다. ZOOK 창을 확인해 주세요.".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    let label = read_control(button)?.replace(char::is_whitespace, "");
    if !enabled(window) || !enabled(button) || !label.contains("대기") || label.contains("취소") {
        return Err("ZOOK의 접속 대기 화면을 확인해 주세요.".into());
    }
    set_control(number_input, &formatted)?;
    set_control(password_input, "1234")?;
    if read_control(number_input)? != formatted || message(password_input, WM_GETTEXTLENGTH, 0, 0)? != 4 {
        return Err("ZOOK 입력값 확인에 실패했습니다. 대기를 시작하지 않았습니다.".into());
    }
    click(button)?;
    let deadline = Instant::now() + timeout;
    let mut waiting_since = None;
    while Instant::now() < deadline {
        if !enabled(number_input) && !enabled(password_input) && read_control(button)?.replace(char::is_whitespace, "").contains("대기취소") {
            let since = waiting_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(500) && read_control(number_input)? == formatted { return Ok(formatted); }
        } else { waiting_since = None; }
        thread::sleep(Duration::from_millis(100));
    }
    Err("ZOOK 대기 상태를 확인하지 못했습니다. ZOOK 창의 오류나 번호 중복 안내를 확인해 주세요. 자동 재시도하지 않습니다.".into())
}

fn installed_path() -> Result<PathBuf, String> {
    let path = installation_path()?;
    if !path.is_file() { return Err("ZOOK Agent가 설치되어 있지 않습니다.".into()); }
    Ok(path)
}

fn installation_path() -> Result<PathBuf, String> {
    let root = env::var_os("ProgramFiles(x86)").or_else(|| env::var_os("ProgramFiles"))
        .ok_or("Program Files path is unavailable.")?;
    let path = PathBuf::from(root).join("Mastersoft").join("ZOOKAgent").join("ZOOKServer.exe");
    Ok(path)
}

// Inno Setup's documented silent flags; never suppress Windows elevation consent.
const INSTALL_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$dir = Join-Path ([IO.Path]::GetTempPath()) ('WonRemote-Zook-' + [Guid]::NewGuid().ToString('N'))
$process = $null
try {
    New-Item -ItemType Directory -Path $dir | Out-Null
    $setup = Join-Path $dir 'ZOOKAgentSetup.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://zook.co.kr/zook/ZOOKAgentSetup.exe' -OutFile $setup -TimeoutSec 60
    if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -ne '7EB26BB0275FC1B4F98F90920AD27039D3AEC4E7520F20F9678CF2739417258F') { throw 'ZOOK installer checksum mismatch; installation stopped.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $setup
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Mastersoft Corporation,') { throw 'ZOOK installer publisher validation failed.' }
    $target = Split-Path -Parent $env:WONREMOTE_ZOOK_EXE
    $process = Start-Process -FilePath $setup -ArgumentList @('/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="' + $target + '"')) -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { throw 'ZOOK installation is still running. Check the installer or approval window before trying again.' }
    if ($process.ExitCode -ne 0) { throw ('ZOOK installer failed: ' + $process.ExitCode) }
    if (-not (Test-Path -LiteralPath $env:WONREMOTE_ZOOK_EXE -PathType Leaf)) { throw 'ZOOK executable was not installed.' }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally { if ($null -eq $process -or $process.HasExited) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue } }
"#;

fn install_zook(path: &Path) -> Result<(), String> {
    let mut child = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", INSTALL_SCRIPT])
        .env("WONREMOTE_ZOOK_EXE", path).creation_flags(super::CREATE_NO_WINDOW)
        .stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ZOOK 설치 시작 실패: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(210);
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("ZOOK 설치 확인 시간이 초과되었습니다. 설치 또는 Windows 승인창을 확인해 주세요. 자동 재시도하지 않습니다.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("ZOOK 설치 실패: {}", String::from_utf8_lossy(&output.stderr).trim().chars().take(500).collect::<String>()));
    }
    Ok(())
}

fn prepare_window() -> Result<HWND, String> {
    let path = installation_path()?;
    prepare_window_with(
        || Ok(path.is_file()),
        || install_zook(&path),
        || find_windows(&path),
        || start_zook(&path),
        Duration::from_secs(15),
    )
}

fn start_zook(path: &Path) -> Result<(), String> {
    let updater = path.with_file_name("ZOOKServerUpdater.exe");
    if !updater.is_file() {
        return Err("ZOOKServerUpdater.exe를 찾지 못했습니다. ZOOK Agent 설치 상태를 확인해 주세요.".into());
    }
    // Use the installed shortcut's entrypoint; the core alone does not initialize standby.
    Command::new(&updater).current_dir(updater.parent().unwrap()).spawn()
        .map(|_| ()).map_err(|e| format!("ZOOK 실행 실패: {e}"))
}

fn prepare_window_with(
    mut installed: impl FnMut() -> Result<bool, String>,
    mut install: impl FnMut() -> Result<(), String>,
    mut windows: impl FnMut() -> Result<Vec<HWND>, String>,
    mut start: impl FnMut() -> Result<(), String>,
    timeout: Duration,
) -> Result<HWND, String> {
    if !installed()? {
        install()?;
        if !installed()? { return Err("ZOOK 설치 후 실행 파일을 찾지 못했습니다.".into()); }
    }
    let mut found = windows()?;
    if found.is_empty() {
        start()?;
        let deadline = Instant::now() + timeout;
        loop {
            found = windows()?;
            if !found.is_empty() { break; }
            if Instant::now() >= deadline { return Err("ZOOK 실행 후 창을 확인하지 못했습니다. 권한 또는 ZOOK 안내창을 확인해 주세요.".into()); }
            thread::sleep(Duration::from_millis(100));
        }
    }
    if found.len() != 1 { return Err("ZOOK Agent 창이 여러 개입니다. 하나만 남겨 주세요.".into()); }
    let window = found[0];
    let deadline = Instant::now() + timeout;
    loop {
        if control(window, 1003, "Edit").is_ok() && control(window, 1005, "Edit").is_ok() && control(window, 1001, "Button").is_ok() { return Ok(window); }
        if Instant::now() >= deadline { return Err("ZOOK 입력 화면이 준비되지 않았습니다.".into()); }
        thread::sleep(Duration::from_millis(100));
    }
}

fn process_path(window: HWND) -> Option<PathBuf> {
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() { return None; }
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(process);
        (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize])))
    }
}

fn text(window: HWND) -> String {
    let mut buffer = [0u16; 256];
    let count = unsafe { GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..count.max(0) as usize])
}

fn enabled(window: HWND) -> bool {
    unsafe { GetWindowLongW(window, GWL_STYLE) as u32 & WS_DISABLED == 0 }
}

unsafe extern "system" fn collect_windows(window: HWND, context: LPARAM) -> BOOL {
    if text(window) == "ZOOK" { (*(context as *mut Vec<HWND>)).push(window); }
    1
}

fn find_window() -> Result<HWND, String> {
    let windows = find_windows(&installed_path()?)?;
    if windows.len() != 1 { return Err("설치된 ZOOK Agent 창을 하나만 열어 주세요.".into()); }
    Ok(windows[0])
}

fn find_windows(path: &Path) -> Result<Vec<HWND>, String> {
    let expected = path.to_string_lossy().to_lowercase();
    let mut windows = Vec::new();
    unsafe { EnumWindows(Some(collect_windows), &mut windows as *mut Vec<HWND> as LPARAM); }
    let windows: Vec<_> = windows.into_iter().filter(|window|
        process_path(*window).is_some_and(|p| p.to_string_lossy().to_lowercase() == expected)
    ).collect();
    Ok(windows)
}

#[cfg(test)]
#[path = "zook_agent_test.rs"]
mod tests;
