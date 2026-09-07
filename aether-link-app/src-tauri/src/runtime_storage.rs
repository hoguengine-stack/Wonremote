#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
    time::{Duration, SystemTime},
};

pub const LOG_LIMIT: u64 = 5 * 1024 * 1024;
pub const CACHE_LIMIT: u64 = 128 * 1024 * 1024;
const DAY: Duration = Duration::from_secs(86400);
const WEEK: Duration = Duration::from_secs(7 * 86400);
const CACHE_DIRS: &[&str] = &[
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "GPUCache",
    "GrShaderCache",
    "ShaderCache",
    "GPUPersistentCache",
];

fn exclusive(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(windows)]
    options.share_mode(0);
    options.open(path)
}

// A file lock also serializes the Viewer and Agent sharing the same log.
pub fn append_log(path: &Path, record: &str) -> io::Result<()> {
    fs::create_dir_all(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    let _lock = exclusive(&path.with_extension("log.lock"))?;
    let mut line = record;
    if line.len() as u64 > LOG_LIMIT {
        let mut start = line.len() - LOG_LIMIT as usize;
        while !line.is_char_boundary(start) {
            start += 1;
        }
        line = &line[start..];
    }
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size + line.len() as u64 > LOG_LIMIT {
        let oldest = path.with_extension("log.2");
        let previous = path.with_extension("log.1");
        if oldest.exists() {
            fs::remove_file(&oldest)?;
        }
        if previous.exists() {
            fs::rename(&previous, &oldest)?;
        }
        if path.exists() {
            if size > LOG_LIMIT {
                // Bound legacy oversized logs while retaining their latest diagnostics.
                let mut source = exclusive(path)?;
                source.seek(SeekFrom::End(-(LOG_LIMIT as i64)))?;
                let mut tail = Vec::with_capacity(LOG_LIMIT as usize);
                source.read_to_end(&mut tail)?;
                source.set_len(0)?;
                source.seek(SeekFrom::Start(0))?;
                source.write_all(&tail)?;
            }
            fs::rename(path, &previous)?;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

fn age(path: &Path, now: SystemTime) -> Option<Duration> {
    now.duration_since(fs::metadata(path).ok()?.modified().ok()?)
        .ok()
}

pub fn maintenance_due(root: &Path, now: SystemTime) -> bool {
    age(&root.join(".wonremote-maintenance"), now).map_or(true, |elapsed| elapsed >= DAY)
}

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn size_without_links(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if is_link(&metadata) {
        return 0;
    }
    if metadata.is_file() {
        return metadata.len();
    }
    fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| size_without_links(&e.path()))
                .sum()
        })
        .unwrap_or(0)
}

// Reject reparse points at every level rather than following a cache junction elsewhere.
fn remove_without_links(root: &Path, path: &Path) -> io::Result<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| io::ErrorKind::PermissionDenied)?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        current.push(part);
        if is_link(&fs::symlink_metadata(&current)?) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let metadata = fs::symlink_metadata(path)?;
    if is_link(&metadata) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            remove_without_links(root, &entry?.path())?;
        }
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

pub fn cache_size(profile: &Path) -> u64 {
    CACHE_DIRS
        .iter()
        .map(|p| size_without_links(&profile.join(p)))
        .sum()
}

pub fn clean_cache(profile: &Path, browser_closed: bool, now: SystemTime) -> io::Result<()> {
    if !profile.is_dir() || !maintenance_due(profile, now) {
        return Ok(());
    }
    if is_link(&fs::symlink_metadata(profile)?) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let _lock = exclusive(&profile.join(".wonremote-maintenance.lock"))?;
    if !maintenance_due(profile, now) {
        return Ok(());
    }
    if cache_size(profile) > CACHE_LIMIT {
        if !browser_closed {
            return Ok(());
        }
        for relative in CACHE_DIRS {
            let path = profile.join(relative);
            if path.exists() {
                remove_without_links(profile, &path)?;
            }
        }
    }
    fs::write(profile.join(".wonremote-maintenance"), b"1")
}

