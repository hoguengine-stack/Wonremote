use crate::BenchmarkConfig;
use serde::{Deserialize, Serialize};
use std::ffi::{c_void, OsStr};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{Error, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    LocalFree, BOOL, ERROR_PIPE_CONNECTED, E_ACCESSDENIED, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
    WAIT_OBJECT_0,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    DuplicateTokenEx, GetTokenInformation, IsWellKnownSid, SecurityImpersonation, TokenPrimary,
    TokenUser, WinLocalSystemSid, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ALL_ACCESS,
    TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Console::{
    SetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_WAIT,
};
use windows::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, SetThreadDesktop,
    DESKTOP_ACCESS_FLAGS, DESKTOP_READOBJECTS, DESKTOP_SWITCHDESKTOP, DESKTOP_WRITEOBJECTS, HDESK,
    UOI_NAME,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_INFORMATION,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, STARTUPINFOW,
};

const BROKER_PIPE_NAME: &str = r"\\.\pipe\WonRemoteSecureCaptureV1";
const WORKER_PIPE_PREFIX: &str = r"\\.\pipe\WonRemoteSecureCaptureWorkerV1-";
const BROKER_PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)";
const WORKER_PIPE_SDDL: &str = "D:P(A;;GA;;;SY)";
const MAX_HANDSHAKE_BYTES: usize = 2_048;
const MAX_INPUT_PROXY_BYTES: usize = 20 * 1024;
static WORKER_PIPE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum SecureBrokerRequest {
    Capture {
        loop_sleep_ms: u64,
        jpeg_quality: i32,
        max_merge_width: usize,
        output_index: u32,
    },
    Input,
}

pub fn run_client(config: &BenchmarkConfig) -> Result<(), String> {
    proxy_worker(SecureBrokerRequest::Capture {
        loop_sleep_ms: config.loop_sleep_ms,
        jpeg_quality: config.jpeg_quality,
        max_merge_width: config.max_merge_width,
        output_index: config.output_index,
    })
}

pub fn run_input_client() -> Result<(), String> {
    proxy_worker(SecureBrokerRequest::Input)
}

fn proxy_worker(request: SecureBrokerRequest) -> Result<(), String> {
    let mut pipe = connect_to_broker()?;
    verify_broker_process(&pipe)?;
    writeln!(
        pipe,
        "{}",
        serde_json::to_string(&request).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())?;
    pipe.flush().map_err(|error| error.to_string())?;
    let response = read_limited_line(&mut pipe).map_err(|error| error.to_string())?;
    if response != "OK" {
        return Err(format!(
            "secure capture broker rejected request: {response}"
        ));
    }

    let mut input_pipe = pipe.try_clone().map_err(|error| error.to_string())?;
    thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut input_pipe);
    });
    io::copy(&mut pipe, &mut io::stdout().lock())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub fn run_broker() -> Result<(), String> {
    let mut first_instance = true;
    loop {
        let mut pipe = create_server_pipe(first_instance)?;
        first_instance = false;
        let connected = unsafe { ConnectNamedPipe(raw_handle(&pipe), None) };
        if let Err(error) = connected {
            if error.code() != ERROR_PIPE_CONNECTED.to_hresult() {
                eprintln!("Secure capture pipe connection failed: {error}");
                continue;
            }
        }
        thread::spawn(move || {
            match verify_client_process(&pipe) {
                Ok(()) => {
                    if let Err(error) = handle_client(&mut pipe) {
                        let _ = writeln!(pipe, "ERR {}", one_line_error(&error));
                        let _ = pipe.flush();
                        eprintln!("Secure worker request failed: {error}");
                    }
                }
                Err(error) => eprintln!("Secure worker peer rejected: {error}"),
            }
            unsafe {
                let _ = DisconnectNamedPipe(raw_handle(&pipe));
            }
        });
    }
}

