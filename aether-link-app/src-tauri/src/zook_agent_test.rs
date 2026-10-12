use super::*;
use windows_sys::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW, GetDlgCtrlID, IsWindowVisible, SendMessageTimeoutW, WM_GETTEXT, SMTO_ABORTIFHUNG};
use windows_sys::Win32::{Foundation::LRESULT, System::LibraryLoader::GetModuleHandleW, UI::WindowsAndMessaging::{CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostQuitMessage, RegisterClassW, SetWindowLongW, SetWindowTextW, TranslateMessage, MSG, WNDCLASSW, WM_CLOSE, WM_COMMAND, WM_DESTROY, WS_CHILD, ES_PASSWORD, GWLP_USERDATA}};

fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

unsafe fn enable_test_control(window: HWND, enabled: bool) {
    let style = GetWindowLongW(window, GWL_STYLE) as u32;
    SetWindowLongW(window, GWL_STYLE, if enabled { style & !WS_DISABLED } else { style | WS_DISABLED } as i32);
}

unsafe extern "system" fn test_window(window: HWND, msg: u32, wp: usize, lp: LPARAM) -> LRESULT {
    match msg {
        WM_COMMAND if wp & 0xffff == 1001 => {
            SetWindowLongW(window, GWLP_USERDATA, GetWindowLongW(window, GWLP_USERDATA) + 1);
            if text(window) == "reject" { return 0; }
            let button = GetDlgItem(window, 1001);
            let cancel = text(button).contains("취소");
            enable_test_control(GetDlgItem(window, 1003), cancel);
            enable_test_control(GetDlgItem(window, 1005), cancel);
            SetWindowTextW(button, wide(if cancel { "접속 대기" } else { "대기취소 하기" }).as_ptr());
            0
        }
        WM_CLOSE => { DestroyWindow(window); 0 }
        WM_DESTROY => { PostQuitMessage(0); 0 }
        _ => DefWindowProcW(window, msg, wp, lp),
    }
}

fn fake_window(reject: bool) -> (HWND, thread::JoinHandle<()>) {
    let (send, recv) = std::sync::mpsc::channel();
    let handle = thread::spawn(move || unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        let class = wide("WonRemoteZookControlTest");
        let registration = WNDCLASSW { lpfnWndProc: Some(test_window), hInstance: module, lpszClassName: class.as_ptr(), ..std::mem::zeroed() };
        RegisterClassW(&registration);
        let window = CreateWindowExW(0, class.as_ptr(), wide(if reject { "reject" } else { "ready" }).as_ptr(), 0, 0, 0, 200, 200, std::ptr::null_mut(), std::ptr::null_mut(), module, std::ptr::null());
        assert!(!window.is_null());
        for (id, class, label, style) in [(1003, "Edit", "original", 0), (1005, "Edit", "old", ES_PASSWORD as u32), (1001, "Button", "접속 대기", 0)] {
            assert!(!CreateWindowExW(0, wide(class).as_ptr(), wide(label).as_ptr(), WS_CHILD | style, 0, 0, 100, 20, window, id as _, module, std::ptr::null()).is_null());
        }
        send.send(window as usize).unwrap();
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 { TranslateMessage(&msg); DispatchMessageW(&msg); }
    });
    (recv.recv().unwrap() as HWND, handle)
}

