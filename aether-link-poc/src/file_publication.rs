use std::{io, os::windows::ffi::OsStrExt, os::windows::fs::MetadataExt, path::Path};
use windows::{core::PCWSTR, Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS}};

pub fn publish(source: &Path, target: &Path) -> io::Result<()> {
    if !source.is_absolute() || !target.is_absolute() || source == target {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid publication paths"));
    }
    let source_parent = source.parent().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let target_parent = target.parent().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let metadata = std::fs::symlink_metadata(source)?;
    let temporary = source.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if std::fs::canonicalize(source_parent)? != std::fs::canonicalize(target_parent)?
        || !metadata.is_file() || metadata.file_attributes() & 0x400 != 0
        || !(temporary.ends_with(".part") || temporary.ends_with(".download")) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Only same-directory received temporary files may be published"));
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // No replace/copy flags: preserve racing destinations on NTFS, FAT and network providers.
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(target.as_ptr()), MOVE_FILE_FLAGS(0)) }
        .map_err(|error| io::Error::from_raw_os_error((error.code().0 & 0xffff) as i32))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_never_replaces_a_destination_and_rejects_unmanaged_paths() {
        let root = std::env::temp_dir().join(format!("wonremote-publish-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("received.part"); let target = root.join("existing.txt");
        std::fs::write(&source, b"new").unwrap(); std::fs::write(&target, b"old").unwrap();
        assert_eq!(publish(&source, &target).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        let renamed = root.join("renamed.txt"); publish(&source, &renamed).unwrap();
        assert_eq!(std::fs::read(&renamed).unwrap(), b"new"); assert!(!source.exists());
        assert!(publish(&renamed, &target).is_err());
        std::fs::create_dir(root.join("other")).unwrap();
        std::fs::write(&source, b"new").unwrap();
        assert!(publish(&source, &root.join("other/new.txt")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
