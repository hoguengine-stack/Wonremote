use std::{os::windows::process::CommandExt, path::Path, process::Command};

pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;
pub(crate) const UPDATE_HANDOFF_CREATION_FLAGS: u32 = CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB;

pub(crate) fn spawn_brokered_update_handoff(script_path: &Path) -> Result<(), String> {
    let mut command = Command::new("powershell.exe");
    command
        .args(brokered_update_powershell_args())
        .arg(script_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command.creation_flags(UPDATE_HANDOFF_CREATION_FLAGS);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Agent update broker failed to start PowerShell: {error}"))
}

pub(crate) fn brokered_update_powershell_args() -> [&'static str; 7] {
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