fn connect_to_broker() -> Result<File, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .open(BROKER_PIPE_NAME)
        {
            Ok(pipe) => return Ok(pipe),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(
                    "secure capture broker requires the protected elevated Agent".to_string(),
                );
            }
            Err(error) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
                if Instant::now() >= deadline {
                    return Err(format!("secure capture broker unavailable: {error}"));
                }
            }
            Err(error) => return Err(format!("secure capture broker unavailable: {error}")),
        }
    }
}

fn create_server_pipe(first_instance: bool) -> Result<File, String> {
    create_named_pipe(BROKER_PIPE_NAME, BROKER_PIPE_SDDL, first_instance, 16)
}

fn create_named_pipe(
    name: &str,
    sddl: &str,
    first_instance: bool,
    max_instances: u32,
) -> Result<File, String> {
    unsafe {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let sddl = wide(OsStr::new(sddl));
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|error| format!("cannot create secure pipe ACL: {error}"))?;
        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: BOOL(0),
        };
        let name = wide(OsStr::new(name));
        let open_mode = if first_instance {
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            PIPE_ACCESS_DUPLEX
        };
        let handle = CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            max_instances,
            64 * 1024,
            64 * 1024,
            2_000,
            Some(&security),
        );
        let create_error = if handle == INVALID_HANDLE_VALUE {
            Some(Error::from_win32())
        } else {
            None
        };
        let _ = LocalFree(HLOCAL(descriptor.0));
        if let Some(error) = create_error {
            return Err(format!("cannot create secure capture pipe: {error}"));
        }
        Ok(File::from_raw_handle(handle.0 as *mut c_void))
    }
}

fn verify_broker_process(pipe: &File) -> Result<(), String> {
    let mut process_id = 0;
    unsafe {
        GetNamedPipeServerProcessId(raw_handle(pipe), &mut process_id)
            .map_err(|error| format!("cannot identify secure capture broker: {error}"))?;
    }
    verify_process_image(process_id)?;
    if !process_is_local_system(process_id)? {
        return Err("secure capture broker is not running as LocalSystem".to_string());
    }
    Ok(())
}

fn verify_client_process(pipe: &File) -> Result<(), String> {
    let mut process_id = 0;
    unsafe {
        GetNamedPipeClientProcessId(raw_handle(pipe), &mut process_id)
            .map_err(|error| format!("cannot identify secure capture client: {error}"))?;
    }
    verify_process_image(process_id)
}

fn verify_process_image(process_id: u32) -> Result<(), String> {
    let actual = process_image_path(process_id)?;
    let expected = std::env::current_exe()
        .map_err(|error| format!("cannot resolve secure capture executable: {error}"))?;
    if !same_executable_path(&actual, &expected.to_string_lossy()) {
        return Err(
            "secure capture peer executable does not match the installed runtime".to_string(),
        );
    }
    Ok(())
}

fn process_image_path(process_id: u32) -> Result<String, String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .map_err(|error| format!("cannot open secure capture peer: {error}"))?;
        let process = owned_handle(process);
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        QueryFullProcessImageNameW(
            raw_handle(&process),
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .map_err(|error| format!("cannot read secure capture peer path: {error}"))?;
        Ok(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

fn process_is_local_system(process_id: u32) -> Result<bool, String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .map_err(|error| format!("cannot open secure capture broker: {error}"))?;
        let process = owned_handle(process);
        let mut token = HANDLE::default();
        OpenProcessToken(raw_handle(&process), TOKEN_QUERY, &mut token)
            .map_err(|error| format!("cannot inspect secure capture broker token: {error}"))?;
        let token = owned_handle(token);
        let mut byte_count = 0;
        let _ = GetTokenInformation(raw_handle(&token), TokenUser, None, 0, &mut byte_count);
        if byte_count < std::mem::size_of::<TOKEN_USER>() as u32 {
            return Err("secure capture broker token has no user information".to_string());
        }
        let word_size = std::mem::size_of::<usize>();
        let mut buffer = vec![0usize; (byte_count as usize).div_ceil(word_size)];
        GetTokenInformation(
            raw_handle(&token),
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut c_void),
            byte_count,
            &mut byte_count,
        )
        .map_err(|error| format!("cannot read secure capture broker identity: {error}"))?;
        let token_user = &*(buffer.as_ptr() as *const TOKEN_USER);
        Ok(IsWellKnownSid(token_user.User.Sid, WinLocalSystemSid).as_bool())
    }
}

