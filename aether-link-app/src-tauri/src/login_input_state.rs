use serde::Serialize;
use std::{mem::size_of, ptr};
use tauri::WebviewWindow;
use windows_sys::Win32::{
    Foundation::HWND,
    UI::{
        Input::KeyboardAndMouse::{GetKeyState, GetKeyboardLayout, VK_CAPITAL},
        WindowsAndMessaging::{
            GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, SendMessageTimeoutW,
            GUITHREADINFO, SMTO_ABORTIFHUNG, SMTO_BLOCK,
        },
    },
};

#[link(name = "imm32")]
extern "system" {
    fn ImmGetDefaultIMEWnd(window: HWND) -> HWND;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInputState {
    caps_lock: Option<bool>,
    input_mode: &'static str,
}

fn input_mode(language: u16, open: Option<usize>, conversion: Option<usize>) -> &'static str {
    match language & 0x3ff {
        0 => "unknown",
        0x09 => "en",
        0x12 => match (open, conversion) {
            (Some(open), Some(mode)) => {
                if open != 0 && mode & 1 != 0 {
                    "ko"
                } else {
                    "en"
                }
            }
            _ => "unknown",
        },
        _ => "other",
    }
}

unsafe fn ime_value(window: HWND, command: usize) -> Option<usize> {
    if window.is_null() {
        return None;
    }
    let mut value = 0;
    if SendMessageTimeoutW(
        window,
        0x0283,
        command,
        0,
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        50,
        &mut value,
    ) == 0
    {
        None
    } else {
        Some(value)
    }
}

#[tauri::command]
pub fn get_login_input_state(window: WebviewWindow) -> Result<LoginInputState, String> {
    let own = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_null() || foreground != own {
            return Ok(LoginInputState {
                caps_lock: None,
                input_mode: "unknown",
            });
        }
        let thread = GetWindowThreadProcessId(foreground, ptr::null_mut());
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = size_of::<GUITHREADINFO>() as u32;
        let focused = if GetGUIThreadInfo(thread, &mut info) != 0 && !info.hwndFocus.is_null() {
            info.hwndFocus
        } else {
            foreground
        };
        let language =
            GetKeyboardLayout(GetWindowThreadProcessId(focused, ptr::null_mut())) as usize as u16;
        let ime = if language & 0x3ff == 0x12 {
            ImmGetDefaultIMEWnd(focused)
        } else {
            ptr::null_mut()
        };
        Ok(LoginInputState {
            caps_lock: Some(GetKeyState(VK_CAPITAL as i32) & 1 != 0),
            input_mode: input_mode(language, ime_value(ime, 5), ime_value(ime, 1)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn login_mode_distinguishes_conversion_from_layout_and_never_guesses_on_failure() {
        assert_eq!(input_mode(0x0412, Some(1), Some(1)), "ko");
        assert_eq!(input_mode(0x0412, Some(1), Some(0)), "en");
        assert_eq!(input_mode(0x0412, Some(0), Some(1)), "en");
        assert_eq!(input_mode(0x0412, None, Some(1)), "unknown");
        assert_eq!(input_mode(0x0409, None, None), "en");
        assert_eq!(input_mode(0x0411, None, None), "other");
        assert_eq!(input_mode(0, None, None), "unknown");
    }
}
