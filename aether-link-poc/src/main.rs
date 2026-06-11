mod capturer;

use capturer::{CaptureFrameStatus, DxgiCapturer};
use serde::Serialize;
use std::fs::File;
use std::io::Write;
use std::process::Command;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use turbojpeg::{Compressor, Decompressor, Image, PixelFormat, Subsamp};

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
    InjectInput { action: String },
    Stream,
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
        assert_eq!(merged[0], MergedTile { tx: 0, ty: 0, x_start: 0, y_start: 0, tile_w: 96, tile_h: 32 });
        assert_eq!(merged[1], MergedTile { tx: 4, ty: 0, x_start: 128, y_start: 0, tile_w: 32, tile_h: 32 });
        assert_eq!(merged[2], MergedTile { tx: 0, ty: 1, x_start: 0, y_start: 32, tile_w: 128, tile_h: 32 });
        assert_eq!(merged[3], MergedTile { tx: 4, ty: 1, x_start: 128, y_start: 32, tile_w: 32, tile_h: 32 });
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
        assert_eq!(merged[0], MergedTile { tx: 0, ty: 0, x_start: 0, y_start: 0, tile_w: 70, tile_h: 32 });
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
                    "inject-input" => {
                        config.run_mode = RunMode::InjectInput { action: String::new() };
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
                config.output_index = u32::try_from(value)
                    .map_err(|_| "--output-index is too large".to_string())?;
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
    "usage: aether-link-poc [--duration seconds] [--output file.json] [--snapshot file.png] [--loop-sleep-ms ms] [--capture-timeout-ms ms] [--mode benchmark|inject-input|stream] [--action command] [--output-index index]".to_string()
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
        let cols = (width + tile_size - 1) / tile_size;
        let rows = (height + tile_size - 1) / tile_size;
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

    unsafe {
        match parts[0] {
            "click" | "move" => {
                if parts.len() < 3 {
                    return Err("Usage: click/move <dx> <dy>".to_string());
                }
                let dx = parts[1].parse::<i32>().map_err(|_| "Invalid dx")?;
                let dy = parts[2].parse::<i32>().map_err(|_| "Invalid dy")?;

                let is_click = parts[0] == "click";
                if is_click {
                    let inputs = [
                        windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
                            r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_MOUSE,
                            Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                                mi: windows::Win32::UI::Input::KeyboardAndMouse::MOUSEINPUT {
                                    dx,
                                    dy,
                                    mouseData: 0,
                                    dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE | windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_ABSOLUTE | windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_LEFTDOWN,
                                    time: 0,
                                    dwExtraInfo: 0,
                                },
                            },
                        },
                        windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
                            r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_MOUSE,
                            Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                                mi: windows::Win32::UI::Input::KeyboardAndMouse::MOUSEINPUT {
                                    dx,
                                    dy,
                                    mouseData: 0,
                                    dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_LEFTUP,
                                    time: 0,
                                    dwExtraInfo: 0,
                                },
                            },
                        },
                    ];
                    let sent = windows::Win32::UI::Input::KeyboardAndMouse::SendInput(&inputs, std::mem::size_of::<windows::Win32::UI::Input::KeyboardAndMouse::INPUT>() as i32);
                    if sent != inputs.len() as u32 {
                        return Err(format!("SendInput failed. Sent {} of {} events.", sent, inputs.len()));
                    }
                } else {
                    let inputs = [
                        windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
                            r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_MOUSE,
                            Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                                mi: windows::Win32::UI::Input::KeyboardAndMouse::MOUSEINPUT {
                                    dx,
                                    dy,
                                    mouseData: 0,
                                    dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE | windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_ABSOLUTE,
                                    time: 0,
                                    dwExtraInfo: 0,
                                },
                            },
                        },
                    ];
                    let sent = windows::Win32::UI::Input::KeyboardAndMouse::SendInput(&inputs, std::mem::size_of::<windows::Win32::UI::Input::KeyboardAndMouse::INPUT>() as i32);
                    if sent != inputs.len() as u32 {
                        return Err(format!("SendInput failed. Sent {} of {} events.", sent, inputs.len()));
                    }
                }
            }
            "keypress" => {
                if parts.len() < 2 {
                    return Err("Usage: keypress <key_char_or_vk>".to_string());
                }
                let key_str = parts[1];
                let vk = if key_str.len() == 1 {
                    let c = key_str.chars().next().unwrap().to_ascii_uppercase();
                    windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(c as u16)
                } else {
                    let raw_code = key_str.parse::<u16>().map_err(|_| "Invalid key character")?;
                    windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(raw_code)
                };

                let inputs = [
                    windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
                        r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_KEYBOARD,
                        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                            ki: windows::Win32::UI::Input::KeyboardAndMouse::KEYBDINPUT {
                                wVk: vk,
                                wScan: 0,
                                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0),
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                    windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
                        r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_KEYBOARD,
                        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                            ki: windows::Win32::UI::Input::KeyboardAndMouse::KEYBDINPUT {
                                wVk: vk,
                                wScan: 0,
                                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                ];
                let sent = windows::Win32::UI::Input::KeyboardAndMouse::SendInput(&inputs, std::mem::size_of::<windows::Win32::UI::Input::KeyboardAndMouse::INPUT>() as i32);
                if sent != inputs.len() as u32 {
                    return Err(format!("SendInput failed. Sent {} of {} events.", sent, inputs.len()));
                }
            }
            "ping-color-change" => {
                let inputs = [
                    windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
                        r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_KEYBOARD,
                        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                            ki: windows::Win32::UI::Input::KeyboardAndMouse::KEYBDINPUT {
                                wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0x10),
                                wScan: 0,
                                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0),
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                    windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
                        r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_KEYBOARD,
                        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                            ki: windows::Win32::UI::Input::KeyboardAndMouse::KEYBDINPUT {
                                wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0x10),
                                wScan: 0,
                                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                ];
                let sent = windows::Win32::UI::Input::KeyboardAndMouse::SendInput(&inputs, std::mem::size_of::<windows::Win32::UI::Input::KeyboardAndMouse::INPUT>() as i32);
                if sent != inputs.len() as u32 {
                    return Err(format!("SendInput failed. Sent {} of {} events.", sent, inputs.len()));
                }
            }
            _ => return Err(format!("Unknown action: {}", parts[0])),
        }
    }
    Ok(())
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
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
    let mut capturer = match DxgiCapturer::new(config.output_index) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("DXGI 캡처 초기화 실패: {:?}", e);
            return;
        }
    };

    let (width, height) = capturer.get_dimensions();
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
                        println!("{}", msg.to_string());
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
        let sleep_ms = if config.loop_sleep_ms > 0 {
            config.loop_sleep_ms
        } else {
            16
        };
        if elapsed < Duration::from_millis(sleep_ms) {
            tokio::time::sleep(Duration::from_millis(sleep_ms) - elapsed).await;
        }
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
        RunMode::Stream => {
            run_streaming_loop(config).await;
            return;
        }
        RunMode::Benchmark => {}
    }

    println!(
        "=== AetherLink PoC 2주차: 32x32 타일 차분(Dirty-Tile) & TurboJPEG 인코더 벤치마크 ==="
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
                                    let canvas_idx = canvas_row_start + (tile.x_start + tx_local) * 4;
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
    println!("   - 총 타일 개수:        {} -> {}", accum_before_tiles, accum_after_tiles);
    println!("   - 총 JPEG 인코딩 횟수:  {} -> {}", accum_before_encodes, accum_after_encodes);
    println!("   - 총 전송 페이로드 크기: {:.2} KB -> {:.2} KB ({:.1}% 절감)",
        accum_before_bytes as f64 / 1024.0,
        accum_after_bytes as f64 / 1024.0,
        if accum_before_bytes > 0 {
            (1.0 - accum_after_bytes as f64 / accum_before_bytes as f64) * 100.0
        } else {
            0.0
        }
    );
    println!("   - 총 인코딩 지연 시간:  {:.3} ms -> {:.3} ms ({:.1}% 단축)",
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
            source: "aether-link-poc-week2".to_string(),
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