fn same_executable_path(left: &str, right: &str) -> bool {
    left.trim_start_matches(r"\\?\")
        .eq_ignore_ascii_case(right.trim_start_matches(r"\\?\"))
}

pub(crate) fn active_input_desktop_is_secure() -> Result<bool, String> {
    unsafe {
        let desktop = match OpenInputDesktop(Default::default(), false, DESKTOP_READOBJECTS) {
            Ok(desktop) => desktop,
            Err(error) if error.code() == E_ACCESSDENIED => return Ok(true),
            Err(error) => return Err(format!("cannot open active input desktop: {error}")),
        };
        let result = input_desktop_name(desktop).map(|name| desktop_name_is_secure(&name));
        let _ = CloseDesktop(desktop);
        result
    }
}

pub struct ActiveInputDesktop {
    desktop: HDESK,
    name: String,
}

impl ActiveInputDesktop {
    pub fn is_secure(&self) -> bool {
        desktop_name_is_secure(&self.name)
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for ActiveInputDesktop {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.desktop);
        }
    }
}

pub fn attach_current_thread_to_active_input_desktop() -> Result<ActiveInputDesktop, String> {
    unsafe {
        let desktop = OpenInputDesktop(
            Default::default(),
            false,
            DESKTOP_ACCESS_FLAGS(
                DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0 | DESKTOP_SWITCHDESKTOP.0,
            ),
        )
        .map_err(|error| format!("cannot open active input desktop for worker: {error}"))?;
        let name = match input_desktop_name(desktop) {
            Ok(name) => name,
            Err(error) => {
                let _ = CloseDesktop(desktop);
                return Err(error);
            }
        };
        if let Err(error) = SetThreadDesktop(desktop) {
            let _ = CloseDesktop(desktop);
            return Err(format!(
                "cannot attach worker thread to active input desktop {name}: {error}"
            ));
        }
        Ok(ActiveInputDesktop { desktop, name })
    }
}

unsafe fn input_desktop_name(desktop: HDESK) -> Result<String, String> {
    let mut byte_count = 0;
    let desktop_handle = HANDLE(desktop.0);
    let _ = GetUserObjectInformationW(desktop_handle, UOI_NAME, None, 0, Some(&mut byte_count));
    if byte_count < std::mem::size_of::<u16>() as u32 {
        return Err("active input desktop has no name".to_string());
    }
    let mut buffer = vec![0u16; (byte_count as usize).div_ceil(2)];
    GetUserObjectInformationW(
        desktop_handle,
        UOI_NAME,
        Some(buffer.as_mut_ptr() as *mut c_void),
        byte_count,
        Some(&mut byte_count),
    )
    .map_err(|error| format!("cannot read active input desktop name: {error}"))?;
    let length = buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(buffer.len());
    Ok(String::from_utf16_lossy(&buffer[..length]))
}

fn desktop_name_is_secure(name: &str) -> bool {
    name.eq_ignore_ascii_case("Winlogon")
}

fn one_line_error(error: &str) -> String {
    error
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n' | '\0'))
        .take(512)
        .collect()
}

fn handle_client(pipe: &mut File) -> Result<(), String> {
    let line = read_limited_line(pipe).map_err(|error| error.to_string())?;
    let request: SecureBrokerRequest =
        serde_json::from_str(&line).map_err(|_| "invalid secure worker request".to_string())?;
    validate_request(&request)?;
    let input_worker = matches!(&request, SecureBrokerRequest::Input);
    let worker = spawn_session_worker(&request)?;
    pipe.write_all(b"OK\n").map_err(|error| error.to_string())?;
    pipe.flush().map_err(|error| error.to_string())?;

    let SecureWorker {
        pipe: mut worker_pipe,
        process,
    } = worker;
    let mut worker_input = worker_pipe.try_clone().map_err(|error| error.to_string())?;
    let mut input_pipe = pipe.try_clone().map_err(|error| error.to_string())?;
    let input_thread = thread::spawn(move || {
        let line_limit = if input_worker {
            MAX_INPUT_PROXY_BYTES
        } else {
            MAX_HANDSHAKE_BYTES
        };
        while let Ok(line) = read_limited_line_with_limit(&mut input_pipe, line_limit) {
            let allowed = if input_worker {
                crate::is_valid_input_server_request_line(&line)
            } else {
                is_capture_control(&line)
            };
            if allowed && writeln!(worker_input, "{line}").is_err() {
                break;
            }
        }
        unsafe {
            let _ = TerminateProcess(raw_handle(&process), 0);
        }
    });
    let result = io::copy(&mut worker_pipe, pipe).map_err(|error| error.to_string());
    unsafe {
        let _ = DisconnectNamedPipe(raw_handle(pipe));
    }
    let _ = input_thread.join();
    result.map(|_| ())
}

fn validate_request(request: &SecureBrokerRequest) -> Result<(), String> {
    if let SecureBrokerRequest::Capture {
        loop_sleep_ms,
        jpeg_quality,
        max_merge_width,
        output_index,
    } = request
    {
        if *loop_sleep_ms > 10_000
            || !(1..=100).contains(jpeg_quality)
            || !(32..=2048).contains(max_merge_width)
            || *output_index > 31
        {
            return Err("secure capture request is outside allowed limits".to_string());
        }
    }
    Ok(())
}

fn is_capture_control(line: &str) -> bool {
    if matches!(line.trim(), "ping-color-change" | "request-keyframe") {
        return true;
    }
    crate::parse_runtime_stream_profile(line).is_some_and(|profile| profile.loop_sleep_ms <= 10_000)
}

fn read_limited_line(stream: &mut File) -> io::Result<String> {
    read_limited_line_with_limit(stream, MAX_HANDSHAKE_BYTES)
}

fn read_limited_line_with_limit(stream: &mut File, limit: usize) -> io::Result<String> {
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while bytes.len() <= limit {
        if stream.read(&mut byte)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "broker closed handshake",
            ));
        }
        if byte[0] == b'\n' {
            return String::from_utf8(bytes)
                .map(|line| line.trim_end_matches('\r').to_string())
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "handshake is not UTF-8"));
        }
        bytes.push(byte[0]);
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "broker handshake is too large",
    ))
}

