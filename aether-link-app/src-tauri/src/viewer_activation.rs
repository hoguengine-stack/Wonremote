use std::{ffi::OsStr, io, os::windows::ffi::OsStrExt, ptr};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM},
    System::Threading::GetCurrentProcessId,
    UI::WindowsAndMessaging::{
        EnumWindows, GetPropW, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, SetPropW,
        ShowWindow, SW_RESTORE, SW_SHOW,
    },
};

const VIEWER_WINDOW_PROPERTY: &str = "WonRemote.Viewer.MainWindow.v1";

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

pub fn mark_main_window(window: HWND) -> io::Result<()> {
    mark(window, VIEWER_WINDOW_PROPERTY)
}

fn mark(window: HWND, property: &str) -> io::Result<()> {
    // The property carries only its owning PID, never a command or file path.
    let ok = unsafe {
        SetPropW(
            window,
            wide(property).as_ptr(),
            GetCurrentProcessId() as usize as _,
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct Search {
    property: Vec<u16>,
    window: HWND,
}

unsafe extern "system" fn find_marked_window(window: HWND, parameter: LPARAM) -> i32 {
    let search = &mut *(parameter as *mut Search);
    let marker = GetPropW(window, search.property.as_ptr()) as usize;
    if marker != 0 {
        let mut owner = 0;
        GetWindowThreadProcessId(window, &mut owner);
        if owner != 0 && marker == owner as usize {
            search.window = window;
            return 0;
        }
    }
    1
}

fn activate_with(property: &str, activate: impl FnOnce(HWND) -> bool) -> io::Result<bool> {
    let mut search = Search {
        property: wide(property),
        window: ptr::null_mut(),
    };
    let completed = unsafe {
        EnumWindows(
            Some(find_marked_window),
            &mut search as *mut Search as LPARAM,
        )
    };
    if !search.window.is_null() {
        Ok(activate(search.window))
    } else if completed == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(false)
    }
}

fn restore_command(minimized: bool) -> i32 {
    if minimized {
        SW_RESTORE
    } else {
        SW_SHOW
    }
}

pub fn activate_existing() -> io::Result<bool> {
    activate_with(VIEWER_WINDOW_PROPERTY, |window| unsafe {
        // SW_RESTORE would unnecessarily unmaximize an ordinary maximized Viewer.
        ShowWindow(window, restore_command(IsIconic(window) != 0));
        SetForegroundWindow(window) != 0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WS_OVERLAPPEDWINDOW,
    };

    struct HiddenWindow(HWND);
    impl HiddenWindow {
        fn new() -> Self {
            let window = unsafe {
                CreateWindowExW(
                    0,
                    wide("STATIC").as_ptr(),
                    wide("WonRemote activation fixture").as_ptr(),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    100,
                    100,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            };
            assert!(!window.is_null(), "{}", io::Error::last_os_error());
            Self(window)
        }
    }
    impl Drop for HiddenWindow {
        fn drop(&mut self) {
            unsafe {
                DestroyWindow(self.0);
            }
        }
    }

    fn property() -> String {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        format!(
            "WonRemote.Viewer.Test.{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
    }

    #[test]
    fn restores_only_the_marked_viewer_not_agent_or_decoy() {
        let property = property();
        let viewer = HiddenWindow::new();
        let _agent = HiddenWindow::new();
        assert!(!activate_with(&property, |_| panic!("untagged window selected")).unwrap());
        mark(viewer.0, &property).unwrap();
        let mut selected = ptr::null_mut();
        assert!(activate_with(&property, |window| {
            selected = window;
            true
        })
        .unwrap());
        assert_eq!(selected, viewer.0);
        drop(viewer);
        assert!(!activate_with(&property, |_| panic!("destroyed window selected")).unwrap());
    }

    #[test]
    fn rejects_wrong_owner_and_does_not_turn_focus_failure_into_restart() {
        let property = property();
        let viewer = HiddenWindow::new();
        unsafe {
            SetPropW(
                viewer.0,
                wide(&property).as_ptr(),
                (GetCurrentProcessId() + 1) as usize as _,
            );
        }
        assert!(!activate_with(&property, |_| panic!("wrong owner selected")).unwrap());
        mark(viewer.0, &property).unwrap();
        let mut calls = 0;
        assert!(!activate_with(&property, |window| {
            assert_eq!(window, viewer.0);
            calls += 1;
            false
        })
        .unwrap());
        assert_eq!(calls, 1);
    }

    #[test]
    fn preserves_maximized_state_and_restores_only_when_minimized() {
        assert_eq!(restore_command(false), SW_SHOW);
        assert_eq!(restore_command(true), SW_RESTORE);
    }
}
