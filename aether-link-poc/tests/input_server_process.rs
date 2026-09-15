use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn input_server_reads_requests_without_privileged_broker_and_survives_invalid_input() {
    // Malformed and unknown commands never inject keys or move the user's pointer.
    let mut child = Command::new(env!("CARGO_BIN_EXE_wonremote-poc"))
        .args(["--mode", "input-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"not-json\n{\"id\":\"bad-action\",\"action\":\"\"}\n{\"id\":\"normal-desktop\",\"action\":\"input-regression-probe\"}\n").unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    let responses: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[0]["ok"], false);
    assert_eq!(responses[1]["id"], "bad-action");
    assert_eq!(responses[1]["ok"], false);
    assert!(responses[1]["error"]
        .as_str()
        .unwrap()
        .contains("Invalid input-server action"));
    assert_eq!(responses[2]["id"], "normal-desktop");
    assert_eq!(responses[2]["ok"], false);
    assert_eq!(
        responses[2]["error"],
        "Unknown action: input-regression-probe"
    );
}