struct SecureWorker {
    pipe: File,
    process: OwnedHandle,
}

pub struct SecureWorkerTransport {
    _stdin: File,
    _stdout: File,
    _stderr: File,
}

pub fn attach_worker_transport(pipe_name: Option<&str>) -> Result<SecureWorkerTransport, String> {
    let pipe_name = pipe_name
        .filter(|name| is_valid_worker_pipe_name(name))
        .ok_or_else(|| "secure capture worker pipe is missing or invalid".to_string())?;
    let pipe = create_named_pipe(pipe_name, WORKER_PIPE_SDDL, true, 1)?;
    let connected = unsafe { ConnectNamedPipe(raw_handle(&pipe), None) };
    if let Err(error) = connected {
        if error.code() != ERROR_PIPE_CONNECTED.to_hresult() {
            return Err(format!("secure worker pipe connection failed: {error}"));
        }
    }
    verify_worker_broker(&pipe)?;

    let stdin = pipe.try_clone().map_err(|error| error.to_string())?;
    let stdout = pipe.try_clone().map_err(|error| error.to_string())?;
    unsafe {
        SetStdHandle(STD_INPUT_HANDLE, raw_handle(&stdin))
            .map_err(|error| format!("cannot attach secure worker stdin: {error}"))?;
        SetStdHandle(STD_OUTPUT_HANDLE, raw_handle(&stdout))
            .map_err(|error| format!("cannot attach secure worker stdout: {error}"))?;
        SetStdHandle(STD_ERROR_HANDLE, raw_handle(&pipe))
            .map_err(|error| format!("cannot attach secure worker stderr: {error}"))?;
    }
    Ok(SecureWorkerTransport {
        _stdin: stdin,
        _stdout: stdout,
        _stderr: pipe,
    })
}