pub fn clean_updates(updates: &Path, now: SystemTime) -> io::Result<()> {
    if !updates.is_dir() || !maintenance_due(updates, now) {
        return Ok(());
    }
    if is_link(&fs::symlink_metadata(updates)?) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let _lock = exclusive(&updates.join("update-handoff.lock"))?;
    for entry in fs::read_dir(updates)? {
        let entry = entry?;
        let path = entry.path();
        if !age(&path, now).is_some_and(|elapsed| elapsed >= WEEK) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(&path)?;
        if is_link(&metadata) {
            continue;
        }
        let disposable = if metadata.is_dir() {
            name.starts_with("rollback-") && !path.join("ROLLBACK_FAILED").exists()
        } else {
            matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("part" | "exe" | "ps1" | "log" | "accepted")
            )
        };
        if disposable {
            remove_without_links(updates, &path)?;
        }
    }
    fs::write(updates.join(".wonremote-maintenance"), b"1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn temp(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("wonremote-storage-{name}-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn oversized_legacy_and_repeated_logs_stay_bounded() {
        let root = temp("logs");
        let path = root.join("runtime.log");
        fs::write(&path, vec![b'x'; (LOG_LIMIT * 2) as usize]).unwrap();
        for _ in 0..7 {
            append_log(&path, &"a".repeat(LOG_LIMIT as usize)).unwrap();
        }
        append_log(&path, "latest").unwrap();
        for p in [
            &path,
            &path.with_extension("log.1"),
            &path.with_extension("log.2"),
        ] {
            assert!(fs::metadata(p).unwrap().len() <= LOG_LIMIT);
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "latest");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 4); // Three logs and one lock.
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cache_cleanup_keeps_login_state_and_respects_live_browser_and_daily_gate() {
        let root = temp("cache");
        let cache = root.join("Default/Cache");
        fs::create_dir_all(&cache).unwrap();
        File::create(cache.join("data"))
            .unwrap()
            .set_len(CACHE_LIMIT + 1)
            .unwrap();
        fs::write(root.join("Default/Cookies"), "login").unwrap();
        fs::create_dir_all(root.join("Default/Local Storage")).unwrap();
        fs::write(root.join("Default/Local Storage/state"), "registration").unwrap();
        let now = SystemTime::now();
        clean_cache(&root, false, now).unwrap();
        assert!(cache.exists());
        clean_cache(&root, true, now).unwrap();
        assert!(!cache.exists());
        assert_eq!(
            fs::read_to_string(root.join("Default/Cookies")).unwrap(),
            "login"
        );
        assert_eq!(
            fs::read_to_string(root.join("Default/Local Storage/state")).unwrap(),
            "registration"
        );
        assert!(!maintenance_due(&root, now + Duration::from_secs(60)));
        assert!(maintenance_due(&root, now + DAY + Duration::from_secs(1)));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn updates_keep_failed_rollback_and_unknown_files() {
        let root = temp("updates");
        fs::write(root.join("installer.exe"), "installer").unwrap();
        fs::write(root.join("agent-config.json"), "identity").unwrap();
        fs::create_dir_all(root.join("rollback-failed")).unwrap();
        fs::write(root.join("rollback-failed/ROLLBACK_FAILED"), "keep").unwrap();
        clean_updates(&root, SystemTime::now()).unwrap();
        assert!(root.join("installer.exe").exists());
        clean_updates(&root, SystemTime::now() + WEEK + DAY).unwrap();
        assert!(!root.join("installer.exe").exists());
        assert!(root.join("agent-config.json").exists());
        assert!(root.join("rollback-failed/ROLLBACK_FAILED").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn active_installer_lock_prevents_cleanup() {
        let root = temp("locked-update");
        fs::write(root.join("installer.exe"), "keep").unwrap();
        let lock = exclusive(&root.join("update-handoff.lock")).unwrap();
        assert!(clean_updates(&root, SystemTime::now() + WEEK + DAY).is_err());
        assert!(root.join("installer.exe").exists());
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn log_lock_prevents_cross_process_rotation_conflicts() {
        let root = temp("locked-log");
        let path = root.join("runtime.log");
        append_log(&path, "before").unwrap();
        let lock = exclusive(&path.with_extension("log.lock")).unwrap();
        assert!(append_log(&path, "blocked").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "before");
        drop(lock);
        append_log(&path, "after").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "beforeafter");
        fs::remove_dir_all(root).unwrap();
    }
}
