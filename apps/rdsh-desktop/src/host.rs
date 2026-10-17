//! Supervise the harness web host.
//!
//! The harness runtime is a Node process; this app launches
//! the web profile with an OS-assigned port and reads the ready URL (which
//! carries the process token) from its output. Plugin banners and even fatal
//! plugin logs appear on the same stream, so the reader scans rather than
//! trusting the first line.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

const READY_TIMEOUT: Duration = Duration::from_secs(90);

pub struct Host {
    child: Child,
    pub url: String,
    pub origin: String,
    pub token: String,
}

impl Host {
    /// Launch dsh web --no-open --port 0 and wait for the ready URL.
    pub fn start() -> Result<Self> {
        let binary = resolve_dsh()?;
        let mut child = Command::new(&binary)
            .args(["web", "--no-open", "--port", "0"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("spawn {} web", binary.display()))?;

        let (sender, receiver) = mpsc::channel();
        pump(child.stdout.take(), sender.clone());
        pump(child.stderr.take(), sender);

        let deadline = Instant::now() + READY_TIMEOUT;
        let mut seen = Vec::new();
        let mut ready = None;
        while Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    if let Some(found) = parse_ready(&line) {
                        ready = Some(found);
                        break;
                    }
                    if seen.len() < 40 {
                        seen.push(line);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if let Ok(Some(status)) = child.try_wait() {
                        return Err(anyhow!(
                            "dsh web exited with {status} before printing a ready URL; output: {}",
                            seen.join(" | ")
                        ));
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        let Some((url, origin, token)) = ready else {
            let _ = child.kill();
            return Err(anyhow!(
                "dsh web did not print a ready URL within {}s; output: {}",
                READY_TIMEOUT.as_secs(),
                seen.join(" | ")
            ));
        };

        Ok(Self {
            child,
            url,
            origin,
            token,
        })
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pump(pipe: Option<impl std::io::Read + Send + 'static>, sender: mpsc::Sender<String>) {
    let Some(pipe) = pipe else {
        return;
    };
    thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// Find the printed ready URL and split it into origin and process token.
fn parse_ready(line: &str) -> Option<(String, String, String)> {
    for candidate in line.split_whitespace() {
        let Some(index) = candidate.find("http://") else {
            continue;
        };
        let url = candidate[index..].trim_end_matches(['.', ',', ')']);
        let (base, query) = match url.split_once('?') {
            Some(parts) => parts,
            None => continue,
        };
        let token = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("token="))?;
        if token.is_empty() {
            continue;
        }
        let origin = base.trim_end_matches('/').to_string();
        if !origin.starts_with("http://127.0.0.1:") && !origin.starts_with("http://localhost:") {
            continue;
        }
        return Some((url.to_string(), origin, token.to_string()));
    }
    None
}

/// RDSH_DESKTOP_DSH, then PATH, then the layout used by the local install.
fn resolve_dsh() -> Result<PathBuf> {
    if let Ok(value) = std::env::var("RDSH_DESKTOP_DSH") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["dsh", "dsh-orig"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    for candidate in [
        "/home/sahen/.local/opt/dsh-original/bin/dsh",
        "/home/sahen/.local/bin/dsh",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(anyhow!(
        "dsh was not found; set RDSH_DESKTOP_DSH to the harness launcher"
    ))
}

#[cfg(test)]
mod tests {
    use super::parse_ready;

    #[test]
    fn reads_the_ready_url_from_noisy_output() {
        let line = "dsh web: http://127.0.0.1:46051/?token=abc123";
        let (url, origin, token) = parse_ready(line).expect("ready url");
        assert_eq!(url, "http://127.0.0.1:46051/?token=abc123");
        assert_eq!(origin, "http://127.0.0.1:46051");
        assert_eq!(token, "abc123");
    }

    #[test]
    fn ignores_plugin_noise() {
        assert!(parse_ready("{\"level\":\"fatal\",\"message\":\"Authentication required\"}").is_none());
        assert!(parse_ready("http://example.com/?token=x").is_none());
    }
}
