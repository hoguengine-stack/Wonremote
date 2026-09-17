use base64::{engine::general_purpose::STANDARD, Engine};
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::{Storage::FileSystem::MoveFileExW, UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL}};
use std::{collections::HashMap, fs::{self, File, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::{Mutex, atomic::{AtomicU64, Ordering}}};

struct Download { file: File, temporary: PathBuf, destination: PathBuf, total: u64, written: u64 }
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, Download>>);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const MAX_BYTES: u64 = 500 * 1024 * 1024;

fn settings_path() -> Result<PathBuf, String> {
    Ok(PathBuf::from(std::env::var("APPDATA").map_err(|e| e.to_string())?).join("WonRemote").join("viewer-download-folder.json"))
}
fn folder() -> Result<PathBuf, String> {
    if let Ok(bytes) = fs::read(settings_path()?) {
        let saved: String = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let path = PathBuf::from(saved);
        if path.is_absolute() && path.is_dir() { return Ok(path); }
        return Err("저장 폴더를 사용할 수 없습니다. 다른 폴더를 선택하세요.".into());
    }
    let path = PathBuf::from(std::env::var("USERPROFILE").map_err(|e| e.to_string())?).join("Downloads").join("WonRemote");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn valid_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !name.is_empty() && name.len() <= 200 && !name.ends_with([' ', '.'])
        && !name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit())
}
fn begin_at(root: &Path, filename: &str, total: u64, state: &Downloads) -> Result<String, String> {
    if !valid_name(filename) || total > MAX_BYTES { return Err("Invalid download name or size".into()); }
    let mut active = state.0.lock().map_err(|e| e.to_string())?;
    if active.len() >= 4 { return Err("Too many active downloads".into()); }
    let id = format!("{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let temporary = root.join(format!(".wonremote-{id}.part"));
    let file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
    active.insert(id.clone(), Download { file, temporary, destination: root.join(filename), total, written: 0 });
    Ok(id)
}
fn append(state: &Downloads, id: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
    let mut active = state.0.lock().map_err(|e| e.to_string())?;
    let item = active.get_mut(id).ok_or("Unknown download")?;
    if bytes.len() > 65536 || offset != item.written || bytes.len() as u64 > item.total - item.written { return Err("Invalid download chunk".into()); }
    item.file.write_all(bytes).map_err(|e| e.to_string())?;
    item.written += bytes.len() as u64;
    Ok(())
}
fn publish_without_overwrite(source: &Path, target: &Path) -> std::io::Result<()> {
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Same-folder rename: no replace/copy flags, so a racing destination is never overwritten.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
fn finish(state: &Downloads, id: &str) -> Result<String, String> {
    let mut active = state.0.lock().map_err(|e| e.to_string())?;
    let item = active.get_mut(id).ok_or("Unknown download")?;
    if item.written != item.total { return Err("Download is incomplete".into()); }
    item.file.sync_all().map_err(|e| e.to_string())?;
    // Publish without ever overwriting an existing user file, including racing writers.
    let original = item.destination.file_name().unwrap().to_string_lossy();
    let mut final_path = None;
    for suffix in 0..1000 {
        let target = if suffix == 0 { item.destination.clone() } else { item.destination.with_file_name(format!("({suffix}) {original}")) };
        match publish_without_overwrite(&item.temporary, &target) {
            Ok(()) => { final_path = Some(target); break; }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let path = final_path.ok_or("No available filename")?;
    let item = active.remove(id).unwrap();
    drop(item.file);
    Ok(path.to_string_lossy().into_owned())
}
fn resolve_download_file(root: &Path, requested: &Path) -> Result<PathBuf, String> {
    if !requested.is_absolute() { return Err("다운로드 받은 파일 경로가 올바르지 않습니다.".into()); }
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let requested = fs::canonicalize(requested).map_err(|_| "다운로드 받은 파일을 찾을 수 없습니다.".to_string())?;
    if !requested.starts_with(&root) || !requested.is_file() { return Err("다운로드 폴더 안의 파일만 열 수 있습니다.".into()); }
    Ok(requested)
}
fn open_download_file_at(root: &Path, requested: &Path) -> Result<(), String> {
    let requested = resolve_download_file(root, requested)?;
    let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let requested: Vec<u16> = requested.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), requested.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    if result as isize <= 32 { return Err(format!("다운로드 받은 파일을 열지 못했습니다. 오류 코드: {}", result as isize)); }
    Ok(())
}
#[tauri::command]
pub fn viewer_download_folder() -> Result<String, String> { Ok(folder()?.to_string_lossy().into_owned()) }
#[tauri::command]
pub fn begin_viewer_download(filename: String, total: u64, state: tauri::State<Downloads>) -> Result<String, String> { begin_at(&folder()?, &filename, total, &state) }
#[tauri::command]
pub fn write_viewer_download(id: String, offset: u64, data: String, state: tauri::State<Downloads>) -> Result<(), String> {
    if data.len() > 87384 { return Err("Chunk too large".into()); }
    append(&state, &id, offset, &STANDARD.decode(data).map_err(|e| e.to_string())?)
}
#[tauri::command]
pub fn finish_viewer_download(id: String, state: tauri::State<Downloads>) -> Result<String, String> { finish(&state, &id) }
#[tauri::command]
pub fn abort_viewer_download(id: String, state: tauri::State<Downloads>) -> Result<(), String> {
    if let Some(item) = state.0.lock().map_err(|e| e.to_string())?.remove(&id) { drop(item.file); fs::remove_file(item.temporary).map_err(|e| e.to_string())?; }
    Ok(())
}
#[tauri::command]
pub fn open_viewer_download_folder() -> Result<(), String> {
    std::process::Command::new("explorer.exe").arg(folder()?).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn open_viewer_download_file(path: String) -> Result<(), String> { open_download_file_at(&folder()?, Path::new(&path)) }
#[tauri::command]
pub async fn choose_viewer_download_folder() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use std::os::windows::process::CommandExt;
        let script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $d=[System.Windows.Forms.FolderBrowserDialog]::new(); if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.SelectedPath)}; $d.Dispose()";
        let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-STA", "-Command", script]).creation_flags(0x08000000).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("폴더 선택 실패".into()); }
        let chosen = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
        if chosen.is_empty() { return viewer_download_folder(); }
        let path = PathBuf::from(&chosen);
        if !path.is_absolute() || !path.is_dir() { return Err("Invalid directory".into()); }
        let settings = settings_path()?;
        fs::create_dir_all(settings.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(settings, serde_json::to_vec(&chosen).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(chosen)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saves_exact_bytes_and_never_overwrites() {
        let root = std::env::temp_dir().join(format!("wonremote-save-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();
        let state = Downloads::default();
        fs::write(root.join("test.txt"), b"old").unwrap();
        for name in ["../a", "C:\\a", "NUL.txt", "file.", "x:y"] { assert!(begin_at(&root, name, 1, &state).is_err()); }
        let id = begin_at(&root, "test.txt", 3, &state).unwrap();
        assert!(append(&state, &id, 1, b"new").is_err());
        assert!(finish(&state, &id).is_err());
        append(&state, &id, 0, b"new").unwrap();
        let saved = finish(&state, &id).unwrap();
        assert!(!root.join(format!(".wonremote-{id}.part")).exists());
        assert_eq!(fs::read(saved).unwrap(), b"new");
        assert_eq!(fs::read(root.join("test.txt")).unwrap(), b"old");
        assert!(finish(&state, &id).is_err());
        let ids: Vec<_> = (0..3).map(|_| {
            let id = begin_at(&root, "test.txt", 1, &state).unwrap();
            append(&state, &id, 0, b"x").unwrap();
            id
        }).collect();
        let results = std::thread::scope(|scope| {
            let workers: Vec<_> = ids.iter().map(|id| scope.spawn(|| finish(&state, id).unwrap())).collect();
            workers.into_iter().map(|worker| worker.join().unwrap()).collect::<Vec<_>>()
        });
        assert_eq!(results.iter().collect::<std::collections::HashSet<_>>().len(), 3);
        for path in results { assert_eq!(fs::read(path).unwrap(), b"x"); }
        assert_eq!(fs::read(root.join("test.txt")).unwrap(), b"old");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_only_existing_files_inside_download_root() {
        let base = std::env::temp_dir().join(format!("wonremote-open-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)));
        let root = base.join("downloads");
        fs::create_dir_all(&root).unwrap();
        let saved = root.join("received.txt");
        let outside = base.join("outside.txt");
        fs::write(&saved, b"saved").unwrap();
        fs::write(&outside, b"outside").unwrap();
        assert_eq!(resolve_download_file(&root, &saved).unwrap(), fs::canonicalize(&saved).unwrap());
        assert!(resolve_download_file(&root, &outside).is_err());
        assert!(resolve_download_file(&root, &root).is_err());
        assert!(resolve_download_file(&root, &root.join("missing.txt")).is_err());
        assert!(resolve_download_file(&root, Path::new("received.txt")).is_err());
        fs::remove_dir_all(base).unwrap();
    }
}
