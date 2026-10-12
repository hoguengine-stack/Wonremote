use super::{
    absolute_pointer_pixel, held_input_change, input_target_window, needs_broker_input,
    retain_broker_press,
};
use std::collections::HashSet;

#[test]
fn remote_browser_shortcuts_allow_only_fixed_targets() {
    let edge = super::system_command_spec("edge-download").unwrap();
    assert_eq!(edge.program, "explorer.exe");
    assert_eq!(edge.args, &["https://c2rsetup.officeapps.live.com/c2r/downloadEdge.aspx?platform=Default&source=EdgeStablePage&Channel=Stable&language=ko&Consent=0&brand=M100"]);
    let asp = super::system_command_spec("asp-login").unwrap();
    assert_eq!(asp.program, "explorer.exe");
    assert_eq!(asp.args, &["https://asp.firstpos.co.kr/login/login_form.do"]);
    for command in ["asp-login https://example.com", "edge-download & calc", "https://example.com"] {
        assert!(super::system_command_spec(command).is_err());
    }
}

#[test]
fn default_desktop_system_window_uses_broker_but_ordinary_windows_do_not() {
    assert!(needs_broker_input(false, false, Some(0x3000), Some(0x4000)));
    assert!(needs_broker_input(false, false, Some(0x2000), Some(0x3000)));
    assert!(!needs_broker_input(false, false, Some(0x3000), Some(0x2000)));
    assert!(!needs_broker_input(false, false, Some(0x3000), Some(0x3000)));
    assert!(needs_broker_input(false, false, Some(0x3000), None));
    assert!(needs_broker_input(false, true, Some(0x3000), Some(0x2000)));
    assert!(!needs_broker_input(true, true, Some(0x4000), Some(0x4000)));
}

#[test]
fn target_selection_preserves_virtual_screen_coordinates_and_command_scope() {
    assert_eq!(absolute_pointer_pixel(0, -1920, 3840), -1920);
    assert_eq!(absolute_pointer_pixel(32768, -1920, 3840), 0);
    assert_eq!(absolute_pointer_pixel(65535, -1920, 3840), 1919);
    assert_eq!(absolute_pointer_pixel(65535, 0, 1920), 1919);
    assert!(input_target_window("move -1 100").is_err());
    assert!(input_target_window("system taskmgr").unwrap().is_none());
    assert!(input_target_window("input-regression-probe").unwrap().is_none());
    assert_eq!(held_input_change("key-down Ctrl"), Some((17, true)));
    assert_eq!(held_input_change("key-up 17"), Some((17, false)));
    assert_eq!(held_input_change("mouse-down 100 100 left").unwrap().1, true);
    assert!(held_input_change("keypress Ctrl").is_none());
}

#[test]
fn protected_press_survives_target_disappearance_until_successful_release() {
    let mut held = HashSet::new();
    retain_broker_press(&mut held, "key-down Ctrl", true);
    retain_broker_press(&mut held, "mouse-down 100 100 left", true);
    retain_broker_press(&mut held, "key-down 17", true);
    assert_eq!(held.len(), 2);
    retain_broker_press(&mut held, "mouse-up 200 200 left", false);
    assert_eq!(held.len(), 2);
    retain_broker_press(&mut held, "mouse-up 200 200 left", true);
    assert_eq!(held.len(), 1);
    retain_broker_press(&mut held, "key-up 17", true);
    assert!(held.is_empty());
    retain_broker_press(&mut held, "key-down Alt", false);
    assert!(held.is_empty());
}

#[test]
fn live_token_lookup_reads_own_process_integrity_without_injection() {
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, HMENU, WINDOW_EX_STYLE, WINDOW_STYLE,
    };
    let current = super::process_integrity(unsafe { super::GetCurrentProcess() });
    assert!(current.is_some());
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0), windows::core::w!("STATIC"),
            windows::core::w!("WonRemote read-only target test"), WINDOW_STYLE(0),
            0, 0, 0, 0, super::HWND(0), HMENU(0), HINSTANCE(0), None,
        )
    };
    assert_ne!(window.0, 0);
    let target = super::window_integrity(window);
    unsafe { DestroyWindow(window).unwrap(); }
    assert_eq!(target, current);
    assert!(!needs_broker_input(false, false, current, target));
}
