use windows::{
    core::{w, Error, Result},
    Win32::{
        Foundation::{CloseHandle, ERROR_CANCELLED, E_ACCESSDENIED, HANDLE, HWND},
        Security::{
            GetTokenInformation, IsWellKnownSid, TokenUser, WinLocalSystemSid, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            RemoteDesktop::ProcessIdToSessionId,
            Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcessToken},
        },
        UI::{
            Shell::{
                FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM,
                FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, SetForegroundWindow, ShowWindow, CW_USEDEFAULT,
                SW_SHOW, SW_SHOWNORMAL, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_TOPMOST, WS_OVERLAPPED,
                WS_SYSMENU,
            },
        },
    },
};

struct Owner(HWND);
impl Drop for Owner {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

fn create_owner() -> Result<Owner> {
    let owner = Owner(unsafe {
        CreateWindowExW(
            WS_EX_APPWINDOW | WS_EX_TOPMOST,
            w!("STATIC"),
            w!("WonRemote - Select a file to send"),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            440,
            100,
            None,
            None,
            None,
            None,
        )
    });
    if owner.0 .0 == 0 {
        return Err(Error::from_win32());
    }
    Ok(owner)
}

fn interactive_user() -> Result<bool> {
    unsafe {
        let mut session = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut session)?;
        if session == 0 {
            return Ok(false);
        }
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let result = (|| {
            let mut size = 0;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
            let mut buffer = vec![
                0usize;
                (size as usize + std::mem::size_of::<usize>() - 1)
                    / std::mem::size_of::<usize>()
            ];
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                size,
                &mut size,
            )?;
            let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
            Ok(!IsWellKnownSid(user.User.Sid, WinLocalSystemSid).as_bool())
        })();
        let _ = CloseHandle(token);
        result
    }
}

pub fn select_file() -> Result<Option<String>> {
    if !interactive_user()? {
        return Err(Error::new(
            E_ACCESSDENIED,
            "File selection requires an interactive user".into(),
        ));
    }
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)?;
        let _apartment = Apartment;
        // Only this requested modal's owner is topmost; RAII removes it on every exit.
        let owner = create_owner()?;
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetTitle(w!("WonRemote - Select a file to send"))?;
        dialog.SetOptions(
            FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR,
        )?;
        ShowWindow(owner.0, SW_SHOWNORMAL);
        // Node's windowsHide STARTUPINFO can override the first ShowWindow call.
        ShowWindow(owner.0, SW_SHOW);
        let _ = SetForegroundWindow(owner.0);
        match dialog.Show(owner.0) {
            Ok(()) => {
                let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
                let selected = name.to_string();
                CoTaskMemFree(Some(name.0.cast()));
                Ok(Some(selected?))
            }
            Err(error) if error.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0) => {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, IsWindow, IsWindowVisible, GWL_EXSTYLE,
    };

    #[test]
    fn picker_owner_has_taskbar_and_modal_z_order_and_is_destroyed_on_exit() {
        let owner = create_owner().unwrap();
        let window = owner.0;
        unsafe {
            let style = GetWindowLongW(window, GWL_EXSTYLE) as u32;
            assert_ne!(style & WS_EX_APPWINDOW.0, 0);
            assert_ne!(style & WS_EX_TOPMOST.0, 0);
            assert!(!IsWindowVisible(window).as_bool());
        }
        drop(owner);
        assert!(!unsafe { IsWindow(window) }.as_bool());
    }
}
