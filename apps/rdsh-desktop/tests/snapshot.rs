//! The data layer is testable without a display: `--print-json` runs the same
//! `rdsh` calls the window renders and prints the result.

use std::process::Command;

fn snapshot() -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_rdsh-desktop"))
        .arg("--print-json")
        .output()
        .expect("run rdsh-desktop --print-json");
    assert!(output.status.success(), "rdsh-desktop --print-json failed");
    serde_json::from_slice(&output.stdout).expect("snapshot is JSON")
}

#[test]
fn snapshot_reports_the_resolved_binary_and_timings() {
    let snapshot = snapshot();
    let binary = snapshot["binary"].as_str().unwrap_or_default();
    assert!(!binary.is_empty(), "binary path is reported");
    let timings = snapshot["timings"].as_array().expect("timings array");
    assert!(!timings.is_empty(), "every call is measured");
}

#[test]
fn snapshot_records_a_latency_for_every_call() {
    let snapshot = snapshot();
    let rows = snapshot["timings"].as_array().expect("timings array");
    for row in rows {
        let command = row["command"].as_str().unwrap_or_default();
        assert!(!command.is_empty(), "timing rows name their command");
        assert!(row["millis"].is_number(), "timing rows carry milliseconds");
        assert!(row["ok"].is_boolean(), "timing rows carry a status");
    }
    let commands: Vec<&str> = rows
        .iter()
        .filter_map(|row| row["command"].as_str())
        .collect();
    assert!(commands.contains(&"rdsh --version"));
    assert!(commands.contains(&"rdsh sessions --json --limit 6"));
    assert!(commands.contains(&"rdsh desktop status --json"));
}

#[test]
fn snapshot_reports_session_totals_and_rows() {
    let snapshot = snapshot();
    assert!(snapshot["sessions_total"].is_number());
    assert!(snapshot["sessions"].is_array());
    assert!(snapshot["desktop"].is_object());
    assert!(snapshot["desktop"]["available"].is_boolean());
}
