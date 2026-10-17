//! Actions behind the `rdsh setup --web` first-run wizard.
//!
//! Everything here runs a fixed program with fixed arguments: the browser only
//! names which helper it wants (`codex`, `opencode`, `tui`, `web`, `desktop`),
//! never a path or an argument. Interactive helpers open in a new terminal
//! window so the person can see and finish the flow there.

use std::path::{Path, PathBuf};

/// Environment checklist for step 1 of the wizard. Read-only, secret-free.
pub fn env_json() -> String {
    let dsh = crate::passthrough::find_original_dsh();
    let node = crate::passthrough::find_node_bin();
    let node_version = node.as_deref().and_then(node_version);
    let node_major = node_version.as_deref().and_then(|v| {
        v.trim_start_matches('v')
            .split('.')
            .next()?
            .parse::<u32>()
            .ok()
    });
    let desktop = crate::desktop::find_app(&crate::desktop::OsEnv::from_process());
    serde_json::json!({
        "os": std::env::consts::OS,
        "rdsh": env!("CARGO_PKG_VERSION"),
        "dsh": {"found": dsh.is_some()},
        "node": {
            "found": node.is_some(),
            "version": node_version,
            "supported": node_major.is_some_and(|m| m >= 22),
        },
        "npm": crate::auth::command_on_path("npm"),
        "codex": crate::auth::command_on_path("codex"),
        "opencode": crate::auth::command_on_path("opencode"),
        "desktop": desktop.is_some(),
        "terminal": terminal_available(),
    })
    .to_string()
}

fn node_version(bin: &str) -> Option<String> {
    let out = std::process::Command::new(bin)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    let text = text.trim();
    (out.status.success() && text.starts_with('v') && text.len() < 32).then(|| text.to_string())
}

/// Start a provider login (`codex login` / `opencode auth login`).
pub fn start_login(tool: &str) -> anyhow::Result<()> {
    let (bin, args) = crate::auth::login_command(tool)
        .ok_or_else(|| anyhow::anyhow!("login helper is not installed"))?;
    let program =
        resolve_on_path(bin).ok_or_else(|| anyhow::anyhow!("login helper is not installed"))?;
    if open_terminal(&program, args).is_ok() {
        return Ok(());
    }
    // `codex login` opens the browser on its own, so it also works headless.
    if tool == "codex" {
        std::process::Command::new(&program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        return Ok(());
    }
    anyhow::bail!("no terminal window available; run the login command in a terminal")
}

/// Start the first conversation: `tui` and `web` open rdsh in a new terminal,
/// `desktop` opens the DeepSeek Harness Desktop app.
pub fn start_chat(kind: &str) -> anyhow::Result<()> {
    match kind {
        "desktop" => {
            let app = crate::desktop::find_app(&crate::desktop::OsEnv::from_process())
                .ok_or_else(|| anyhow::anyhow!("DeepSeek Harness Desktop was not found"))?;
            crate::auth::open_browser(&app.to_string_lossy(), crate::locale::Locale::English)
        }
        "tui" | "web" => {
            anyhow::ensure!(
                crate::passthrough::find_original_dsh().is_some(),
                "DeepSeek Harness (dsh) is not installed"
            );
            let rdsh = std::env::current_exe()?;
            let args: &[&str] = if kind == "tui" {
                &["tui"]
            } else {
                &["--profile", "web"]
            };
            open_terminal(&rdsh, args)
        }
        _ => anyhow::bail!("unknown start target"),
    }
}

/// First match on PATH, as a full path: a new shell must not resolve a bare
/// name against its working directory first (CWE-427).
fn resolve_on_path(bin: &str) -> Option<PathBuf> {
    if bin.contains('/') || bin.contains('\\') {
        return None;
    }
    #[cfg(windows)]
    const EXTENSIONS: &[&str] = &[".exe", ".cmd", ".bat"];
    #[cfg(not(windows))]
    const EXTENSIONS: &[&str] = &[""];
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| {
            EXTENSIONS
                .iter()
                .map(move |ext| dir.join(format!("{bin}{ext}")))
        })
        .find(|candidate| crate::executable::is_executable(candidate))
}

fn terminal_available() -> bool {
    cfg!(any(windows, target_os = "macos")) || linux_terminal().is_some()
}

fn linux_terminal() -> Option<PathBuf> {
    ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
        .iter()
        .find_map(|name| resolve_on_path(name))
}

/// Run `program args…` in a new, visible terminal window that stays open.
#[cfg(windows)]
fn open_terminal(program: &Path, args: &[&str]) -> anyhow::Result<()> {
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| anyhow::anyhow!("SystemRoot is unavailable"))?;
    let cmd = PathBuf::from(system_root).join("System32").join("cmd.exe");
    let home = crate::inspect::home_dir().unwrap_or_else(|| ".".to_string());
    std::process::Command::new(&cmd)
        .args(["/c", "start", "rdsh", "/D"])
        .arg(&home)
        .arg(&cmd)
        .arg("/k")
        .arg(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_terminal(program: &Path, args: &[&str]) -> anyhow::Result<()> {
    let line = std::iter::once(program.to_string_lossy().into_owned())
        .chain(args.iter().map(|a| a.to_string()))
        .map(|part| shell_quote(&part))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        line.replace('\\', "\\\\").replace('"', "\\\"")
    );
    std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_terminal(program: &Path, args: &[&str]) -> anyhow::Result<()> {
    let terminal = linux_terminal().ok_or_else(|| anyhow::anyhow!("no terminal emulator found"))?;
    std::process::Command::new(terminal)
        .arg("-e")
        .arg(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_targets_are_refused() {
        assert!(start_chat("rm -rf /").is_err());
        assert!(crate::auth::login_command("bash").is_none());
        assert!(resolve_on_path("../codex").is_none());
    }

    #[test]
    fn env_document_is_secret_free_json() {
        let v: serde_json::Value = serde_json::from_str(&env_json()).unwrap();
        assert_eq!(v["rdsh"], env!("CARGO_PKG_VERSION"));
        assert!(v["dsh"]["found"].is_boolean());
        assert!(v["node"]["supported"].is_boolean());
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
