//! Data layer: everything the window shows comes from the native `rdsh` binary,
//! so a refresh costs milliseconds and never starts Node or Electron.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

/// One measured `rdsh` call. The window shows these numbers, so the speed claim
/// stays visible instead of being an assertion in a README.
#[derive(Debug, Clone, Serialize)]
pub struct Timing {
    pub command: String,
    pub millis: u128,
    pub ok: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionRow {
    pub id: String,
    pub project: String,
    pub mtime: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopStatus {
    pub available: bool,
    pub app_path: Option<String>,
    pub profile_dir: Option<String>,
    pub plugins: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub version: String,
    pub binary: String,
    pub dsh_home: String,
    pub sessions_total: u64,
    pub sessions: Vec<SessionRow>,
    pub profiles: Vec<String>,
    pub skills: Vec<String>,
    pub desktop: DesktopStatus,
    pub timings: Vec<Timing>,
    pub total_millis: u128,
}

#[derive(Debug)]
pub struct Outcome {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub millis: u128,
    pub timed_out: bool,
}

/// Resolution order: explicit environment override, a sibling of this binary
/// (release archives ship both), then `rdsh` on `PATH`.
pub fn binary() -> PathBuf {
    for key in ["RDSH_DESKTOP_BIN", "RDSH_BIN"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                return PathBuf::from(value);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["rdsh", "rdsh.exe"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["rdsh", "rdsh.exe"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    PathBuf::from("rdsh")
}

/// Run `rdsh` with a hard deadline. `rdsh` answers in milliseconds, so the
/// timeout only exists to keep a pathological environment from freezing the UI.
pub fn run(binary: &PathBuf, args: &[&str], timeout: Duration) -> Outcome {
    let started = Instant::now();
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Outcome {
                ok: false,
                stdout: String::new(),
                stderr: error.to_string(),
                millis: started.elapsed().as_millis(),
                timed_out: false,
            }
        }
    };

    let deadline = started + timeout;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
    let status = child.try_wait().ok().flatten();
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    Outcome {
        ok: !timed_out && status.map(|code| code.success()).unwrap_or(false),
        stdout,
        stderr,
        millis: started.elapsed().as_millis(),
        timed_out,
    }
}

fn drain(pipe: Option<impl Read>) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut buffer = String::new();
    let _ = pipe.read_to_string(&mut buffer);
    buffer
}

fn note(outcome: &Outcome) -> Option<String> {
    if outcome.timed_out {
        return Some("timeout".to_string());
    }
    let line = outcome
        .stderr
        .lines()
        .chain(outcome.stdout.lines())
        .find(|line| !line.trim().is_empty())?;
    Some(line.trim().to_string())
}

fn lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Collect one frame of dashboard data. Every value is measured, including the
/// per-command latency, so the window and `--print-json` agree.
pub fn snapshot() -> Snapshot {
    let binary = binary();
    let timeout = Duration::from_millis(2_000);
    let mut timings = Vec::new();
    let started = Instant::now();

    let version_outcome = run(&binary, &["--version"], timeout);
    let version = version_outcome
        .stdout
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    timings.push(Timing {
        command: "rdsh --version".to_string(),
        millis: version_outcome.millis,
        ok: version_outcome.ok,
        note: note(&version_outcome),
    });

    let sessions_outcome = run(&binary, &["sessions", "--json", "--limit", "6"], timeout);
    let (sessions_total, sessions) = parse_sessions(&sessions_outcome.stdout);
    timings.push(Timing {
        command: "rdsh sessions --json --limit 6".to_string(),
        millis: sessions_outcome.millis,
        ok: sessions_outcome.ok,
        note: note(&sessions_outcome),
    });

    let profiles_outcome = run(&binary, &["profiles"], timeout);
    let profiles = lines(&profiles_outcome.stdout);
    timings.push(Timing {
        command: "rdsh profiles".to_string(),
        millis: profiles_outcome.millis,
        ok: profiles_outcome.ok,
        note: note(&profiles_outcome),
    });

    let skills_outcome = run(&binary, &["skills"], timeout);
    let skills = lines(&skills_outcome.stdout);
    timings.push(Timing {
        command: "rdsh skills".to_string(),
        millis: skills_outcome.millis,
        ok: skills_outcome.ok,
        note: note(&skills_outcome),
    });

    let desktop_outcome = run(&binary, &["desktop", "status", "--json"], timeout);
    let desktop = parse_desktop(&desktop_outcome.stdout);
    timings.push(Timing {
        command: "rdsh desktop status --json".to_string(),
        millis: desktop_outcome.millis,
        ok: desktop_outcome.ok,
        note: note(&desktop_outcome),
    });

    Snapshot {
        version,
        binary: binary.display().to_string(),
        dsh_home: std::env::var("DSH_HOME").unwrap_or_else(|_| "(default)".to_string()),
        sessions_total,
        sessions,
        profiles,
        skills,
        desktop,
        timings,
        total_millis: started.elapsed().as_millis(),
    }
}

fn parse_sessions(stdout: &str) -> (u64, Vec<SessionRow>) {
    let Ok(document) = serde_json::from_str::<Value>(stdout) else {
        return (0, Vec::new());
    };
    let total = document
        .get("total")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let rows = document
        .get("sessions")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| SessionRow {
                    id: row
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .chars()
                        .take(8)
                        .collect(),
                    project: row
                        .get("project")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .replace("--", "/")
                        .trim_matches('/')
                        .to_string(),
                    mtime: row
                        .get("mtime")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    bytes: row.get("bytes").and_then(Value::as_u64).unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    (total, rows)
}

fn parse_desktop(stdout: &str) -> DesktopStatus {
    let Ok(document) = serde_json::from_str::<Value>(stdout) else {
        return DesktopStatus {
            available: false,
            app_path: None,
            profile_dir: None,
            plugins: Vec::new(),
        };
    };
    let plugins = document
        .get("plugins")
        .and_then(Value::as_array)
        .map(|plugins| {
            plugins
                .iter()
                .filter_map(|plugin| {
                    let name = plugin.get("name").and_then(Value::as_str)?;
                    let installed = plugin
                        .get("installed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    Some(format!("{name}:{}", if installed { "on" } else { "off" }))
                })
                .collect()
        })
        .unwrap_or_default();
    DesktopStatus {
        available: document
            .get("available")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        app_path: document
            .get("app")
            .and_then(|app| app.get("path"))
            .and_then(Value::as_str)
            .map(str::to_string),
        profile_dir: document
            .get("profile")
            .and_then(|profile| profile.get("dir"))
            .and_then(Value::as_str)
            .map(str::to_string),
        plugins,
    }
}