pub(crate) fn is_valid_worker_pipe_name(name: &str) -> bool {
    let suffix = match name.strip_prefix(WORKER_PIPE_PREFIX) {
        Some(suffix) => suffix,
        None => return false,
    };
    !suffix.is_empty()
        && suffix.len() <= 64
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
}

fn next_worker_pipe_name() -> String {
    format!(
        "{WORKER_PIPE_PREFIX}{}-{}",
        std::process::id(),
        WORKER_PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn connect_to_worker(
    pipe_name: &str,
    worker: &OwnedHandle,
    worker_process_id: u32,
    session_id: u32,
) -> Result<File, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match OpenOptions::new().read(true).write(true).open(pipe_name) {
            Ok(pipe) => {
                verify_worker_process(&pipe, worker_process_id, session_id)?;
                return Ok(pipe);
            }
            Err(error)
                if unsafe { WaitForSingleObject(raw_handle(worker), 0) } == WAIT_OBJECT_0 =>
            {
                return Err(format!(
                    "secure capture worker exited before opening its pipe: {error}"
                ));
            }
            Err(error) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
                if Instant::now() >= deadline {
                    return Err(format!("secure capture worker pipe timed out: {error}"));
                }
            }
            Err(error) => return Err(format!("secure capture worker pipe failed: {error}")),
        }
    }
}

fn verify_worker_broker(pipe: &File) -> Result<(), String> {
    let mut process_id = 0;
    unsafe {
        GetNamedPipeClientProcessId(raw_handle(pipe), &mut process_id)
            .map_err(|error| format!("cannot identify secure worker broker: {error}"))?;
    }
    verify_process_image(process_id)?;
    if !process_is_local_system(process_id)? {
        return Err("secure worker broker is not running as LocalSystem".to_string());
    }
    Ok(())
}

fn verify_worker_process(
    pipe: &File,
    expected_process_id: u32,
    expected_session_id: u32,
) -> Result<(), String> {
    let mut process_id = 0;
    unsafe {
        GetNamedPipeServerProcessId(raw_handle(pipe), &mut process_id)
            .map_err(|error| format!("cannot identify secure capture worker: {error}"))?;
    }
    if process_id != expected_process_id {
        return Err("unexpected process connected to secure worker pipe".to_string());
    }
    verify_process_image(process_id)?;
    if !process_is_local_system(process_id)? {
        return Err("secure capture worker is not running as LocalSystem".to_string());
    }
    let mut session_id = u32::MAX;
    unsafe {
        ProcessIdToSessionId(process_id, &mut session_id)
            .map_err(|error| format!("cannot identify secure worker session: {error}"))?;
    }
    if session_id != expected_session_id {
        return Err("secure capture worker started in the wrong Windows session".to_string());
    }
    Ok(())
}

