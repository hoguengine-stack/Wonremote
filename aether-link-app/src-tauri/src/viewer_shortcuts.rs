use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

fn shortcut_url(shortcut: &str) -> Result<&'static str, String> {
    match shortcut {
        "edge" => Ok("https://c2rsetup.officeapps.live.com/c2r/downloadEdge.aspx?platform=Default&source=EdgeStablePage&Channel=Stable&language=ko&Consent=0&brand=M100"),
        "asp" => Ok("https://asp.firstpos.co.kr/login/login_form.do"),
        _ => Err("허용되지 않은 바로가기입니다.".into()),
    }
}

#[tauri::command]
pub fn open_viewer_shortcut(shortcut: String) -> Result<(), String> {
    if super::launched_as_agent() { return Err("뷰어에서만 사용할 수 있습니다.".into()); }
    let url: Vec<u16> = shortcut_url(&shortcut)?.encode_utf16().chain(Some(0)).collect();
    let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    // Windows resolves the user's HTTPS handler; do not select a browser executable.
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), url.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    if result as isize <= 32 { return Err(format!("기본 브라우저로 바로가기를 열지 못했습니다. 오류 코드: {}", result as isize)); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn viewer_shortcuts_allow_only_the_two_exact_https_targets() {
        assert_eq!(shortcut_url("edge").unwrap(), "https://c2rsetup.officeapps.live.com/c2r/downloadEdge.aspx?platform=Default&source=EdgeStablePage&Channel=Stable&language=ko&Consent=0&brand=M100");
        assert_eq!(shortcut_url("asp").unwrap(), "https://asp.firstpos.co.kr/login/login_form.do");
        for value in ["", "https://example.com", "file:///C:/Windows/notepad.exe", "edge&start calc", "EDGE"] {
            assert!(shortcut_url(value).is_err());
        }
    }
}