#[test]
fn startup_requires_public_updater_and_reports_launch_failure() {
    let dir = env::temp_dir().join(format!("wonremote-zook-start-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let core = dir.join("ZOOKServer.exe");
    let updater = dir.join("ZOOKServerUpdater.exe");
    fs::write(&core, b"invalid core fixture").unwrap();
    let missing = start_zook(&core).unwrap_err();
    fs::write(&updater, b"invalid updater fixture").unwrap();
    let invalid = start_zook(&core).unwrap_err();
    fs::remove_file(core).unwrap();
    fs::remove_file(updater).unwrap();
    fs::remove_dir(dir).unwrap();
    assert!(missing.contains("ZOOKServerUpdater.exe"), "{missing}");
    assert!(invalid.contains("ZOOK 실행 실패"), "{invalid}");
}

#[test]
fn prepares_install_and_start_once_and_stops_on_failures() {
    use std::cell::Cell;
    let (window, worker) = fake_window(false);
    let ready = Cell::new(false);
    let running = Cell::new(false);
    let installs = Cell::new(0);
    let starts = Cell::new(0);
    let result = prepare_window_with(
        || Ok(ready.get()),
        || { installs.set(installs.get() + 1); ready.set(true); Ok(()) },
        || Ok(if running.get() { vec![window] } else { vec![] }),
        || { starts.set(starts.get() + 1); running.set(true); Ok(()) },
        Duration::ZERO,
    );
    assert_eq!(result.unwrap(), window);
    assert_eq!((installs.get(), starts.get()), (1, 1));
    running.set(false);
    assert_eq!(prepare_window_with(|| Ok(true), || panic!("installed/stopped must not reinstall"), || Ok(if running.get() { vec![window] } else { vec![] }), || { starts.set(starts.get() + 1); running.set(true); Ok(()) }, Duration::ZERO).unwrap(), window);
    assert_eq!((installs.get(), starts.get()), (1, 2));
    assert_eq!(prepare_window_with(|| Ok(true), || panic!("already installed"), || Ok(vec![window]), || panic!("already running"), Duration::ZERO).unwrap(), window);
    assert!(prepare_window_with(|| Ok(false), || Err("approval denied".into()), || panic!("install failed"), || panic!("install failed"), Duration::ZERO).unwrap_err().contains("approval denied"));
    assert!(prepare_window_with(|| Ok(false), || Ok(()), || panic!("missing installed file"), || panic!("missing installed file"), Duration::ZERO).is_err());
    assert!(prepare_window_with(|| Ok(true), || panic!(), || Ok(vec![]), || Err("start failed".into()), Duration::ZERO).unwrap_err().contains("start failed"));
    assert!(prepare_window_with(|| Ok(true), || panic!(), || Ok(vec![]), || Ok(()), Duration::ZERO).unwrap_err().contains("창"));
    assert!(prepare_window_with(|| Ok(true), || panic!(), || Ok(vec![window, window]), || panic!("ambiguous windows"), Duration::ZERO).is_err());
    assert_eq!(read_control(unsafe { GetDlgItem(window, 1003) }).unwrap(), "original", "bootstrap does not mutate number before standby controller");
    unsafe { PostMessageW(window, WM_CLOSE, 0, 0); }
    worker.join().unwrap();
}

#[test]
fn installer_rejects_changed_download_before_execution() {
    let script = INSTALL_SCRIPT.replace(
        "Invoke-WebRequest -UseBasicParsing -Uri 'https://zook.co.kr/zook/ZOOKAgentSetup.exe' -OutFile $setup -TimeoutSec 60",
        "[IO.File]::WriteAllText($setup, 'invalid installer fixture')",
    );
    let output = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script])
        .env("WONREMOTE_ZOOK_EXE", r"C:\not-installed-zook-test\ZOOKServer.exe")
        .creation_flags(super::super::CREATE_NO_WINDOW).output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("checksum mismatch"), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn validates_and_applies_only_ready_controls_with_atomic_number_storage() {
    assert_eq!(run_cli(&["--configure-zook".into(), "00123456".into()]), Some(1));
    assert_eq!(run_cli(&["--agent".into(), "--configure-zook".into(), "invalid".into()]), Some(1));
    assert_eq!(run_cli(&["--agent".into()]), None);
    assert_eq!(formatted_number("00123456").unwrap(), "014-0012-3456");
    for bad in ["", "1234567", "123456789", "１２３４５６７８", "1234abcd", "1234-5678"] { assert!(formatted_number(bad).is_err()); }
    let (window, worker) = fake_window(false);
    let number = unsafe { GetDlgItem(window, 1003) };
    assert!(apply_number(window, "123", Duration::ZERO).is_err());
    assert_eq!(read_control(number).unwrap(), "original");
    unsafe { enable_test_control(number, false); }
    assert!(apply_number(window, "00123456", Duration::ZERO).unwrap_err().contains("이미"));
    assert_eq!(read_control(number).unwrap(), "original");
    unsafe { enable_test_control(number, true); }
    unsafe {
        enable_test_control(number, false);
        enable_test_control(GetDlgItem(window, 1005), false);
        SetWindowTextW(GetDlgItem(window, 1001), wide("접속 종료").as_ptr());
    }
    assert!(apply_number(window, "00123456", Duration::ZERO).is_err());
    assert_eq!(read_control(number).unwrap(), "original");
    assert_eq!(unsafe { GetWindowLongW(window, GWLP_USERDATA) }, 0, "unknown connected state must not be clicked");
    unsafe {
        enable_test_control(number, true);
        enable_test_control(GetDlgItem(window, 1005), true);
        SetWindowTextW(GetDlgItem(window, 1001), wide("접속 대기").as_ptr());
    }
    assert_eq!(apply_number(window, "00123456", Duration::from_secs(2)).unwrap(), "014-0012-3456");
    assert_eq!(read_control(unsafe { GetDlgItem(window, 1005) }).unwrap(), "1234");
    assert!(!enabled(number));
    assert_eq!(apply_number(window, "00876543", Duration::from_secs(2)).unwrap(), "014-0087-6543");
    assert_eq!(read_control(number).unwrap(), "014-0087-6543");
    assert_eq!(unsafe { GetWindowLongW(window, GWLP_USERDATA) }, 3, "one initial start, one cancellation, one replacement start");
    unsafe { PostMessageW(window, WM_CLOSE, 0, 0); }
    worker.join().unwrap();
    let (window, worker) = fake_window(true);
    let number = unsafe { GetDlgItem(window, 1003) };
    let password = unsafe { GetDlgItem(window, 1005) };
    unsafe {
        enable_test_control(number, false);
        enable_test_control(password, false);
        SetWindowTextW(GetDlgItem(window, 1001), wide("대기취소 하기").as_ptr());
    }
    assert!(apply_number(window, "00123456", Duration::from_millis(150)).unwrap_err().contains("취소"));
    assert_eq!(read_control(number).unwrap(), "original", "failed cancellation must not write replacement number");
    assert_eq!(read_control(password).unwrap(), "old");
    assert_eq!(unsafe { GetWindowLongW(window, GWLP_USERDATA) }, 1, "no cancellation retry or replacement start after timeout");
    unsafe { PostMessageW(window, WM_CLOSE, 0, 0); }
    worker.join().unwrap();
    let (window, worker) = fake_window(true);
    assert!(apply_number(window, "00123456", Duration::from_millis(150)).unwrap_err().contains("확인하지"));
    assert!(enabled(unsafe { GetDlgItem(window, 1003) }));
    unsafe { PostMessageW(window, WM_CLOSE, 0, 0); }
    worker.join().unwrap();
    let dir = env::temp_dir().join(format!("wonremote-zook-test-{}", std::process::id()));
    let path = dir.join("zook-number.json");
    assert_eq!(read_number(&path).unwrap(), "");
    save_number(&path, "00123456").unwrap();
    assert_eq!(read_number(&path).unwrap(), "00123456");
    save_number(&path, "87654321").unwrap();
    assert_eq!(read_number(&path).unwrap(), "87654321");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_file(path).unwrap();
    fs::remove_dir(dir).unwrap();
    let lock = CONFIGURING.lock().unwrap();
    assert!(CONFIGURING.try_lock().is_err());
    drop(lock);
}

#[test]
#[ignore = "Read-only observation; does not call standby replacement"]
fn inspect_installed_waiting_without_changes() {
    let window = find_window().unwrap();
    let number = control(window, 1003, "Edit").unwrap();
    let before = read_control(number).unwrap();
    assert!(!enabled(number), "Keep this test read-only: ZOOK must already be waiting");
    assert!(read_control(control(window, 1001, "Button").unwrap()).unwrap().contains("취소"));
    assert_eq!(read_control(number).unwrap(), before);
}

#[test]
#[ignore = "Read-only inspection of the installed ZOOK window"]
fn inspect_installed_controls() {
    unsafe extern "system" fn inspect(window: HWND, _: LPARAM) -> BOOL {
        let mut class = [0u16; 128];
        let count = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
        let class = String::from_utf16_lossy(&class[..count.max(0) as usize]);
        let password = class == "Edit" && GetWindowLongW(window, GWL_STYLE) & 0x20 != 0;
        let mut buffer = [0u16; 256];
        let mut length = 0;
        if !password { SendMessageTimeoutW(window, WM_GETTEXT, buffer.len(), buffer.as_mut_ptr() as LPARAM, SMTO_ABORTIFHUNG, 500, &mut length); }
        println!("id={} class={} visible={} enabled={} text={}", GetDlgCtrlID(window), class,
            IsWindowVisible(window), enabled(window), if password { "<password>".into() } else { String::from_utf16_lossy(&buffer[..length.min(255)]) });
        1
    }
    let window = find_window().expect("Installed ZOOK window");
    unsafe { EnumChildWindows(window, Some(inspect), 0); }
}
