use std::path::PathBuf;
use std::process::Command;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "rdsh-auth-json-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    /// Run rdsh with only the fixture's own locations: never the caller's real
    /// login stores or provider environment. The test contacts no provider.
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command
            .args(args)
            .env_clear()
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("APPDATA", self.0.join("appdata"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("DSH_HOME", self.0.join("dsh"))
            .env("DEEPSEEK_API_KEY", "synthetic-auth-cli-fixture");
        // Retain only OS locations needed by whoami/icacls, never a real login
        // store or provider environment.
        #[cfg(target_os = "windows")]
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", &system_root);
            command.env("PATH", PathBuf::from(system_root).join("System32"));
        }
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn setup_json_stays_parseable_while_saving_a_key() {
    let fixture = Fixture::new();
    // `--yes` is not consent to persist an environment key: the documented
    // non-interactive route is an explicit sharing selection, after which
    // setup imports the key through the normal sync path.
    let selected = fixture
        .command(&["auth", "--select", "env:DEEPSEEK_API_KEY"])
        .output()
        .unwrap();
    assert!(selected.status.success(), "{:?}", selected);
    let output = fixture
        .command(&["setup", "--yes", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    let status: serde_json::Value = serde_json::from_slice(&output.stdout)
        .expect("setup --json must emit only a JSON document, including on Windows");
    assert_eq!(status["needed"], false);
    // The key was saved by the selected import, not by `--yes`, so the prompt
    // path reports no persisted environment key.
    assert_eq!(status["persisted_env_keys"], serde_json::json!([]));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-auth-cli-fixture"));
    let credentials = std::fs::read_to_string(fixture.0.join("dsh/.credentials.yaml")).unwrap();
    assert!(credentials.contains("synthetic-auth-cli-fixture"));
}
