use std::{io, process::{Command, ExitStatus}, sync::mpsc::{self, Receiver, RecvTimeoutError, Sender}, thread, time::Duration};

// Dropping the sender (including on application exit) cancels the owned helper.
pub fn start(mut command: Command, completed: impl FnOnce(io::Result<ExitStatus>) + Send + 'static) -> Sender<()> {
    let (cancel, receiver) = mpsc::channel();
    thread::spawn(move || {
        if let Some(result) = wait(&mut command, receiver) { completed(result); }
    });
    cancel
}

fn wait(command: &mut Command, cancel: Receiver<()>) -> Option<io::Result<ExitStatus>> {
    if !matches!(cancel.try_recv(), Err(mpsc::TryRecvError::Empty)) { return None; }
    let mut child = match command.spawn() { Ok(child) => child, Err(error) => return Some(Err(error)) };
    loop {
        match cancel.recv_timeout(Duration::from_millis(100)) {
            Err(RecvTimeoutError::Timeout) => {},
            _ => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
        match child.try_wait() {
            Ok(Some(status)) => return Some(Ok(status)),
            Ok(None) => {},
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Some(Err(error)); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    fn shell(script: &str) -> Command {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-Command", script]).creation_flags(0x08000000);
        command
    }
    #[test]
    fn blocked_helper_does_not_block_caller_and_cancel_suppresses_completion() {
        let (done, result) = mpsc::channel();
        let cancel = start(shell("Start-Sleep -Seconds 30; exit 10"), move |status| { let _ = done.send(status); });
        assert!(matches!(result.recv_timeout(Duration::from_millis(200)), Err(RecvTimeoutError::Timeout)));
        drop(cancel);
        assert!(matches!(result.recv_timeout(Duration::from_secs(5)), Err(RecvTimeoutError::Disconnected)));
    }
    #[test]
    fn preserves_handoff_decline_and_failure_without_retry() {
        for code in [0, 1, 10] {
            let (done, result) = mpsc::channel();
            let _cancel = start(shell(&format!("exit {code}")), move |status| { done.send(status).unwrap(); });
            assert_eq!(result.recv_timeout(Duration::from_secs(10)).unwrap().unwrap().code(), Some(code));
        }
    }
}
