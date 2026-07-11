mod capturer;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use capturer::{CaptureFrameStatus, DesktopCapturer, DxgiCapturer};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use turbojpeg::{Compressor, Decompressor, Image, PixelFormat, Subsamp};
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation,
    TokenIntegrityLevel, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC_EX, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, VIRTUAL_KEY,
};

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkReport {
    pub schema_version: u32,
    pub generated_at_unix_ms: u128,
    pub source: String,
    pub duration_seconds: f64,
    pub config: BenchmarkConfigReport,
    pub system: SystemInfo,
    pub dxgi: DxgiSelectionInfo,
    pub process: ProcessMetrics,
    pub capture_loop: CaptureLoopStats,
    pub metrics: BenchmarkMetrics,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunMode {
    Benchmark,
    Diagnostics,
    InjectInput { action: String },
    InputServer,
    ListDisplays,
    Stream,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct InputServerRequest {
    id: String,
    action: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct InputServerResponse {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Debug, Clone)]
pub struct BenchmarkConfig {
    pub duration_secs: u64,
    pub output_path: Option<String>,
    pub snapshot_path: String,
    pub loop_sleep_ms: u64,
    pub capture_timeout_ms: u32,
    pub run_mode: RunMode,
    pub output_index: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkConfigReport {
    pub requested_duration_seconds: u64,
    pub output_path: String,
    pub latest_alias_path: String,
    pub snapshot_path: String,
    pub loop_sleep_ms: u64,
    pub capture_timeout_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub cpu_name: String,
    pub total_ram_bytes: u64,
    pub os_caption: String,
    pub os_architecture: String,
    pub os_version: String,
    pub os_build: String,
    pub video_controllers: Vec<VideoControllerInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoControllerInfo {
    pub name: String,
    pub driver_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InputDiagnostics {
    pub win32_error_code: u32,
    pub win32_error_message: String,
    pub elevated: Option<bool>,
    pub integrity_level: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DxgiOutputInfo {
    pub index: u32,
    pub name: String,
    pub adapter_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DxgiSelectionInfo {
    pub adapter_name: String,
    pub output_name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Default)]
pub struct ProcessSample {
    pub cpu_seconds: f64,
    pub user_cpu_seconds: f64,
    pub kernel_cpu_seconds: f64,
    pub working_set_bytes: u64,
    pub private_memory_bytes: u64,
    pub thread_count: u32,
    pub handle_count: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProcessMetrics {
    pub cpu_percent_over_run: f64,
    pub user_cpu_percent_over_run: f64,
    pub kernel_cpu_percent_over_run: f64,
    pub start_cpu_seconds: f64,
    pub end_cpu_seconds: f64,
    pub user_cpu_seconds_delta: f64,
    pub kernel_cpu_seconds_delta: f64,
    pub working_set_bytes: u64,
    pub private_memory_bytes: u64,
    pub thread_count: u32,
    pub handle_count: u32,
    pub logical_processor_count: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CaptureLoopStats {
    pub capture_attempts: u64,
    pub captured_frames: u64,
    pub acquire_timeout_count: u64,
    pub access_lost_count: u64,
    pub capture_error_count: u64,
    pub dirty_frame_count: u64,
    pub clean_frame_count: u64,
    pub dirty_frame_ratio_percent: f64,
    pub simulation_sample_count: u64,
    pub loop_sleep_ms: u64,
    pub capture_timeout_ms: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct LatencyStats {
    pub avg_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct BenchmarkMetrics {
    pub frame_count: u64,
    pub avg_fps: f64,
    pub total_tiles: u32,
    pub avg_dirty_tiles: f64,
    pub dirty_ratio_percent: f64,
    pub avg_actual_jpeg_kb: f64,
    pub avg_actual_bandwidth_kb_s: f64,
    pub bgra_frame_mb: f64,
    pub rgb565_frame_mb: f64,
    pub raw_rgb565_bandwidth_mb_s: f64,
    pub capture: LatencyStats,
    pub rgb565_convert: LatencyStats,
    pub tile_diff: LatencyStats,
    pub actual_dirty_tile_jpeg: LatencyStats,
    pub actual_internal_pipeline: LatencyStats,
    pub sim_b_10_percent_dirty_jpeg_ms: f64,
    pub sim_b_10_percent_dirty_internal_ms: f64,
    pub sim_b_10_percent_dirty_kb: f64,
    pub sim_c_100_percent_dirty_jpeg_ms: f64,
    pub sim_c_100_percent_dirty_internal_ms: f64,
    pub sim_c_100_percent_dirty_kb: f64,
}

pub struct TileDiff {
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    pub cols: u32,
    pub rows: u32,
    pub prev_frame: Option<Vec<u8>>, // RGB565 buffer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_ms_uses_sorted_values_and_ceil_rank() {
        let samples = vec![10_u128, 20, 30, 40, 50];

        assert_eq!(percentile_ms(&samples, 50.0), 0.030);
        assert_eq!(percentile_ms(&samples, 95.0), 0.050);
        assert_eq!(percentile_ms(&samples, 99.0), 0.050);
    }

    #[test]
    fn benchmark_report_serializes_key_metadata() {
        let report = BenchmarkReport {
            schema_version: 1,
            generated_at_unix_ms: 1234,
            source: "unit-test".to_string(),
            duration_seconds: 5.0,
            config: BenchmarkConfigReport {
                requested_duration_seconds: 5,
                output_path: "benchmark_1234_1920x1200.json".to_string(),
                latest_alias_path: "benchmark_results.json".to_string(),
                snapshot_path: "screenshot_poc_tiles.png".to_string(),
                loop_sleep_ms: 1,
                capture_timeout_ms: 16,
            },
            system: SystemInfo {
                cpu_name: "cpu".to_string(),
                total_ram_bytes: 2048,
                os_caption: "Windows".to_string(),
                os_architecture: "64-bit".to_string(),
                os_version: "10.0".to_string(),
                os_build: "26100".to_string(),
                video_controllers: vec![VideoControllerInfo {
                    name: "gpu".to_string(),
                    driver_version: "1.2.3".to_string(),
                }],
            },
            dxgi: DxgiSelectionInfo {
                adapter_name: "adapter".to_string(),
                output_name: "output".to_string(),
                width: 1920,
                height: 1200,
            },
            process: ProcessMetrics::default(),
            capture_loop: CaptureLoopStats::new(1, 16),
            metrics: BenchmarkMetrics::default(),
        };

        let json = serde_json::to_string(&report).unwrap();

        assert!(json.contains("\"schema_version\":1"));
        assert!(json.contains("\"adapter_name\":\"adapter\""));
        assert!(json.contains("\"video_controllers\""));
    }

    #[test]
    fn parse_benchmark_config_accepts_runtime_options() {
        let config = parse_benchmark_config([
            "aether-link-poc",
            "--duration",
            "30",
            "--output",
            "custom.json",
            "--loop-sleep-ms",
            "0",
            "--capture-timeout-ms",
            "8",
        ])
        .unwrap();

        assert_eq!(config.duration_secs, 30);
        assert_eq!(config.output_path.as_deref(), Some("custom.json"));
        assert_eq!(config.loop_sleep_ms, 0);
        assert_eq!(config.capture_timeout_ms, 8);
    }

    #[test]
    fn parse_config_accepts_list_displays_mode() {
        let config =
            parse_benchmark_config(["aether-link-poc", "--mode", "list-displays"]).unwrap();

        assert!(matches!(config.run_mode, RunMode::ListDisplays));
    }

    #[test]
    fn parse_config_accepts_diagnostics_mode() {
        let config = parse_benchmark_config(["wonremote-poc", "--mode", "diagnostics"]).unwrap();

        assert!(matches!(config.run_mode, RunMode::Diagnostics));
    }

    #[test]
    fn parse_config_accepts_persistent_input_server_mode() {
        let config = parse_benchmark_config(["wonremote-poc", "--mode", "input-server"]).unwrap();

        assert!(matches!(config.run_mode, RunMode::InputServer));
    }

    #[test]
    fn input_server_protocol_preserves_ids_and_reports_injection_failures() {
        let success =
            process_input_server_line(r#"{"id":"input-1","action":"keypress A"}"#, |_| Ok(()));
        assert_eq!(
            success,
            InputServerResponse {
                id: "input-1".to_string(),
                ok: true,
                error: None,
            }
        );

        let failure =
            process_input_server_line(r#"{"id":"input-2","action":"keypress A"}"#, |_| {
                Err("SendInput denied".to_string())
            });
        assert_eq!(failure.id, "input-2");
        assert!(!failure.ok);
        assert_eq!(failure.error.as_deref(), Some("SendInput denied"));
    }

    #[test]
    fn input_server_protocol_rejects_malformed_or_oversized_requests() {
        let malformed = process_input_server_line("not-json", |_| Ok(()));
        assert!(!malformed.ok);
        assert_eq!(malformed.id, "");

        let oversized_action = "x".repeat(16 * 1024 + 1);
        let line = serde_json::json!({ "id": "input-3", "action": oversized_action }).to_string();
        let oversized = process_input_server_line(&line, |_| Ok(()));
        assert!(!oversized.ok);
        assert_eq!(oversized.id, "input-3");
    }

    #[test]
    fn gdi_fallback_output_info_preserves_geometry_and_primary_flag() {
        let rect = windows::Win32::Foundation::RECT {
            left: -1024,
            top: 0,
            right: 0,
            bottom: 768,
        };

        let display = display_output_from_rect(
            1,
            "\\\\.\\DISPLAY2".to_string(),
            "GDI monitor fallback".to_string(),
            rect,
            true,
        );

        assert_eq!(display.index, 1);
        assert_eq!(display.name, "\\\\.\\DISPLAY2");
        assert_eq!(display.adapter_name, "GDI monitor fallback");
        assert_eq!(display.x, -1024);
        assert_eq!(display.y, 0);
        assert_eq!(display.width, 1024);
        assert_eq!(display.height, 768);
        assert!(display.primary);
    }

    #[test]
    fn benchmark_output_path_defaults_to_timestamp_and_resolution() {
        assert_eq!(
            benchmark_output_path(None, 1920, 1200, 1780988270010),
            "benchmark_1780988270010_1920x1200.json"
        );
        assert_eq!(
            benchmark_output_path(Some("explicit.json"), 1920, 1200, 1780988270010),
            "explicit.json"
        );
    }

    #[test]
    fn capture_loop_stats_tracks_attempt_outcomes_and_dirty_ratio() {
        let mut stats = CaptureLoopStats::new(1, 16);

        stats.record_frame(true);
        stats.record_frame(false);
        stats.record_timeout();
        stats.record_access_lost();
        stats.record_error();

        assert_eq!(stats.capture_attempts, 5);
        assert_eq!(stats.captured_frames, 2);
        assert_eq!(stats.acquire_timeout_count, 1);
        assert_eq!(stats.access_lost_count, 1);
        assert_eq!(stats.capture_error_count, 1);
        assert_eq!(stats.dirty_frame_count, 1);
        assert_eq!(stats.clean_frame_count, 1);
        assert_eq!(stats.dirty_frame_ratio_percent, 50.0);
    }

    #[test]
    fn keyboard_input_prefers_scancodes_for_system_key_combinations() {
        let input = keyboard_input(VIRTUAL_KEY(0x12), false);
        let key = unsafe { input.Anonymous.ki };

        assert_eq!(key.wVk.0, 0);
        assert_ne!(key.wScan, 0);
        assert_ne!(key.dwFlags.0 & KEYEVENTF_SCANCODE.0, 0);
    }

    #[test]
    fn unicode_keyboard_inputs_emit_utf16_down_and_up_pairs() {
        let inputs = unicode_keyboard_inputs("한😀");

        assert_eq!(inputs.len(), 6);
        for pair in inputs.chunks_exact(2) {
            let down = unsafe { pair[0].Anonymous.ki };
            let up = unsafe { pair[1].Anonymous.ki };
            assert_eq!(down.wVk.0, 0);
            assert_ne!(down.dwFlags.0 & KEYEVENTF_UNICODE.0, 0);
            assert_ne!(up.dwFlags.0 & KEYEVENTF_UNICODE.0, 0);
            assert_ne!(up.dwFlags.0 & KEYEVENTF_KEYUP.0, 0);
        }
    }

    #[test]
    fn absolute_mouse_input_targets_the_virtual_desktop() {
        let input = mouse_input(
            32768,
            32768,
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        );
        let mouse = unsafe { input.Anonymous.mi };

        assert_ne!(mouse.dwFlags.0 & MOUSEEVENTF_ABSOLUTE.0, 0);
        assert_ne!(mouse.dwFlags.0 & MOUSEEVENTF_VIRTUALDESK.0, 0);
    }

    #[test]
    fn input_protocol_rejects_unsafe_pointer_ranges_and_extra_arguments() {
        assert_eq!(parse_absolute_pointer_coordinate("0", "dx").unwrap(), 0);
        assert_eq!(
            parse_absolute_pointer_coordinate("65535", "dy").unwrap(),
            65_535
        );
        assert!(parse_absolute_pointer_coordinate("-1", "dx").is_err());
        assert!(parse_absolute_pointer_coordinate("65536", "dy").is_err());
        assert!(inject_input("move -1 100").is_err());
        assert!(inject_input("mouse-wheel 100 100 12001").is_err());
        assert!(inject_input("paste unexpected").is_err());
        assert!(inject_input("system taskmgr unexpected").is_err());
    }

    #[test]
    fn send_input_failure_message_includes_windows_security_context() {
        let diagnostics = InputDiagnostics {
            win32_error_code: 5,
            win32_error_message: "Access is denied.".to_string(),
            elevated: Some(false),
            integrity_level: Some("Medium".to_string()),
        };

        let message = format_send_input_failure(0, 1, &diagnostics);

        assert!(message.contains("Sent 0 of 1 events"));
        assert!(message.contains("win32_error=5"));
        assert!(message.contains("Access is denied."));
        assert!(message.contains("elevated=false"));
        assert!(message.contains("integrity=Medium"));
        assert!(message.contains("UIPI/UAC"));
    }

    #[test]
    fn environment_diagnostics_do_not_report_a_stale_win32_error() {
        let diagnostics = collect_input_diagnostics(None);

        assert_eq!(diagnostics.win32_error_code, 0);
        assert_eq!(
            diagnostics.win32_error_message,
            "No SendInput failure recorded."
        );
    }

    #[test]
    fn process_metrics_compute_cpu_percent_over_run() {
        let start = ProcessSample {
            cpu_seconds: 2.0,
            user_cpu_seconds: 1.5,
            kernel_cpu_seconds: 0.5,
            working_set_bytes: 100,
            private_memory_bytes: 80,
            thread_count: 3,
            handle_count: 9,
        };
        let end = ProcessSample {
            cpu_seconds: 4.0,
            user_cpu_seconds: 3.0,
            kernel_cpu_seconds: 1.0,
            working_set_bytes: 150,
            private_memory_bytes: 120,
            thread_count: 4,
            handle_count: 10,
        };

        let metrics = ProcessMetrics::from_samples(&start, &end, 10.0, 2);

        assert_eq!(metrics.cpu_percent_over_run, 10.0);
        assert_eq!(metrics.user_cpu_percent_over_run, 7.5);
        assert_eq!(metrics.kernel_cpu_percent_over_run, 2.5);
        assert_eq!(metrics.working_set_bytes, 150);
        assert_eq!(metrics.thread_count, 4);
    }

    #[test]
    fn merge_dirty_tiles_handles_contiguous_and_non_contiguous_runs() {
        let ts = 32;
        let max_merge_width = 128;
        let cols = 10;
        let w = 320;
        let h = 64;

        let dirty = vec![0, 1, 2, 4, 10, 11, 12, 13, 14];
        let merged = merge_dirty_tiles(&dirty, cols, w, h, ts, max_merge_width);

        assert_eq!(merged.len(), 4);
        assert_eq!(
            merged[0],
            MergedTile {
                tx: 0,
                ty: 0,
                x_start: 0,
                y_start: 0,
                tile_w: 96,
                tile_h: 32
            }
        );
        assert_eq!(
            merged[1],
            MergedTile {
                tx: 4,
                ty: 0,
                x_start: 128,
                y_start: 0,
                tile_w: 32,
                tile_h: 32
            }
        );
        assert_eq!(
            merged[2],
            MergedTile {
                tx: 0,
                ty: 1,
                x_start: 0,
                y_start: 32,
                tile_w: 128,
                tile_h: 32
            }
        );
        assert_eq!(
            merged[3],
            MergedTile {
                tx: 4,
                ty: 1,
                x_start: 128,
                y_start: 32,
                tile_w: 32,
                tile_h: 32
            }
        );
    }

    #[test]
    fn merge_dirty_tiles_handles_boundaries_with_non_multiples_of_ts() {
        let ts = 32;
        let max_merge_width = 256;
        let cols = 3;
        let w = 70;
        let h = 32;

        let dirty = vec![0, 1, 2];
        let merged = merge_dirty_tiles(&dirty, cols, w, h, ts, max_merge_width);

        assert_eq!(merged.len(), 1);
        assert_eq!(
            merged[0],
            MergedTile {
                tx: 0,
                ty: 0,
                x_start: 0,
                y_start: 0,
                tile_w: 70,
                tile_h: 32
            }
        );
    }

    #[test]
    fn virtual_key_from_token_supports_remote_keyboard_names() {
        assert_eq!(virtual_key_from_token("A").unwrap().0, 0x41);
        assert_eq!(virtual_key_from_token("Ctrl").unwrap().0, 0x11);
        assert_eq!(virtual_key_from_token("Esc").unwrap().0, 0x1B);
        assert_eq!(virtual_key_from_token("Win").unwrap().0, 0x5B);
        assert_eq!(virtual_key_from_token("F12").unwrap().0, 0x7B);
        assert!(virtual_key_from_token("UnknownKeyName").is_err());
    }

    #[test]
    fn mouse_button_from_token_rejects_unknown_buttons() {
        assert_eq!(mouse_button_from_token("left").unwrap(), MouseButton::Left);
        assert_eq!(
            mouse_button_from_token("middle").unwrap(),
            MouseButton::Middle
        );
        assert_eq!(
            mouse_button_from_token("right").unwrap(),
            MouseButton::Right
        );
        assert!(mouse_button_from_token("side").is_err());
    }

    #[test]
    fn system_command_args_are_whitelisted() {
        assert_eq!(
            system_command_args("taskmgr").unwrap(),
            vec!["/c", "start", "taskmgr"]
        );
        assert_eq!(
            system_command_args("lock").unwrap(),
            vec!["/c", "rundll32.exe", "user32.dll,LockWorkStation"]
        );
        assert!(system_command_args("calc && format").is_err());
    }
}

fn percentile_ms(samples_us: &[u128], percentile: f64) -> f64 {
    if samples_us.is_empty() {
        return 0.0;
    }

    let mut sorted = samples_us.to_vec();
    sorted.sort_unstable();

    let rank = ((percentile / 100.0) * sorted.len() as f64).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[index] as f64 / 1000.0
}

fn latency_stats(samples_us: &[u128]) -> LatencyStats {
    if samples_us.is_empty() {
        return LatencyStats::default();
    }

    let total: u128 = samples_us.iter().copied().sum();
    let max = samples_us.iter().copied().max().unwrap_or(0);

    LatencyStats {
        avg_ms: total as f64 / samples_us.len() as f64 / 1000.0,
        p50_ms: percentile_ms(samples_us, 50.0),
        p95_ms: percentile_ms(samples_us, 95.0),
        p99_ms: percentile_ms(samples_us, 99.0),
        max_ms: max as f64 / 1000.0,
    }
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn powershell_value(script: &str) -> String {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output();

    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => "unknown".to_string(),
    }
}

fn collect_system_info() -> SystemInfo {
    let cpu_name = powershell_value(
        "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)",
    );
    let total_ram_bytes =
        powershell_value("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory")
            .parse::<u64>()
            .unwrap_or(0);
    let os_caption = powershell_value("(Get-CimInstance Win32_OperatingSystem).Caption");
    let os_architecture =
        powershell_value("(Get-CimInstance Win32_OperatingSystem).OSArchitecture");
    let os_version = powershell_value("(Get-CimInstance Win32_OperatingSystem).Version");
    let os_build = powershell_value("(Get-CimInstance Win32_OperatingSystem).BuildNumber");
    let video_output = powershell_value(
        "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.Name)|$($_.DriverVersion)\" }",
    );

    let video_controllers = video_output
        .lines()
        .filter_map(|line| {
            let (name, driver_version) = line.split_once('|')?;
            Some(VideoControllerInfo {
                name: name.trim().to_string(),
                driver_version: driver_version.trim().to_string(),
            })
        })
        .collect();

    SystemInfo {
        cpu_name,
        total_ram_bytes,
        os_caption,
        os_architecture,
        os_version,
        os_build,
        video_controllers,
    }
}

fn list_dxgi_outputs() -> std::result::Result<Vec<DxgiOutputInfo>, String> {
    unsafe {
        let factory: windows::Win32::Graphics::Dxgi::IDXGIFactory1 =
            windows::Win32::Graphics::Dxgi::CreateDXGIFactory1()
                .map_err(|error| format!("CreateDXGIFactory1 failed: {:?}", error))?;
        let adapter: windows::Win32::Graphics::Dxgi::IDXGIAdapter1 = factory
            .EnumAdapters1(0)
            .map_err(|error| format!("EnumAdapters1(0) failed: {:?}", error))?;

        let mut adapter_desc = windows::Win32::Graphics::Dxgi::DXGI_ADAPTER_DESC1::default();
        adapter
            .GetDesc1(&mut adapter_desc)
            .map_err(|error| format!("GetDesc1 failed: {:?}", error))?;
        let adapter_name = utf16_buffer_to_string(&adapter_desc.Description);

        let mut outputs = Vec::new();
        let mut output_index = 0;
        while let Ok(output) = adapter.EnumOutputs(output_index) {
            let mut output_desc = windows::Win32::Graphics::Dxgi::DXGI_OUTPUT_DESC::default();
            output
                .GetDesc(&mut output_desc)
                .map_err(|error| format!("GetDesc failed: {:?}", error))?;
            let rect = output_desc.DesktopCoordinates;
            outputs.push(DxgiOutputInfo {
                index: output_index,
                name: utf16_buffer_to_string(&output_desc.DeviceName),
                adapter_name: adapter_name.clone(),
                x: rect.left,
                y: rect.top,
                width: (rect.right - rect.left).max(0) as u32,
                height: (rect.bottom - rect.top).max(0) as u32,
                primary: rect.left == 0 && rect.top == 0,
            });
            output_index += 1;
        }

        Ok(outputs)
    }
}

fn list_display_outputs() -> std::result::Result<Vec<DxgiOutputInfo>, String> {
    match list_dxgi_outputs() {
        Ok(outputs) if !outputs.is_empty() => Ok(outputs),
        Ok(_) => list_gdi_outputs().map_err(|gdi_error| {
            format!(
                "DXGI returned no outputs; GDI fallback failed: {}",
                gdi_error
            )
        }),
        Err(dxgi_error) => list_gdi_outputs().map_err(|gdi_error| {
            format!(
                "DXGI display enumeration failed: {}; GDI fallback failed: {}",
                dxgi_error, gdi_error
            )
        }),
    }
}

fn list_gdi_outputs() -> std::result::Result<Vec<DxgiOutputInfo>, String> {
    let mut outputs: Vec<DxgiOutputInfo> = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            HDC(0),
            None,
            Some(enum_display_monitor_proc),
            LPARAM((&mut outputs as *mut Vec<DxgiOutputInfo>) as isize),
        )
    };

    if !ok.as_bool() {
        return Err("EnumDisplayMonitors failed".to_string());
    }
    if outputs.is_empty() {
        return Err("EnumDisplayMonitors returned no monitors".to_string());
    }
    Ok(outputs)
}

unsafe extern "system" fn enum_display_monitor_proc(
    monitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let outputs = &mut *(lparam.0 as *mut Vec<DxgiOutputInfo>);
    let mut monitor_info = MONITORINFOEXW::default();
    monitor_info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;

    let ok = GetMonitorInfoW(
        monitor,
        &mut monitor_info as *mut MONITORINFOEXW as *mut MONITORINFO,
    );
    if ok.as_bool() {
        let device_name = utf16_buffer_to_string(&monitor_info.szDevice);
        let primary = (monitor_info.monitorInfo.dwFlags & 0x1) != 0;
        outputs.push(display_output_from_rect(
            outputs.len() as u32,
            if device_name.is_empty() {
                format!("GDI Display {}", outputs.len() + 1)
            } else {
                device_name
            },
            "GDI monitor fallback".to_string(),
            monitor_info.monitorInfo.rcMonitor,
            primary,
        ));
    }

    BOOL(1)
}

fn display_output_from_rect(
    index: u32,
    name: String,
    adapter_name: String,
    rect: RECT,
    primary: bool,
) -> DxgiOutputInfo {
    DxgiOutputInfo {
        index,
        name,
        adapter_name,
        x: rect.left,
        y: rect.top,
        width: (rect.right - rect.left).max(0) as u32,
        height: (rect.bottom - rect.top).max(0) as u32,
        primary,
    }
}

fn utf16_buffer_to_string(buffer: &[u16]) -> String {
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

fn write_benchmark_report(path: &str, report: &BenchmarkReport) -> std::io::Result<()> {
    let mut file = File::create(path)?;
    let json = serde_json::to_string_pretty(report)
        .expect("benchmark report serialization should not fail");
    file.write_all(json.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

impl Default for BenchmarkConfig {
    fn default() -> Self {
        Self {
            duration_secs: 5,
            output_path: None,
            snapshot_path: "screenshot_poc_tiles.png".to_string(),
            loop_sleep_ms: 1,
            capture_timeout_ms: 16,
            run_mode: RunMode::Benchmark,
            output_index: 0,
        }
    }
}

fn parse_benchmark_config<I, S>(args: I) -> Result<BenchmarkConfig, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut config = BenchmarkConfig::default();
    let mut args = args.into_iter().map(Into::into);
    let _ = args.next();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--duration" => {
                config.duration_secs = parse_positive_u64_arg("--duration", args.next())?;
            }
            "--output" => {
                config.output_path = Some(parse_string_arg("--output", args.next())?);
            }
            "--snapshot" => {
                config.snapshot_path = parse_string_arg("--snapshot", args.next())?;
            }
            "--loop-sleep-ms" => {
                config.loop_sleep_ms = parse_u64_arg("--loop-sleep-ms", args.next())?;
            }
            "--capture-timeout-ms" => {
                let value = parse_positive_u64_arg("--capture-timeout-ms", args.next())?;
                config.capture_timeout_ms = u32::try_from(value)
                    .map_err(|_| "--capture-timeout-ms is too large".to_string())?;
            }
            "--mode" => {
                let mode_str = parse_string_arg("--mode", args.next())?;
                match mode_str.as_str() {
                    "benchmark" => {
                        config.run_mode = RunMode::Benchmark;
                    }
                    "diagnostics" => {
                        config.run_mode = RunMode::Diagnostics;
                    }
                    "inject-input" => {
                        config.run_mode = RunMode::InjectInput {
                            action: String::new(),
                        };
                    }
                    "input-server" => {
                        config.run_mode = RunMode::InputServer;
                    }
                    "list-displays" => {
                        config.run_mode = RunMode::ListDisplays;
                    }
                    "stream" => {
                        config.run_mode = RunMode::Stream;
                    }
                    _ => return Err(format!("unknown mode: {}", mode_str)),
                }
            }
            "--action" => {
                let action_str = parse_string_arg("--action", args.next())?;
                config.run_mode = RunMode::InjectInput { action: action_str };
            }
            "--output-index" => {
                let value = parse_u64_arg("--output-index", args.next())?;
                config.output_index =
                    u32::try_from(value).map_err(|_| "--output-index is too large".to_string())?;
            }
            "--help" | "-h" => {
                return Err(benchmark_usage());
            }
            _ => {
                return Err(format!("unknown option: {}\n{}", arg, benchmark_usage()));
            }
        }
    }

    Ok(config)
}

fn parse_string_arg(name: &str, value: Option<String>) -> Result<String, String> {
    let value = value.ok_or_else(|| format!("missing value for {}", name))?;
    if value.trim().is_empty() {
        Err(format!("{} must not be empty", name))
    } else {
        Ok(value)
    }
}

fn parse_u64_arg(name: &str, value: Option<String>) -> Result<u64, String> {
    parse_string_arg(name, value)?
        .parse::<u64>()
        .map_err(|_| format!("{} must be an integer", name))
}

fn parse_positive_u64_arg(name: &str, value: Option<String>) -> Result<u64, String> {
    let value = parse_u64_arg(name, value)?;
    if value == 0 {
        Err(format!("{} must be greater than 0", name))
    } else {
        Ok(value)
    }
}

fn benchmark_usage() -> String {
    "usage: aether-link-poc [--duration seconds] [--output file.json] [--snapshot file.png] [--loop-sleep-ms ms] [--capture-timeout-ms ms] [--mode benchmark|diagnostics|inject-input|input-server|list-displays|stream] [--action command] [--output-index index]".to_string()
}

fn benchmark_output_path(
    explicit: Option<&str>,
    width: u32,
    height: u32,
    timestamp_ms: u128,
) -> String {
    match explicit {
        Some(path) => path.to_string(),
        None => format!("benchmark_{}_{}x{}.json", timestamp_ms, width, height),
    }
}

impl CaptureLoopStats {
    pub fn new(loop_sleep_ms: u64, capture_timeout_ms: u32) -> Self {
        Self {
            loop_sleep_ms,
            capture_timeout_ms,
            ..Self::default()
        }
    }

    pub fn record_frame(&mut self, is_dirty: bool) {
        self.capture_attempts += 1;
        self.captured_frames += 1;
        if is_dirty {
            self.dirty_frame_count += 1;
        } else {
            self.clean_frame_count += 1;
        }
        self.update_dirty_ratio();
    }

    pub fn record_timeout(&mut self) {
        self.capture_attempts += 1;
        self.acquire_timeout_count += 1;
    }

    pub fn record_access_lost(&mut self) {
        self.capture_attempts += 1;
        self.access_lost_count += 1;
    }

    pub fn record_error(&mut self) {
        self.capture_attempts += 1;
        self.capture_error_count += 1;
    }

    pub fn record_simulation_sample(&mut self) {
        self.simulation_sample_count += 1;
    }

    fn update_dirty_ratio(&mut self) {
        self.dirty_frame_ratio_percent = if self.captured_frames > 0 {
            self.dirty_frame_count as f64 / self.captured_frames as f64 * 100.0
        } else {
            0.0
        };
    }
}

impl ProcessMetrics {
    pub fn from_samples(
        start: &ProcessSample,
        end: &ProcessSample,
        elapsed_seconds: f64,
        logical_processor_count: usize,
    ) -> Self {
        let cpu_delta = (end.cpu_seconds - start.cpu_seconds).max(0.0);
        let user_cpu_delta = (end.user_cpu_seconds - start.user_cpu_seconds).max(0.0);
        let kernel_cpu_delta = (end.kernel_cpu_seconds - start.kernel_cpu_seconds).max(0.0);
        let logical_processor_count = logical_processor_count.max(1);
        let cpu_percent_over_run = if elapsed_seconds > 0.0 {
            cpu_delta / elapsed_seconds / logical_processor_count as f64 * 100.0
        } else {
            0.0
        };
        let user_cpu_percent_over_run = if elapsed_seconds > 0.0 {
            user_cpu_delta / elapsed_seconds / logical_processor_count as f64 * 100.0
        } else {
            0.0
        };
        let kernel_cpu_percent_over_run = if elapsed_seconds > 0.0 {
            kernel_cpu_delta / elapsed_seconds / logical_processor_count as f64 * 100.0
        } else {
            0.0
        };

        Self {
            cpu_percent_over_run,
            user_cpu_percent_over_run,
            kernel_cpu_percent_over_run,
            start_cpu_seconds: start.cpu_seconds,
            end_cpu_seconds: end.cpu_seconds,
            user_cpu_seconds_delta: user_cpu_delta,
            kernel_cpu_seconds_delta: kernel_cpu_delta,
            working_set_bytes: end.working_set_bytes,
            private_memory_bytes: end.private_memory_bytes,
            thread_count: end.thread_count,
            handle_count: end.handle_count,
            logical_processor_count,
        }
    }
}

fn collect_process_sample() -> ProcessSample {
    let pid = std::process::id();
    let script = format!(
        "$p = [System.Diagnostics.Process]::GetProcessById({}); \"{{0}}|{{1}}|{{2}}|{{3}}|{{4}}|{{5}}|{{6}}\" -f $p.TotalProcessorTime.TotalSeconds, $p.UserProcessorTime.TotalSeconds, $p.PrivilegedProcessorTime.TotalSeconds, $p.WorkingSet64, $p.PrivateMemorySize64, $p.Threads.Count, $p.HandleCount",
        pid
    );

    parse_process_sample(&powershell_value(&script)).unwrap_or_default()
}

fn parse_process_sample(value: &str) -> Option<ProcessSample> {
    let parts: Vec<&str> = value.trim().split('|').collect();
    if parts.len() != 7 {
        return None;
    }

    Some(ProcessSample {
        cpu_seconds: parts[0].trim().parse().ok()?,
        user_cpu_seconds: parts[1].trim().parse().ok()?,
        kernel_cpu_seconds: parts[2].trim().parse().ok()?,
        working_set_bytes: parts[3].trim().parse().ok()?,
        private_memory_bytes: parts[4].trim().parse().ok()?,
        thread_count: parts[5].trim().parse().ok()?,
        handle_count: parts[6].trim().parse().ok()?,
    })
}

impl TileDiff {
    pub fn new(width: u32, height: u32, tile_size: u32) -> Self {
        let cols = width.div_ceil(tile_size);
        let rows = height.div_ceil(tile_size);
        Self {
            width,
            height,
            tile_size,
            cols,
            rows,
            prev_frame: None,
        }
    }

    /// Compares the current RGB565 frame with the previous one.
    /// Updates the cached previous frame *only* for the dirty tiles in place.
    /// Returns a list of dirty tile indices (flat index) and the time taken (us).
    pub fn get_dirty_tiles(&mut self, current_frame: &[u8]) -> (Vec<usize>, u128) {
        let start = Instant::now();
        let mut dirty_tiles = Vec::new();

        let cols = self.cols as usize;
        let rows = self.rows as usize;
        let width = self.width as usize;
        let height = self.height as usize;
        let tile_size = self.tile_size as usize;

        let prev = match &mut self.prev_frame {
            Some(p) => p,
            None => {
                // First frame: all tiles are dirty
                self.prev_frame = Some(current_frame.to_vec());
                let all_tiles: Vec<usize> = (0..(cols * rows)).collect();
                return (all_tiles, start.elapsed().as_micros());
            }
        };

        // Compare tile-by-tile
        for ty in 0..rows {
            let y_start = ty * tile_size;
            let y_end = std::cmp::min(y_start + tile_size, height);

            for tx in 0..cols {
                let x_start = tx * tile_size;
                let x_end = std::cmp::min(x_start + tile_size, width);
                let tile_w = x_end - x_start;

                let mut is_dirty = false;

                // Scan rows of the current tile in RGB565 (2 bytes per pixel)
                for y in y_start..y_end {
                    let start_idx = (y * width + x_start) * 2;
                    let end_idx = start_idx + tile_w * 2;

                    if current_frame[start_idx..end_idx] != prev[start_idx..end_idx] {
                        is_dirty = true;
                        break;
                    }
                }

                if is_dirty {
                    let tile_idx = ty * cols + tx;
                    dirty_tiles.push(tile_idx);

                    // Update the cached previous frame for this dirty tile only in place
                    for y in y_start..y_end {
                        let start_idx = (y * width + x_start) * 2;
                        let end_idx = start_idx + tile_w * 2;
                        prev[start_idx..end_idx]
                            .copy_from_slice(&current_frame[start_idx..end_idx]);
                    }
                }
            }
        }

        let elapsed = start.elapsed().as_micros();
        (dirty_tiles, elapsed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MergedTile {
    pub tx: usize,
    pub ty: usize,
    pub x_start: usize,
    pub y_start: usize,
    pub tile_w: usize,
    pub tile_h: usize,
}

pub fn merge_dirty_tiles(
    dirty_tiles: &[usize],
    cols: usize,
    w: usize,
    h: usize,
    ts: usize,
    max_merge_width: usize,
) -> Vec<MergedTile> {
    if dirty_tiles.is_empty() {
        return Vec::new();
    }

    let mut sorted_tiles = dirty_tiles.to_vec();
    sorted_tiles.sort_unstable();

    let mut merged = Vec::new();
    let mut current_run: Option<Vec<usize>> = None;

    for &tile_idx in &sorted_tiles {
        let tx = tile_idx % cols;
        let ty = tile_idx / cols;

        if let Some(run) = &mut current_run {
            let last_idx = *run.last().unwrap();
            let last_tx = last_idx % cols;
            let last_ty = last_idx / cols;

            let is_contiguous = ty == last_ty && tx == last_tx + 1;

            let mut within_limit = false;
            if is_contiguous {
                let run_start_tx = run[0] % cols;
                let run_start_x = run_start_tx * ts;
                let current_tile_x_end = tx * ts + ts.min(w.saturating_sub(tx * ts));
                let merged_width = current_tile_x_end.saturating_sub(run_start_x);
                within_limit = merged_width <= max_merge_width;
            }

            if is_contiguous && within_limit {
                run.push(tile_idx);
            } else {
                merged.push(create_merged_tile(run, cols, w, h, ts));
                current_run = Some(vec![tile_idx]);
            }
        } else {
            current_run = Some(vec![tile_idx]);
        }
    }

    if let Some(run) = current_run {
        merged.push(create_merged_tile(&run, cols, w, h, ts));
    }

    merged
}

fn create_merged_tile(run: &[usize], cols: usize, w: usize, h: usize, ts: usize) -> MergedTile {
    let first_idx = run[0];
    let last_idx = *run.last().unwrap();

    let tx_start = first_idx % cols;
    let tx_end = last_idx % cols;
    let ty = first_idx / cols;

    let x_start = tx_start * ts;
    let y_start = ty * ts;

    let x_end = tx_end * ts + ts.min(w.saturating_sub(tx_end * ts));
    let tile_w = x_end.saturating_sub(x_start);
    let tile_h = ts.min(h.saturating_sub(y_start));

    MergedTile {
        tx: tx_start,
        ty,
        x_start,
        y_start,
        tile_w,
        tile_h,
    }
}

/// Helper to convert a 32x32 RGB565 tile to RGB24 format
#[inline(always)]
fn convert_tile_rgb565_to_rgb24(
    current_frame: &[u8],
    width: usize,
    x_start: usize,
    y_start: usize,
    tile_w: usize,
    tile_h: usize,
    dest_rgb24: &mut [u8],
) {
    for y in 0..tile_h {
        let py = y_start + y;
        let row_start_565 = (py * width + x_start) * 2;
        let row_start_24 = y * tile_w * 3;

        for x in 0..tile_w {
            let idx_565 = row_start_565 + x * 2;
            let idx_24 = row_start_24 + x * 3;

            let low = current_frame[idx_565] as u16;
            let high = current_frame[idx_565 + 1] as u16;
            let val = (high << 8) | low;

            let r5 = (val >> 11) & 0x1F;
            let g6 = (val >> 5) & 0x3F;
            let b5 = val & 0x1F;

            // Fast bitwise expansion from 5/6 bits to 8 bits
            dest_rgb24[idx_24] = ((r5 << 3) | (r5 >> 2)) as u8;
            dest_rgb24[idx_24 + 1] = ((g6 << 2) | (g6 >> 4)) as u8;
            dest_rgb24[idx_24 + 2] = ((b5 << 3) | (b5 >> 2)) as u8;
        }
    }
}

fn inject_input(action: &str) -> std::result::Result<(), String> {
    let parts: Vec<&str> = action.split_whitespace().collect();
    if parts.is_empty() {
        return Err("Empty action".to_string());
    }

    match parts[0] {
        "click" | "move" => {
            if parts.len() != 3 {
                return Err("Usage: click/move <dx> <dy>".to_string());
            }
            let dx = parse_absolute_pointer_coordinate(parts[1], "dx")?;
            let dy = parse_absolute_pointer_coordinate(parts[2], "dy")?;

            let is_click = parts[0] == "click";
            if is_click {
                let inputs = [
                    mouse_input(
                        dx,
                        dy,
                        0,
                        MOUSEEVENTF_MOVE
                            | MOUSEEVENTF_ABSOLUTE
                            | MOUSEEVENTF_VIRTUALDESK
                            | MOUSEEVENTF_LEFTDOWN,
                    ),
                    mouse_input(dx, dy, 0, MOUSEEVENTF_LEFTUP),
                ];
                send_inputs(&inputs)?;
            } else {
                let inputs = [mouse_input(
                    dx,
                    dy,
                    0,
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                )];
                send_inputs(&inputs)?;
            }
        }
        "mouse-down" | "mouse-up" => {
            if parts.len() != 4 {
                return Err("Usage: mouse-down/mouse-up <dx> <dy> <left|middle|right>".to_string());
            }
            let dx = parse_absolute_pointer_coordinate(parts[1], "dx")?;
            let dy = parse_absolute_pointer_coordinate(parts[2], "dy")?;
            let button = mouse_button_from_token(parts[3])?;
            let flag = mouse_button_flag(button, parts[0] == "mouse-down");
            let inputs = [mouse_input(
                dx,
                dy,
                0,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | flag,
            )];
            send_inputs(&inputs)?;
        }
        "mouse-wheel" => {
            if parts.len() != 4 {
                return Err("Usage: mouse-wheel <dx> <dy> <delta>".to_string());
            }
            let dx = parse_absolute_pointer_coordinate(parts[1], "dx")?;
            let dy = parse_absolute_pointer_coordinate(parts[2], "dy")?;
            let delta = parts[3].parse::<i32>().map_err(|_| "Invalid wheel delta")?;
            if !(-12_000..=12_000).contains(&delta) {
                return Err("Wheel delta must be between -12000 and 12000".to_string());
            }
            let inputs = [
                mouse_input(
                    dx,
                    dy,
                    0,
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                ),
                mouse_input(0, 0, delta, MOUSEEVENTF_WHEEL),
            ];
            send_inputs(&inputs)?;
        }
        "keypress" => {
            if parts.len() != 2 {
                return Err("Usage: keypress <key_char_or_vk>".to_string());
            }
            let vk = virtual_key_from_token(parts[1])?;
            let inputs = [keyboard_input(vk, false), keyboard_input(vk, true)];
            send_inputs(&inputs)?;
        }
        "key-down" | "key-up" => {
            if parts.len() != 2 {
                return Err("Usage: key-down/key-up <key>".to_string());
            }
            let vk = virtual_key_from_token(parts[1])?;
            let inputs = [keyboard_input(vk, parts[0] == "key-up")];
            send_inputs(&inputs)?;
        }
        "text-base64" => {
            if parts.len() != 2 {
                return Err("Usage: text-base64 <utf8_base64>".to_string());
            }
            let bytes = BASE64_STANDARD
                .decode(parts[1])
                .map_err(|error| format!("Invalid text base64: {error}"))?;
            let text = String::from_utf8(bytes)
                .map_err(|error| format!("Invalid UTF-8 text payload: {error}"))?;
            send_inputs(&unicode_keyboard_inputs(&text))?;
        }
        "paste" => {
            if parts.len() != 1 {
                return Err("Usage: paste".to_string());
            }
            let ctrl = virtual_key_from_token("Ctrl")?;
            let v = virtual_key_from_token("V")?;
            let inputs = [
                keyboard_input(ctrl, false),
                keyboard_input(v, false),
                keyboard_input(v, true),
                keyboard_input(ctrl, true),
            ];
            send_inputs(&inputs)?;
        }
        "key-release-all" | "key_release_all" => {
            if parts.len() != 1 {
                return Err("Usage: key-release-all".to_string());
            }
            // The persistent Agent process expands this command using its pressed-key set.
            // Keep direct CLI execution as a safe no-op for diagnostics.
        }
        "system" => {
            if parts.len() != 2 {
                return Err("Usage: system <command>".to_string());
            }
            let args = system_command_args(parts[1])?;
            Command::new("cmd")
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("system command failed: {}", error))?;
        }
        "ping-color-change" => {
            if parts.len() != 1 {
                return Err("Usage: ping-color-change".to_string());
            }
            let inputs = [
                keyboard_input(VIRTUAL_KEY(0x10), false),
                keyboard_input(VIRTUAL_KEY(0x10), true),
            ];
            send_inputs(&inputs)?;
        }
        _ => return Err(format!("Unknown action: {}", parts[0])),
    }
    Ok(())
}

fn parse_absolute_pointer_coordinate(value: &str, label: &str) -> std::result::Result<i32, String> {
    let coordinate = value
        .parse::<i32>()
        .map_err(|_| format!("Invalid {label}"))?;
    if !(0..=65_535).contains(&coordinate) {
        return Err(format!("{label} must be between 0 and 65535"));
    }
    Ok(coordinate)
}

fn virtual_key_from_token(token: &str) -> std::result::Result<VIRTUAL_KEY, String> {
    if token.len() == 1 {
        let c = token.chars().next().unwrap().to_ascii_uppercase();
        if c.is_ascii_alphanumeric() {
            return Ok(VIRTUAL_KEY(c as u16));
        }
    }

    if let Ok(raw_code) = token.parse::<u16>() {
        return Ok(VIRTUAL_KEY(raw_code));
    }

    let normalized = token.to_ascii_lowercase();
    if let Some(rest) = normalized.strip_prefix('f') {
        if let Ok(number) = rest.parse::<u16>() {
            if (1..=12).contains(&number) {
                return Ok(VIRTUAL_KEY(0x70 + number - 1));
            }
        }
    }

    let vk = match normalized.as_str() {
        "alt" => 0x12,
        "backspace" => 0x08,
        "capslock" => 0x14,
        "ctrl" | "control" => 0x11,
        "delete" | "del" => 0x2E,
        "down" => 0x28,
        "end" => 0x23,
        "enter" | "return" => 0x0D,
        "esc" | "escape" => 0x1B,
        "home" => 0x24,
        "insert" | "ins" => 0x2D,
        "left" => 0x25,
        "numlock" => 0x90,
        "pagedown" => 0x22,
        "pageup" => 0x21,
        "right" => 0x27,
        "shift" => 0x10,
        "space" => 0x20,
        "tab" => 0x09,
        "up" => 0x26,
        "win" | "winleft" | "meta" | "lwin" => 0x5B,
        _ => return Err(format!("Unknown key token: {}", token)),
    };
    Ok(VIRTUAL_KEY(vk))
}

fn mouse_button_from_token(token: &str) -> std::result::Result<MouseButton, String> {
    match token.to_ascii_lowercase().as_str() {
        "left" | "0" => Ok(MouseButton::Left),
        "middle" | "1" => Ok(MouseButton::Middle),
        "right" | "2" => Ok(MouseButton::Right),
        _ => Err(format!("Unknown mouse button: {}", token)),
    }
}

fn mouse_button_flag(
    button: MouseButton,
    down: bool,
) -> windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS {
    match (button, down) {
        (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
        (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
    }
}

fn system_command_args(command: &str) -> std::result::Result<Vec<&'static str>, String> {
    match command {
        "services.msc" => Ok(vec!["/c", "start", "services.msc"]),
        "taskmgr" => Ok(vec!["/c", "start", "taskmgr"]),
        "cmd" => Ok(vec!["/c", "start", "cmd"]),
        "explorer" => Ok(vec!["/c", "start", "explorer"]),
        "devmgmt.msc" => Ok(vec!["/c", "start", "devmgmt.msc"]),
        "lock" => Ok(vec!["/c", "rundll32.exe", "user32.dll,LockWorkStation"]),
        "logoff" => Ok(vec!["/c", "shutdown", "/l"]),
        "restart" => Ok(vec!["/c", "shutdown", "/r", "/t", "0"]),
        "shutdown" => Ok(vec!["/c", "shutdown", "/s", "/t", "0"]),
        _ => Err(format!("Unsupported system command: {}", command)),
    }
}

fn keyboard_input(vk: VIRTUAL_KEY, key_up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC_EX) };
    let use_scancode = scan != 0;
    let mut flags = if key_up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    if use_scancode {
        flags |= KEYEVENTF_SCANCODE;
        if scan & 0xE000 != 0 || is_extended_virtual_key(vk) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
    }

    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: if use_scancode { VIRTUAL_KEY(0) } else { vk },
                wScan: if use_scancode {
                    (scan & 0xFF) as u16
                } else {
                    0
                },
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn unicode_keyboard_inputs(text: &str) -> Vec<INPUT> {
    text.encode_utf16()
        .flat_map(|code_unit| {
            [
                unicode_keyboard_input(code_unit, false),
                unicode_keyboard_input(code_unit, true),
            ]
        })
        .collect()
}

fn unicode_keyboard_input(code_unit: u16, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: code_unit,
                dwFlags: if key_up {
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                } else {
                    KEYEVENTF_UNICODE
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn is_extended_virtual_key(vk: VIRTUAL_KEY) -> bool {
    matches!(
        vk.0,
        0x21 | 0x22 | 0x23 | 0x24 | 0x25 | 0x26 | 0x27 | 0x28 | 0x2D | 0x2E | 0x5B | 0x5C
    )
}

fn mouse_input(
    dx: i32,
    dy: i32,
    mouse_data: i32,
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: mouse_data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_inputs(inputs: &[INPUT]) -> std::result::Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        let diagnostics = collect_input_diagnostics(Some(windows::core::Error::from_win32()));
        return Err(format_send_input_failure(sent, inputs.len(), &diagnostics));
    }
    Ok(())
}

fn format_send_input_failure(sent: u32, expected: usize, diagnostics: &InputDiagnostics) -> String {
    let elevated = diagnostics
        .elevated
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let integrity = diagnostics.integrity_level.as_deref().unwrap_or("unknown");

    format!(
        "SendInput failed. Sent {} of {} events. win32_error={} ({}) elevated={} integrity={}. \
         If this happens only for secure desktops, elevated/admin windows, or shell-level key \
         combinations, treat it as a Windows UIPI/UAC boundary and run the Agent at a matching \
         or higher integrity level.",
        sent,
        expected,
        diagnostics.win32_error_code,
        diagnostics.win32_error_message,
        elevated,
        integrity
    )
}

fn collect_input_diagnostics(win32_error: Option<windows::core::Error>) -> InputDiagnostics {
    let (win32_error_code, win32_error_message) = win32_error
        .map(|error| {
            (
                (error.code().0 as u32) & 0xFFFF,
                error.message().to_string(),
            )
        })
        .unwrap_or((0, "No SendInput failure recorded.".to_string()));

    let (elevated, integrity_level) = current_process_token_diagnostics()
        .map(|diagnostics| (diagnostics.0, diagnostics.1))
        .unwrap_or((None, None));

    InputDiagnostics {
        win32_error_code,
        win32_error_message,
        elevated,
        integrity_level,
    }
}

fn current_process_token_diagnostics() -> Option<(Option<bool>, Option<String>)> {
    let mut token = HANDLE::default();
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return None;
        }
    }

    let elevated = query_token_elevated(token);
    let integrity_level = query_token_integrity_level(token);

    unsafe {
        let _ = CloseHandle(token);
    }

    Some((elevated, integrity_level))
}

fn query_token_elevated(token: HANDLE) -> Option<bool> {
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0_u32;
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };

    result.ok()?;
    Some(elevation.TokenIsElevated != 0)
}

fn query_token_integrity_level(token: HANDLE) -> Option<String> {
    let mut returned = 0_u32;
    let _ = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut returned) };
    if returned == 0 {
        return None;
    }

    let mut buffer = vec![0_u8; returned as usize];
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr().cast()),
            returned,
            &mut returned,
        )
    };
    result.ok()?;

    let label = unsafe { &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL) };
    let sid = label.Label.Sid;
    if sid.is_invalid() {
        return None;
    }

    let sub_authority_count = unsafe { GetSidSubAuthorityCount(sid) };
    if sub_authority_count.is_null() {
        return None;
    }

    let rid_index = unsafe { *sub_authority_count as u32 }.checked_sub(1)?;
    let rid = unsafe {
        let rid_ptr = GetSidSubAuthority(sid, rid_index);
        if rid_ptr.is_null() {
            return None;
        }
        *rid_ptr
    };

    Some(integrity_label_from_rid(rid).to_string())
}

