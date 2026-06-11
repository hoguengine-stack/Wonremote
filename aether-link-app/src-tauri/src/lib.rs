pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run AetherLink Viewer desktop shell");
}