fn spawn_session_worker(request: &SecureBrokerRequest) -> Result<SecureWorker, String> {
    unsafe {
        let session_id = WTSGetActiveConsoleSessionId();
        if session_id == u32::MAX {
            return Err("no active Windows console session".to_string());
        }
        let winlogon_pid = find_winlogon_process(session_id)?;
        let winlogon_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, winlogon_pid)
            .map_err(|error| format!("cannot open Winlogon process: {error}"))?;
        let winlogon_process = owned_handle(winlogon_process);
        let mut winlogon_token = HANDLE::default();
        OpenProcessToken(
            raw_handle(&winlogon_process),
            TOKEN_ALL_ACCESS,
            &mut winlogon_token,
        )
        .map_err(|error| format!("cannot open Winlogon token: {error}"))?;
        let winlogon_token = owned_handle(winlogon_token);
        let mut worker_token = HANDLE::default();
        DuplicateTokenEx(
            raw_handle(&winlogon_token),
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut worker_token,
        )
        .map_err(|error| format!("cannot duplicate Winlogon token: {error}"))?;
        let worker_token = owned_handle(worker_token);

        let worker_pipe_name = next_worker_pipe_name();
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let command = match request {
            SecureBrokerRequest::Capture {
                loop_sleep_ms,
                jpeg_quality,
                max_merge_width,
                output_index,
            } => format!(
                "\"{}\" --mode secure-stream --secure-worker-pipe {} --loop-sleep-ms {} --jpeg-quality {} --max-merge-width {} --output-index {}",
                executable.display(),
                worker_pipe_name,
                loop_sleep_ms,
                jpeg_quality,
                max_merge_width,
                output_index,
            ),
            SecureBrokerRequest::Input => format!(
                "\"{}\" --mode secure-input-server --secure-worker-pipe {}",
                executable.display(),
                worker_pipe_name,
            ),
        };
        let executable_wide = wide(executable.as_os_str());
        let mut command_wide = wide(OsStr::new(&command));
        let mut desktop = wide(OsStr::new(r"winsta0\Default"));
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR(desktop.as_mut_ptr()),
            ..Default::default()
        };
        let mut process_info = PROCESS_INFORMATION::default();
        CreateProcessAsUserW(
            raw_handle(&worker_token),
            PCWSTR(executable_wide.as_ptr()),
            PWSTR(command_wide.as_mut_ptr()),
            None,
            None,
            false,
            CREATE_NO_WINDOW,
            None,
            PCWSTR::null(),
            &startup,
            &mut process_info,
        )
        .map_err(|error| format!("cannot start secure capture worker: {error}"))?;
        let process = owned_handle(process_info.hProcess);
        let _thread = owned_handle(process_info.hThread);
        let pipe = match connect_to_worker(
            &worker_pipe_name,
            &process,
            process_info.dwProcessId,
            session_id,
        ) {
            Ok(pipe) => pipe,
            Err(error) => {
                let _ = TerminateProcess(raw_handle(&process), 1);
                return Err(error);
            }
        };

        Ok(SecureWorker { pipe, process })
    }
}

unsafe fn find_winlogon_process(session_id: u32) -> Result<u32, String> {
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        .map_err(|error| format!("cannot enumerate Windows processes: {error}"))?;
    let snapshot = owned_handle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if Process32FirstW(raw_handle(&snapshot), &mut entry).is_ok() {
        loop {
            let name_end = entry
                .szExeFile
                .iter()
                .position(|character| *character == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_end]);
            let mut process_session = u32::MAX;
            if name.eq_ignore_ascii_case("winlogon.exe")
                && ProcessIdToSessionId(entry.th32ProcessID, &mut process_session).is_ok()
                && process_session == session_id
            {
                return Ok(entry.th32ProcessID);
            }
            if Process32NextW(raw_handle(&snapshot), &mut entry).is_err() {
                break;
            }
        }
    }
    Err("Winlogon process for the active console session was not found".to_string())
}

fn raw_handle<T: AsRawHandle>(handle: &T) -> HANDLE {
    HANDLE(handle.as_raw_handle() as isize)
}

unsafe fn owned_handle(handle: HANDLE) -> OwnedHandle {
    OwnedHandle::from_raw_handle(handle.0 as *mut c_void)
}

