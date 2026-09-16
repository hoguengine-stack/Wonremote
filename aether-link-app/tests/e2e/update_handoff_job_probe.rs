use std::{env, path::PathBuf, thread, time::Duration};

#[path = "../../src-tauri/src/update_handoff_process.rs"]
mod update_handoff_process;

fn main() {
    let Some(script_path) = env::var_os("WONREMOTE_BROKER_E2E_SCRIPT") else {
        eprintln!("WONREMOTE_BROKER_E2E_SCRIPT is required.");
        std::process::exit(2);
    };
    if let Err(error) =
        update_handoff_process::spawn_brokered_update_handoff(&PathBuf::from(script_path))
    {
        eprintln!("{error}");
        std::process::exit(3);
    }

    loop {
        thread::sleep(Duration::from_secs(60));
    }
}