fn integrity_label_from_rid(rid: u32) -> &'static str {
    match rid {
        0x0000_0000..=0x0000_0FFF => "Untrusted",
        0x0000_1000..=0x0000_1FFF => "Low",
        0x0000_2000..=0x0000_2FFF => "Medium",
        0x0000_3000..=0x0000_3FFF => "High",
        0x0000_4000..=0x0000_4FFF => "System",
        0x0000_5000..=u32::MAX => "Protected",
    }
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0;
    while i < data.len() {
        let chunk = &data[i..std::cmp::min(i + 3, data.len())];
        let mut val = 0u32;
        for (j, &b) in chunk.iter().enumerate() {
            val |= (b as u32) << (16 - j * 8);
        }
        for j in 0..=chunk.len() {
            let idx = (val >> (18 - j * 6)) & 0x3F;
            result.push(ALPHABET[idx as usize] as char);
        }
        for _ in chunk.len()..3 {
            result.push('=');
        }
        i += 3;
    }
    result
}

async fn run_streaming_loop(config: BenchmarkConfig) {
    let mut capturer = match DesktopCapturer::new_stream(config.output_index) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Screen capture initialization failed: {:?}", e);
            return;
        }
    };

    let (width, height) = capturer.get_dimensions();
    let (adapter_name, output_name) = capturer.get_selection_names();
    eprintln!(
        "Capture backend: {} / {} ({}x{})",
        adapter_name, output_name, width, height
    );
    let min_loop_sleep_ms = capturer.recommended_min_loop_sleep_ms();
    if min_loop_sleep_ms > 0 && config.loop_sleep_ms < min_loop_sleep_ms {
        eprintln!(
            "Capture backend limited loop sleep from {}ms to {}ms",
            config.loop_sleep_ms, min_loop_sleep_ms
        );
    }
    let tile_size = 32;
    let mut tile_diff = TileDiff::new(width, height, tile_size);

    let mut compressor = Compressor::new().unwrap();
    let _ = compressor.set_quality(85);
    let _ = compressor.set_subsamp(Subsamp::Sub2x2);

    let mut tile_rgb24 = vec![0u8; (width * tile_size * 3) as usize];

    use tokio::io::{AsyncBufReadExt, BufReader};
    let inject_ping_marker = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let inject_ping_marker_clone = inject_ping_marker.clone();

    tokio::spawn(async move {
        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.trim() == "ping-color-change" {
                inject_ping_marker_clone.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });

    loop {
        let loop_start = Instant::now();
        match capturer.capture_frame(config.capture_timeout_ms) {
            Ok(CaptureFrameStatus::Frame { mut rgb565, .. }) => {
                if inject_ping_marker.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    let ts = tile_size as usize;
                    let w = width as usize;
                    for y in 0..ts {
                        for x in 0..ts {
                            let idx = (y * w + x) * 2;
                            if idx + 1 < rgb565.len() {
                                rgb565[idx] = 0x1F;
                                rgb565[idx + 1] = 0xF8;
                            }
                        }
                    }
                }
                let (dirty_tiles, _) = tile_diff.get_dirty_tiles(&rgb565);

                if !dirty_tiles.is_empty() {
                    let mut base64_tiles = Vec::new();
                    let cols = tile_diff.cols as usize;
                    let w = width as usize;
                    let h = height as usize;
                    let ts = tile_size as usize;

                    let merged_tiles = merge_dirty_tiles(&dirty_tiles, cols, w, h, ts, 256);

                    let before_tile_count = dirty_tiles.len();
                    let mut before_jpeg_bytes = 0;
                    let before_start = Instant::now();

                    for &tile_idx in &dirty_tiles {
                        let tx = tile_idx % cols;
                        let ty = tile_idx / cols;
                        let x_start = ts * tx;
                        let y_start = ts * ty;
                        let tile_w = ts.min(w - x_start);
                        let tile_h = ts.min(h - y_start);

                        convert_tile_rgb565_to_rgb24(
                            &rgb565,
                            w,
                            x_start,
                            y_start,
                            tile_w,
                            tile_h,
                            &mut tile_rgb24,
                        );

                        let image = Image {
                            pixels: &tile_rgb24[0..(tile_w * tile_h * 3)],
                            width: tile_w,
                            pitch: tile_w * 3,
                            height: tile_h,
                            format: PixelFormat::RGB,
                        };

                        if let Ok(compressed) = compressor.compress_to_vec(image) {
                            before_jpeg_bytes += compressed.len();
                        }
                    }
                    let before_latency_us = before_start.elapsed().as_micros();

                    let after_tile_count = merged_tiles.len();
                    let mut after_jpeg_bytes = 0;
                    let after_start = Instant::now();

                    for tile in &merged_tiles {
                        convert_tile_rgb565_to_rgb24(
                            &rgb565,
                            w,
                            tile.x_start,
                            tile.y_start,
                            tile.tile_w,
                            tile.tile_h,
                            &mut tile_rgb24,
                        );

                        let image = Image {
                            pixels: &tile_rgb24[0..(tile.tile_w * tile.tile_h * 3)],
                            width: tile.tile_w,
                            pitch: tile.tile_w * 3,
                            height: tile.tile_h,
                            format: PixelFormat::RGB,
                        };

                        if let Ok(compressed) = compressor.compress_to_vec(image) {
                            after_jpeg_bytes += compressed.len();
                            let encoded = base64_encode(&compressed);
                            base64_tiles.push(serde_json::json!({
                                "x": tile.tx,
                                "y": tile.ty,
                                "w": tile.tile_w,
                                "h": tile.tile_h,
                                "data": encoded
                            }));
                        }
                    }
                    let after_latency_us = after_start.elapsed().as_micros();

                    eprintln!(
                        "[Tile Merge Stats] Before -> After | Tiles: {} -> {} | JPEG Encodes: {} -> {} | Payload Bytes: {} -> {} | Encode Latency: {:.3}ms -> {:.3}ms",
                        before_tile_count,
                        after_tile_count,
                        before_tile_count,
                        after_tile_count,
                        before_jpeg_bytes,
                        after_jpeg_bytes,
                        before_latency_us as f64 / 1000.0,
                        after_latency_us as f64 / 1000.0
                    );

                    if !base64_tiles.is_empty() {
                        let msg = serde_json::json!({
                            "type": "frame",
                            "width": width,
                            "height": height,
                            "tiles": base64_tiles,
                            "timestamp": now_unix_ms()
                        });
                        println!("{msg}");
                    }
                }
            }
            Ok(CaptureFrameStatus::Timeout) => {}
            Ok(CaptureFrameStatus::AccessLost) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => {
                eprintln!("Capture error: {:?}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }

        let elapsed = loop_start.elapsed();
        let configured_sleep_ms = if config.loop_sleep_ms > 0 {
            config.loop_sleep_ms
        } else {
            16
        };
        let sleep_ms = configured_sleep_ms.max(min_loop_sleep_ms);
        if elapsed < Duration::from_millis(sleep_ms) {
            tokio::time::sleep(Duration::from_millis(sleep_ms) - elapsed).await;
        }
    }
}

const MAX_INPUT_SERVER_ID_BYTES: usize = 128;
const MAX_INPUT_SERVER_ACTION_BYTES: usize = 16 * 1024;

fn process_input_server_line<F>(line: &str, inject: F) -> InputServerResponse
where
    F: FnOnce(&str) -> std::result::Result<(), String>,
{
    let request = match serde_json::from_str::<InputServerRequest>(line) {
        Ok(request) => request,
        Err(error) => {
            return InputServerResponse {
                id: String::new(),
                ok: false,
                error: Some(format!("Invalid input-server request: {error}")),
            }
        }
    };

    if request.id.is_empty()
        || request.id.len() > MAX_INPUT_SERVER_ID_BYTES
        || request
            .id
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
    {
        return InputServerResponse {
            id: request.id,
            ok: false,
            error: Some("Invalid input-server request id.".to_string()),
        };
    }
    if request.action.is_empty()
        || request.action.len() > MAX_INPUT_SERVER_ACTION_BYTES
        || request
            .action
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
    {
        return InputServerResponse {
            id: request.id,
            ok: false,
            error: Some("Invalid input-server action.".to_string()),
        };
    }

    match inject(&request.action) {
        Ok(()) => InputServerResponse {
            id: request.id,
            ok: true,
            error: None,
        },
        Err(error) => InputServerResponse {
            id: request.id,
            ok: false,
            error: Some(error),
        },
    }
}

async fn run_input_server() -> std::result::Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|error| format!("input-server stdin failed: {error}"))?;
        let Some(line) = line else {
            return Ok(());
        };
        let response = if line.len() > MAX_INPUT_SERVER_ACTION_BYTES + 4 * 1024 {
            InputServerResponse {
                id: String::new(),
                ok: false,
                error: Some("Input-server request is too large.".to_string()),
            }
        } else {
            process_input_server_line(&line, inject_input)
        };
        let serialized = serde_json::to_string(&response)
            .map_err(|error| format!("input-server response serialization failed: {error}"))?;
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{serialized}")
            .map_err(|error| format!("input-server stdout failed: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("input-server stdout flush failed: {error}"))?;
    }
}

#[tokio::main]
async fn main() {
    let config = match parse_benchmark_config(std::env::args()) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("{}", message);
            return;
        }
    };

    match &config.run_mode {
        RunMode::Diagnostics => {
            println!(
                "{}",
                serde_json::to_string(&collect_input_diagnostics(None))
                    .unwrap_or_else(|_| "{}".to_string())
            );
            return;
        }
        RunMode::InjectInput { action } => {
            if action.is_empty() {
                eprintln!("Error: --action is required in inject-input mode");
                std::process::exit(1);
            }
            if let Err(e) = inject_input(action) {
                eprintln!("입력 주입 실패: {}", e);
                std::process::exit(1);
            }
            println!("입력 주입 성공: {}", action);
            return;
        }
        RunMode::InputServer => {
            if let Err(error) = run_input_server().await {
                eprintln!("Persistent input server failed: {error}");
                std::process::exit(1);
            }
            return;
        }
        RunMode::Stream => {
            run_streaming_loop(config).await;
            return;
        }
        RunMode::ListDisplays => {
            match list_display_outputs() {
                Ok(outputs) => {
                    println!(
                        "{}",
                        serde_json::to_string(&outputs).unwrap_or_else(|_| "[]".to_string())
                    );
                }
                Err(error) => {
                    eprintln!("display list failed: {}", error);
                    std::process::exit(1);
                }
            }
            return;
        }
        RunMode::Benchmark => {}
    }

    println!(
        "=== WonRemote PoC 2주차: 32x32 타일 차분(Dirty-Tile) & TurboJPEG 인코더 벤치마크 ==="
    );

    // 1. Initialize DXGI Capturer
    let mut capturer = match DxgiCapturer::new(config.output_index) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("DXGI 캡처 초기화 실패: {:?}", e);
            return;
        }
    };

    let (width, height) = capturer.get_dimensions();
    let (adapter_name, output_name) = capturer.get_selection_names();
    println!("DXGI adapter: {}", adapter_name);
    println!("DXGI output: {}", output_name);
    println!("디스플레이 해상도: {} x {}", width, height);

    let tile_size = 32;
    let mut tile_diff = TileDiff::new(width, height, tile_size);
    println!(
        "타일 설정: {}x{} 픽셀 | 총 타일 수: {} (가로 {}, 세로 {})",
        tile_size,
        tile_size,
        tile_diff.cols * tile_diff.rows,
        tile_diff.cols,
        tile_diff.rows
    );
    println!(
        "벤치마크 테스트 시작 ({}초간 화면 캡처, 타일 차분, TurboJPEG 압축 진행)...",
        config.duration_secs
    );

    // Initialize TurboJPEG Compressor & Decompressor
    let mut compressor = Compressor::new().unwrap();
    let _ = compressor.set_quality(85);
    let _ = compressor.set_subsamp(Subsamp::Sub2x2); // YUV 4:2:0

    let mut decompressor = Decompressor::new().unwrap();

    // Reusable buffers
    let mut tile_rgb24 = vec![0u8; (width * tile_size * 3) as usize];
    let mut decomp_rgb24 = vec![0u8; (width * tile_size * 3) as usize];
    let mut canvas_rgba = vec![0u8; (width * height * 4) as usize];

    // Merge comparison tracking variables
    let mut accum_before_tiles = 0usize;
    let mut accum_after_tiles = 0usize;
    let mut accum_before_bytes = 0usize;
    let mut accum_after_bytes = 0usize;
    let mut accum_before_latency_us = 0u128;
    let mut accum_after_latency_us = 0u128;
    let mut accum_before_encodes = 0usize;
    let mut accum_after_encodes = 0usize;

    let process_start_sample = collect_process_sample();
    let start_test = Instant::now();
    let mut frame_count = 0;
    let mut capture_loop_stats =
        CaptureLoopStats::new(config.loop_sleep_ms, config.capture_timeout_ms);

    // Basic metrics
    let mut total_capture_us = 0u128;
    let mut min_capture_us = u128::MAX;
    let mut max_capture_us = 0u128;

    let mut total_convert_us = 0u128;
    let mut min_convert_us = u128::MAX;
    let mut max_convert_us = 0u128;

    let mut total_diff_us = 0u128;
    let mut min_diff_us = u128::MAX;
    let mut max_diff_us = 0u128;

    // Actual dirty tile metrics
    let mut total_dirty_tiles = 0usize;
    let mut total_actual_compress_us = 0u128;
    let mut total_actual_jpeg_bytes = 0usize;
    let mut capture_samples_us = Vec::new();
    let mut convert_samples_us = Vec::new();
    let mut diff_samples_us = Vec::new();
    let mut actual_compress_samples_us = Vec::new();
    let mut actual_internal_samples_us = Vec::new();

    // Simulation metrics (measured on every 10th frame)
    let mut sim_count = 0;
    let mut total_sim_b_us = 0u128; // 10% dirty tiles
    let mut total_sim_c_us = 0u128; // 100% dirty tiles
    let mut total_sim_b_bytes = 0usize;
    let mut total_sim_c_bytes = 0usize;

    let test_duration = Duration::from_secs(config.duration_secs);
    while start_test.elapsed() < test_duration {
        match capturer.capture_frame(config.capture_timeout_ms) {
            Ok(CaptureFrameStatus::Frame {
                bgra: _bgra,
                rgb565,
                capture_time_us: cap_time_us,
                convert_time_us: conv_time_us,
            }) => {
                frame_count += 1;

                // Track capture and conversion
                capture_samples_us.push(cap_time_us);
                convert_samples_us.push(conv_time_us);
                total_capture_us += cap_time_us;
                min_capture_us = min_capture_us.min(cap_time_us);
                max_capture_us = max_capture_us.max(cap_time_us);

                total_convert_us += conv_time_us;
                min_convert_us = min_convert_us.min(conv_time_us);
                max_convert_us = max_convert_us.max(conv_time_us);

                // Run Tile Difference
                let (dirty_tiles, diff_time_us) = tile_diff.get_dirty_tiles(&rgb565);
                capture_loop_stats.record_frame(!dirty_tiles.is_empty());
                diff_samples_us.push(diff_time_us);
                total_diff_us += diff_time_us;
                min_diff_us = min_diff_us.min(diff_time_us);
                max_diff_us = max_diff_us.max(diff_time_us);

                let cols = tile_diff.cols as usize;
                let w = width as usize;
                let h = height as usize;
                let ts = tile_size as usize;

                let merged_tiles = merge_dirty_tiles(&dirty_tiles, cols, w, h, ts, 256);
                total_dirty_tiles += merged_tiles.len();

                // 1. Measure Before (individual tiles)
                let before_tile_count = dirty_tiles.len();
                let mut before_jpeg_bytes = 0;
                let before_start = Instant::now();
                for &tile_idx in &dirty_tiles {
                    let tx = tile_idx % cols;
                    let ty = tile_idx / cols;
                    let x_start = ts * tx;
                    let y_start = ts * ty;
                    let tile_w = ts.min(w - x_start);
                    let tile_h = ts.min(h - y_start);

                    convert_tile_rgb565_to_rgb24(
                        &rgb565,
                        w,
                        x_start,
                        y_start,
                        tile_w,
                        tile_h,
                        &mut tile_rgb24,
                    );

                    let image = Image {
                        pixels: &tile_rgb24[0..(tile_w * tile_h * 3)],
                        width: tile_w,
                        pitch: tile_w * 3,
                        height: tile_h,
                        format: PixelFormat::RGB,
                    };

                    if let Ok(compressed) = compressor.compress_to_vec(image) {
                        before_jpeg_bytes += compressed.len();
                    }
                }
                let before_latency_us = before_start.elapsed().as_micros();

                // 2. Measure After (merged tiles) and Decompress to canvas
                let after_tile_count = merged_tiles.len();
                let mut after_jpeg_bytes = 0;
                let mut frame_compress_time_us = 0;

                for tile in &merged_tiles {
                    let op_start = Instant::now();
                    convert_tile_rgb565_to_rgb24(
                        &rgb565,
                        w,
                        tile.x_start,
                        tile.y_start,
                        tile.tile_w,
                        tile.tile_h,
                        &mut tile_rgb24,
                    );

                    let image = Image {
                        pixels: &tile_rgb24[0..(tile.tile_w * tile.tile_h * 3)],
                        width: tile.tile_w,
                        pitch: tile.tile_w * 3,
                        height: tile.tile_h,
                        format: PixelFormat::RGB,
                    };

                    if let Ok(compressed) = compressor.compress_to_vec(image) {
                        frame_compress_time_us += op_start.elapsed().as_micros();
                        after_jpeg_bytes += compressed.len();

                        // Decompress and draw to canvas (not timed as compress time)
                        let decomp_image = Image {
                            pixels: &mut decomp_rgb24[0..(tile.tile_w * tile.tile_h * 3)],
                            width: tile.tile_w,
                            pitch: tile.tile_w * 3,
                            height: tile.tile_h,
                            format: PixelFormat::RGB,
                        };
                        if decompressor.decompress(&compressed, decomp_image).is_ok() {
                            for ty_local in 0..tile.tile_h {
                                let canvas_y = tile.y_start + ty_local;
                                let canvas_row_start = canvas_y * w * 4;
                                let tile_row_start = ty_local * tile.tile_w * 3;

                                for tx_local in 0..tile.tile_w {
                                    let canvas_idx =
                                        canvas_row_start + (tile.x_start + tx_local) * 4;
                                    let tile_idx_24 = tile_row_start + tx_local * 3;

                                    canvas_rgba[canvas_idx] = decomp_rgb24[tile_idx_24]; // R
                                    canvas_rgba[canvas_idx + 1] = decomp_rgb24[tile_idx_24 + 1]; // G
                                    canvas_rgba[canvas_idx + 2] = decomp_rgb24[tile_idx_24 + 2]; // B
                                    canvas_rgba[canvas_idx + 3] = 255; // Alpha
                                }
                            }
                        }
                    }
                }

                accum_before_tiles += before_tile_count;
                accum_after_tiles += after_tile_count;
                accum_before_encodes += before_tile_count;
                accum_after_encodes += after_tile_count;
                accum_before_bytes += before_jpeg_bytes;
                accum_after_bytes += after_jpeg_bytes;
                accum_before_latency_us += before_latency_us;
                accum_after_latency_us += frame_compress_time_us;

                println!(
                    "[Benchmark Frame Merge] Frame {}: Before (tiles: {}, bytes: {}, latency: {:.3}ms) | After (tiles: {}, bytes: {}, latency: {:.3}ms)",
                    frame_count,
                    before_tile_count,
                    before_jpeg_bytes,
                    before_latency_us as f64 / 1000.0,
                    after_tile_count,
                    after_jpeg_bytes,
                    frame_compress_time_us as f64 / 1000.0
                );

                let actual_jpeg_bytes = after_jpeg_bytes;

                total_actual_compress_us += frame_compress_time_us;
                total_actual_jpeg_bytes += actual_jpeg_bytes;
                actual_compress_samples_us.push(frame_compress_time_us);
                actual_internal_samples_us
                    .push(cap_time_us + conv_time_us + diff_time_us + frame_compress_time_us);

                // Run Simulation Cases (Case B & C) on every 10th frame to avoid overhead bias
                if frame_count % 10 == 0 {
                    sim_count += 1;
                    capture_loop_stats.record_simulation_sample();
                    let total_tiles = (tile_diff.cols * tile_diff.rows) as usize;

                    // --- Case B: Simulate 10% dirty tiles (compress every 10th tile) ---
                    let sim_b_start = Instant::now();
                    let mut sim_b_bytes = 0;
                    for tile_idx in (0..total_tiles).step_by(10) {
                        let tx = tile_idx % cols;
                        let ty = tile_idx / cols;
                        let x_start = tx * ts;
                        let y_start = ty * ts;
                        let tile_w = ts.min(w - x_start);
                        let tile_h = ts.min(h - y_start);

                        convert_tile_rgb565_to_rgb24(
                            &rgb565,
                            w,
                            x_start,
                            y_start,
                            tile_w,
                            tile_h,
                            &mut tile_rgb24,
                        );

                        let image = Image {
                            pixels: &tile_rgb24[0..(tile_w * tile_h * 3)],
                            width: tile_w,
                            pitch: tile_w * 3,
                            height: tile_h,
                            format: PixelFormat::RGB,
                        };

                        if let Ok(compressed) = compressor.compress_to_vec(image) {
                            sim_b_bytes += compressed.len();
                        }
                    }
                    total_sim_b_us += sim_b_start.elapsed().as_micros();
                    total_sim_b_bytes += sim_b_bytes;

                    // --- Case C: Simulate 100% dirty tiles (compress all tiles) ---
                    let sim_c_start = Instant::now();
                    let mut sim_c_bytes = 0;
                    for tile_idx in 0..total_tiles {
                        let tx = tile_idx % cols;
                        let ty = tile_idx / cols;
                        let x_start = tx * ts;
                        let y_start = ty * ts;
                        let tile_w = ts.min(w - x_start);
                        let tile_h = ts.min(h - y_start);

                        convert_tile_rgb565_to_rgb24(
                            &rgb565,
                            w,
                            x_start,
                            y_start,
                            tile_w,
                            tile_h,
                            &mut tile_rgb24,
                        );

                        let image = Image {
                            pixels: &tile_rgb24[0..(tile_w * tile_h * 3)],
                            width: tile_w,
                            pitch: tile_w * 3,
                            height: tile_h,
                            format: PixelFormat::RGB,
                        };

                        if let Ok(compressed) = compressor.compress_to_vec(image) {
                            sim_c_bytes += compressed.len();
                        }
                    }
                    total_sim_c_us += sim_c_start.elapsed().as_micros();
                    total_sim_c_bytes += sim_c_bytes;
                }
            }
            Ok(CaptureFrameStatus::Timeout) => {
                capture_loop_stats.record_timeout();
            }
            Ok(CaptureFrameStatus::AccessLost) => {
                capture_loop_stats.record_access_lost();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => {
                capture_loop_stats.record_error();
                eprintln!("프레임 캡처 중 오류: {:?}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        if config.loop_sleep_ms > 0 {
            tokio::time::sleep(Duration::from_millis(config.loop_sleep_ms)).await;
        }
    }

    let total_elapsed = start_test.elapsed();
    let process_end_sample = collect_process_sample();
    let logical_processor_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1);
    let process_metrics = ProcessMetrics::from_samples(
        &process_start_sample,
        &process_end_sample,
        total_elapsed.as_secs_f64(),
        logical_processor_count,
    );
    println!("벤치마크 완료!");
    println!("============================================================");
    println!("총 테스트 시간: {:.2?}", total_elapsed);
    println!("캡처된 총 프레임: {} 프레임", frame_count);

    println!("------------------------------------------------------------");
    println!("=== 가로축 타일 병합 최적화 요약 (Before vs After) ===");
    println!(
        "   - 총 타일 개수:        {} -> {}",
        accum_before_tiles, accum_after_tiles
    );
    println!(
        "   - 총 JPEG 인코딩 횟수:  {} -> {}",
        accum_before_encodes, accum_after_encodes
    );
    println!(
        "   - 총 전송 페이로드 크기: {:.2} KB -> {:.2} KB ({:.1}% 절감)",
        accum_before_bytes as f64 / 1024.0,
        accum_after_bytes as f64 / 1024.0,
        if accum_before_bytes > 0 {
            (1.0 - accum_after_bytes as f64 / accum_before_bytes as f64) * 100.0
        } else {
            0.0
        }
    );
    println!(
        "   - 총 인코딩 지연 시간:  {:.3} ms -> {:.3} ms ({:.1}% 단축)",
        accum_before_latency_us as f64 / 1000.0,
        accum_after_latency_us as f64 / 1000.0,
        if accum_before_latency_us > 0 {
            (1.0 - accum_after_latency_us as f64 / accum_before_latency_us as f64) * 100.0
        } else {
            0.0
        }
    );
    println!("------------------------------------------------------------");

    if frame_count > 0 {
        let avg_fps = frame_count as f64 / total_elapsed.as_secs_f64();
        let avg_cap_ms = (total_capture_us as f64 / frame_count as f64) / 1000.0;
        let avg_conv_ms = (total_convert_us as f64 / frame_count as f64) / 1000.0;
        let avg_diff_ms = (total_diff_us as f64 / frame_count as f64) / 1000.0;

        let avg_dirty_tiles = total_dirty_tiles as f64 / frame_count as f64;
        let avg_actual_compress_ms =
            (total_actual_compress_us as f64 / frame_count as f64) / 1000.0;
        let avg_actual_jpeg_kb = (total_actual_jpeg_bytes as f64 / frame_count as f64) / 1024.0;

        // Sim stats
        let avg_sim_b_ms = if sim_count > 0 {
            (total_sim_b_us as f64 / sim_count as f64) / 1000.0
        } else {
            0.0
        };
        let avg_sim_c_ms = if sim_count > 0 {
            (total_sim_c_us as f64 / sim_count as f64) / 1000.0
        } else {
            0.0
        };
        let avg_sim_b_kb = if sim_count > 0 {
            (total_sim_b_bytes as f64 / sim_count as f64) / 1024.0
        } else {
            0.0
        };
        let avg_sim_c_kb = if sim_count > 0 {
            (total_sim_c_bytes as f64 / sim_count as f64) / 1024.0
        } else {
            0.0
        };

        let total_tiles_count = tile_diff.cols * tile_diff.rows;
        let total_tiles = total_tiles_count as f64;
        let dirty_ratio_pct = (avg_dirty_tiles / total_tiles) * 100.0;

        let bgra_raw_mb = (width * height * 4) as f64 / (1024.0 * 1024.0);
        let rgb565_raw_mb = (width * height * 2) as f64 / (1024.0 * 1024.0);
        let bandwidth_raw_mb_s = (width * height * 2) as f64 * avg_fps / (1024.0 * 1024.0);
        let bandwidth_jpeg_kb_s = avg_actual_jpeg_kb * avg_fps;
        let metrics = BenchmarkMetrics {
            frame_count: frame_count as u64,
            avg_fps,
            total_tiles: total_tiles_count,
            avg_dirty_tiles,
            dirty_ratio_percent: dirty_ratio_pct,
            avg_actual_jpeg_kb,
            avg_actual_bandwidth_kb_s: bandwidth_jpeg_kb_s,
            bgra_frame_mb: bgra_raw_mb,
            rgb565_frame_mb: rgb565_raw_mb,
            raw_rgb565_bandwidth_mb_s: bandwidth_raw_mb_s,
            capture: latency_stats(&capture_samples_us),
            rgb565_convert: latency_stats(&convert_samples_us),
            tile_diff: latency_stats(&diff_samples_us),
            actual_dirty_tile_jpeg: latency_stats(&actual_compress_samples_us),
            actual_internal_pipeline: latency_stats(&actual_internal_samples_us),
            sim_b_10_percent_dirty_jpeg_ms: avg_sim_b_ms,
            sim_b_10_percent_dirty_internal_ms: avg_cap_ms
                + avg_conv_ms
                + avg_diff_ms
                + avg_sim_b_ms,
            sim_b_10_percent_dirty_kb: avg_sim_b_kb,
            sim_c_100_percent_dirty_jpeg_ms: avg_sim_c_ms,
            sim_c_100_percent_dirty_internal_ms: avg_cap_ms
                + avg_conv_ms
                + avg_diff_ms
                + avg_sim_c_ms,
            sim_c_100_percent_dirty_kb: avg_sim_c_kb,
        };
        let report_timestamp_ms = now_unix_ms();
        let output_report_path = benchmark_output_path(
            config.output_path.as_deref(),
            width,
            height,
            report_timestamp_ms,
        );
        let latest_alias_path = "benchmark_results.json".to_string();
        let report = BenchmarkReport {
            schema_version: 2,
            generated_at_unix_ms: report_timestamp_ms,
            source: "wonremote-poc-week2".to_string(),
            duration_seconds: total_elapsed.as_secs_f64(),
            config: BenchmarkConfigReport {
                requested_duration_seconds: config.duration_secs,
                output_path: output_report_path.clone(),
                latest_alias_path: latest_alias_path.clone(),
                snapshot_path: config.snapshot_path.clone(),
                loop_sleep_ms: config.loop_sleep_ms,
                capture_timeout_ms: config.capture_timeout_ms,
            },
            system: collect_system_info(),
            dxgi: DxgiSelectionInfo {
                adapter_name: adapter_name.clone(),
                output_name: output_name.clone(),
                width,
                height,
            },
            process: process_metrics,
            capture_loop: capture_loop_stats.clone(),
            metrics,
        };

        match write_benchmark_report(&output_report_path, &report) {
            Ok(_) => println!("{} saved.", output_report_path),
            Err(e) => eprintln!("{} save failed: {:?}", output_report_path, e),
        }
        if output_report_path != latest_alias_path {
            match write_benchmark_report(&latest_alias_path, &report) {
                Ok(_) => println!("{} updated.", latest_alias_path),
                Err(e) => eprintln!("{} update failed: {:?}", latest_alias_path, e),
            }
        }

        println!("평균 프레임레이트(FPS): {:.2} FPS", avg_fps);
        println!("------------------------------------------------------------");
        println!("1. DXGI 캡처 지연 시간 (GPU -> RAM Copy):");
        println!(
            "   - 평균: {:.3} ms | 최소: {:.3} ms | 최대: {:.3} ms",
            avg_cap_ms,
            min_capture_us as f64 / 1000.0,
            max_capture_us as f64 / 1000.0
        );

        println!("2. 16비트 RGB565 변환 지연 시간 (CPU):");
        println!(
            "   - 평균: {:.3} ms | 최소: {:.3} ms | 최대: {:.3} ms",
            avg_conv_ms,
            min_convert_us as f64 / 1000.0,
            max_convert_us as f64 / 1000.0
        );

        println!("3. 32x32 타일 차분(Dirty-Tile) 검출 지연 시간 (CPU):");
        println!(
            "   - 평균: {:.3} ms | 최소: {:.3} ms | 최대: {:.3} ms",
            avg_diff_ms,
            min_diff_us as f64 / 1000.0,
            max_diff_us as f64 / 1000.0
        );

        println!("4. 실제 원격 화면 변경 타일 처리 지표:");
        println!(
            "   - 평균 변경 타일 개수: {:.2}개 / 전체 {:.0}개 ({:.2}%)",
            avg_dirty_tiles, total_tiles, dirty_ratio_pct
        );
        println!(
            "   - 평균 변경 타일 JPEG 압축 지연: {:.3} ms",
            avg_actual_compress_ms
        );
        println!(
            "   - 평균 변경 타일 JPEG 데이터 크기: {:.2} KB",
            avg_actual_jpeg_kb
        );
        println!(
            "   - 평균 합산 내부 지연(DXGI+RGB565+Diff+JPEG): {:.3} ms",
            avg_cap_ms + avg_conv_ms + avg_diff_ms + avg_actual_compress_ms
        );

        println!("------------------------------------------------------------");
        println!("5. CPU 워크로드 시뮬레이션 결과 (부하 예측용):");
        println!("   [Case A] 화면 변화 0% (대기 상태):");
        println!("     - 타일 JPEG 압축 지연: 0.000 ms");
        println!(
            "     - 합산 내부 지연: {:.3} ms",
            avg_cap_ms + avg_conv_ms + avg_diff_ms
        );
        println!("   [Case B] 화면 변화 10% (텍스트 입력 및 스크롤 등 일반 조작):");
        println!("     - 타일 JPEG 압축 지연: {:.3} ms", avg_sim_b_ms);
        println!(
            "     - 합산 내부 지연: {:.3} ms",
            avg_cap_ms + avg_conv_ms + avg_diff_ms + avg_sim_b_ms
        );
        println!("     - 예측 전송 크기 (프레임당): {:.2} KB", avg_sim_b_kb);
        println!("   [Case C] 화면 변화 100% (전체 화면 전환, 스크롤, 동영상 재생):");
        println!("     - 타일 JPEG 압축 지연: {:.3} ms", avg_sim_c_ms);
        println!(
            "     - 합산 내부 지연: {:.3} ms",
            avg_cap_ms + avg_conv_ms + avg_diff_ms + avg_sim_c_ms
        );
        println!(
            "     - 예측 전송 크기 (프레임당): {:.2} KB (원래 RGB565 대비 {:.1}% 크기)",
            avg_sim_c_kb,
            (avg_sim_c_kb * 1024.0 / (width * height * 2) as f64) * 100.0
        );

        println!("------------------------------------------------------------");
        println!("6. 메모리 및 네트워크 전송량 비교:");
        println!("   - 원본 32비트 BGRA 프레임 크기: {:.2} MB", bgra_raw_mb);
        println!(
            "   - 16비트 RGB565 프레임 크기: {:.2} MB (50.0% 절감)",
            rgb565_raw_mb
        );
        println!("   - [금지됨] RGB565 전체 프레임 다이렉트 전송 시 대역폭: {:.2} MB/s (경고: 1920x1200 @ 60fps = 263.67MB/s)", bandwidth_raw_mb_s);
        println!(
            "   - [적용됨] 타일 차분 + JPEG 압축 적용 시 실제 평균 대역폭: {:.2} KB/s ({:.2} MB/s)",
            bandwidth_jpeg_kb_s,
            bandwidth_jpeg_kb_s / 1024.0
        );

        // Save reconstructed tile snapshot to verify visual quality and color fidelity
        let output_path = &config.snapshot_path;
        println!(
            "JPEG 디코딩 후 타일 재조합(Reconstructed Canvas) 스냅샷 저장 중: {}...",
            output_path
        );

        match image::save_buffer(
            output_path,
            &canvas_rgba,
            width,
            height,
            image::ColorType::Rgba8,
        ) {
            Ok(_) => println!(
                "재조합 스냅샷 저장 완료! 이미지 깨짐, 색 왜곡, 경계 크랙 여부를 확인하세요."
            ),
            Err(e) => eprintln!("재조합 스냅샷 저장 실패: {:?}", e),
        }
    } else {
        println!("캡처된 프레임이 없습니다.");
    }
    println!("============================================================");
}