fn wide(value: &OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privileged_requests_are_typed_and_bounded() {
        let request = SecureBrokerRequest::Capture {
            loop_sleep_ms: 33,
            jpeg_quality: 75,
            max_merge_width: 512,
            output_index: 0,
        };
        assert!(validate_request(&request).is_ok());
        assert!(serde_json::to_string(&request)
            .unwrap()
            .contains(r#""kind":"capture""#));
        assert!(validate_request(&SecureBrokerRequest::Input).is_ok());
        assert_eq!(
            serde_json::to_string(&SecureBrokerRequest::Input).unwrap(),
            r#"{"kind":"input"}"#
        );

        let invalid = SecureBrokerRequest::Capture {
            loop_sleep_ms: 33,
            jpeg_quality: 75,
            max_merge_width: 512,
            output_index: 32,
        };
        assert!(validate_request(&invalid).is_err());

        assert!(serde_json::from_str::<SecureBrokerRequest>(
            r#"{"kind":"capture","loop_sleep_ms":33,"jpeg_quality":75,"max_merge_width":512,"output_index":0,"mode":"inject-input"}"#,
        )
        .is_err());
    }

    #[test]
    fn broker_forwards_only_capture_controls() {
        assert!(is_capture_control("request-keyframe"));
        assert!(is_capture_control("ping-color-change"));
        assert!(is_capture_control("set-stream-profile 33 75 512"));
        assert!(!is_capture_control("mouse-down 1 1 left"));
        assert!(!is_capture_control("key-down ControlLeft"));
        assert!(!is_capture_control("set-stream-profile 33 101 512"));
        assert!(!is_capture_control("set-stream-profile 10001 75 512"));
    }

    #[test]
    fn broker_forwards_only_bounded_input_server_envelopes_to_the_system_worker() {
        assert!(crate::is_valid_input_server_request_line(
            r#"{"id":"input-1","action":"mouse-down 1 1 left"}"#
        ));
        assert!(crate::is_valid_input_server_request_line(
            r#"{"id":"input-2","action":"key-down Ctrl"}"#
        ));
        assert!(!crate::is_valid_input_server_request_line(
            r#"{"id":"","action":"key-down Ctrl"}"#
        ));
        assert!(!crate::is_valid_input_server_request_line(
            r#"{"id":"input-3","action":"key-down Ctrl","extra":true}"#
        ));
    }

    #[test]
    fn secure_pipe_is_system_and_administrator_only() {
        assert!(BROKER_PIPE_SDDL.contains(";;;SY"));
        assert!(BROKER_PIPE_SDDL.contains(";;;BA"));
        assert!(!BROKER_PIPE_SDDL.contains(";;;WD"));
        assert!(!BROKER_PIPE_SDDL.contains(";;;AU"));
        assert!(WORKER_PIPE_SDDL.contains(";;;SY"));
        assert!(!WORKER_PIPE_SDDL.contains(";;;BA"));
    }

    #[test]
    fn worker_pipe_name_is_local_unique_and_strict() {
        let first = next_worker_pipe_name();
        let second = next_worker_pipe_name();
        assert!(is_valid_worker_pipe_name(&first));
        assert!(is_valid_worker_pipe_name(&second));
        assert_ne!(first, second);
        assert!(!is_valid_worker_pipe_name(BROKER_PIPE_NAME));
        assert!(!is_valid_worker_pipe_name(
            r"C:\temp\WonRemoteSecureCaptureWorkerV1-1-1"
        ));
        assert!(!is_valid_worker_pipe_name(
            r"\\.\pipe\WonRemoteSecureCaptureWorkerV1-1-../escape"
        ));
    }

    #[test]
    fn worker_named_pipe_carries_controls_and_frames_in_both_directions() {
        let pipe_name = next_worker_pipe_name();
        let server_name = pipe_name.clone();
        let server = thread::spawn(move || {
            let mut pipe = create_named_pipe(&server_name, "D:P(A;;GA;;;WD)", true, 1).unwrap();
            let connected = unsafe { ConnectNamedPipe(raw_handle(&pipe), None) };
            if let Err(error) = connected {
                assert_eq!(error.code(), ERROR_PIPE_CONNECTED.to_hresult());
            }
            assert_eq!(read_limited_line(&mut pipe).unwrap(), "request-keyframe");
            writeln!(pipe, r#"{{"type":"frame","keyframe":true}}"#).unwrap();
            pipe.flush().unwrap();
        });

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut client = loop {
            match OpenOptions::new().read(true).write(true).open(&pipe_name) {
                Ok(pipe) => break pipe,
                Err(error) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                    assert!(
                        Instant::now() < deadline,
                        "worker pipe did not open: {error}"
                    );
                }
                Err(error) => panic!("worker pipe did not open: {error}"),
            }
        };
        writeln!(client, "request-keyframe").unwrap();
        client.flush().unwrap();
        assert_eq!(
            read_limited_line(&mut client).unwrap(),
            r#"{"type":"frame","keyframe":true}"#
        );
        server.join().unwrap();
    }

    #[test]
    fn cross_session_worker_never_inherits_broker_handles() {
        let source = include_str!("secure_capture.rs");
        let spawn = &source[source.find("fn spawn_session_worker").unwrap()
            ..source.find("unsafe fn find_winlogon_process").unwrap()];
        assert!(spawn.contains("--secure-worker-pipe"));
        assert!(spawn.contains("--mode secure-input-server"));
        assert!(spawn.contains(r#"winsta0\Default"#));
        assert!(!spawn.contains("create_inheritable_pipe"));
        assert!(!spawn.contains("STARTF_USESTDHANDLES"));
        assert!(spawn.contains("false,\n            CREATE_NO_WINDOW"));
    }

    #[test]
    fn active_console_workers_attach_to_the_current_input_desktop() {
        let source = include_str!("secure_capture.rs");
        let attachment = &source[source
            .find("pub fn attach_current_thread_to_active_input_desktop")
            .unwrap()
            ..source.find("unsafe fn input_desktop_name").unwrap()];
        assert!(attachment.contains("OpenInputDesktop"));
        assert!(attachment.contains("SetThreadDesktop"));
        assert!(attachment.contains("DESKTOP_SWITCHDESKTOP"));
    }

    #[test]
    fn fresh_worker_thread_can_attach_to_the_live_input_desktop() {
        let name = thread::spawn(|| {
            attach_current_thread_to_active_input_desktop()
                .map(|desktop| desktop.name().to_string())
        })
        .join()
        .unwrap()
        .unwrap();
        assert!(!name.is_empty());
    }

    #[test]
    fn broker_pipe_supports_capture_and_input_clients_at_the_same_time() {
        let pipe_name = next_worker_pipe_name();
        let _first = create_named_pipe(&pipe_name, "D:P(A;;GA;;;WD)", true, 2).unwrap();
        let _second = create_named_pipe(&pipe_name, "D:P(A;;GA;;;WD)", false, 2).unwrap();
    }

    #[test]
    fn peer_path_comparison_is_case_insensitive_but_exact() {
        assert!(same_executable_path(
            r"\\?\C:\Program Files\WonRemote Agent\wonremote-poc.exe",
            r"c:\program files\wonremote agent\wonremote-poc.exe",
        ));
        assert!(!same_executable_path(
            r"C:\Temp\wonremote-poc.exe",
            r"C:\Program Files\WonRemote Agent\wonremote-poc.exe",
        ));
    }

    #[test]
    fn only_the_winlogon_input_desktop_is_classified_as_secure() {
        assert!(desktop_name_is_secure("Winlogon"));
        assert!(desktop_name_is_secure("WINLOGON"));
        assert!(!desktop_name_is_secure("Default"));
        assert!(!desktop_name_is_secure("Screen-saver"));
    }
}
