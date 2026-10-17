//! Conversation window: project-grouped sidebar with real titles, model picker,
//! live assistant streaming, approval and question prompts, tool rows.
//!
//! Startup and all sockets run on background threads; the window paints first and
//! receives updates through channels.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};

use gpui::prelude::*;
use gpui::*;
use serde_json::Value;

use crate::api::Api;
use crate::host::Host;
use crate::live::{self, LiveCmd, LiveEvent, Pending};
use crate::mux::Mux;
use crate::theme;

const POLL: Duration = Duration::from_millis(120);
const RELOAD_AFTER: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Default)]
pub struct Model {
    pub provider: String,
    pub model: String,
}

impl Model {
    pub fn is_empty(&self) -> bool {
        self.provider.is_empty() && self.model.is_empty()
    }

    pub fn label(&self) -> String {
        if self.model.is_empty() {
            self.provider.clone()
        } else if self.provider.is_empty() {
            self.model.clone()
        } else {
            format!("{} · {}", short_model(&self.model), self.provider)
        }
    }
}

#[derive(Clone, Debug)]
pub struct CatalogEntry {
    pub provider: String,
    pub model: String,
    pub label: String,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub cwd: String,
    pub updated: i64,
    pub blank: bool,
    pub running: bool,
    pub title: String,
    pub model: Model,
    pub context: String,
    pub tokens: String,
    pub questions: usize,
}

#[derive(Clone, Debug)]
pub struct Message {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct Group {
    pub label: String,
    pub path: String,
    pub sessions: Vec<(usize, Session)>,
}

enum Update {
    Step(String),
    Titles(Vec<(String, String)>),
    Ready(Box<Chat>),
    Failed(String),
}

pub struct Chat {
    host: Host,
    api: Api,
    pub status: String,
    pub sessions: Vec<Session>,
    pub selected: Option<usize>,
    pub messages: Vec<Message>,
    pub catalog: Vec<CatalogEntry>,
    pub reused: bool,
    pub startup_ms: u128,
}

impl Chat {
    pub fn connect(mut progress: impl FnMut(&str)) -> anyhow::Result<Self> {
        let started = std::time::Instant::now();
        progress("ハーネスに接続しています…");
        let host = Host::start()?;
        let reused = host.reused;
        progress("接続を認証しています…");
        let api = Api::connect(&host)?;
        let mut chat = Self {
            host,
            api,
            status: String::new(),
            sessions: Vec::new(),
            selected: None,
            messages: Vec::new(),
            catalog: Vec::new(),
            reused,
            startup_ms: 0,
        };
        progress("モデル一覧を取得しています…");
        chat.catalog = chat.load_catalog();
        progress("会話一覧を取得しています…");
        chat.reload_sessions()?;
        progress("会話を読み込んでいます…");
        chat.load_conversation()?;
        chat.startup_ms = started.elapsed().as_millis();
        chat.status = format!(
            "{} 件の会話 / 接続 {}ms{}",
            chat.sessions.len(),
            chat.startup_ms,
            if chat.reused { "（ホスト再利用）" } else { "" }
        );
        Ok(chat)
    }

    pub fn origin(&self) -> &str {
        &self.host.origin
    }

    pub fn cookie(&self) -> &str {
        self.api.cookie()
    }

    fn load_catalog(&self) -> Vec<CatalogEntry> {
        let Ok(value) = self.api.model_catalog() else {
            return Vec::new();
        };
        let mut entries = Vec::new();
        if let Some(groups) = value.get("groups").and_then(Value::as_array) {
            for group in groups {
                let provider = group
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if let Some(models) = group.get("models").and_then(Value::as_array) {
                    for model in models {
                        let id = model
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let name = model
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(&id)
                            .to_string();
                        if !id.is_empty() {
                            entries.push(CatalogEntry {
                                provider: provider.clone(),
                                model: id,
                                label: format!("{name} · {provider}"),
                            });
                        }
                    }
                }
            }
        }
        entries
    }

    fn reload_sessions(&mut self) -> anyhow::Result<()> {
        let items = self
            .api
            .session_list()?
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let projections = self.load_projections().unwrap_or_default();
        self.sessions = items
            .iter()
            .filter(|item| {
                item.get("origin").is_none()
                    && item
                        .get("parentSessionId")
                        .is_none_or(|value| value.is_null())
            })
            .map(|item| {
                let id = item
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let values = projections.get(&id).cloned().unwrap_or(Value::Null);
                Session {
                    id,
                    cwd: item
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    updated: item.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
                    blank: item.get("blank").and_then(Value::as_bool).unwrap_or(false),
                    running: item.get("running").and_then(Value::as_bool).unwrap_or(false),
                    title: values
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    model: model_of(&values),
                    context: context_of(&values),
                    tokens: tokens_of(&values),
                    questions: active_questions(&values),
                }
            })
            .collect();
        self.sessions
            .sort_by(|left, right| right.updated.cmp(&left.updated));
        if self.selected.is_none() && !self.sessions.is_empty() {
            self.selected = Some(0);
        }
        self.status = format!("{} 件の会話", self.sessions.len());
        Ok(())
    }

    fn load_projections(&self) -> anyhow::Result<HashMap<String, Value>> {
        let mut mux = Mux::connect(&self.host.origin, self.api.cookie())?;
        let stream = mux.open("session/control", serde_json::json!({ "request": {} }))?;
        let opening = mux.read()?;
        let _ = mux.cancel(&stream);
        let frame = opening.get("value").cloned().unwrap_or(Value::Null);
        let mut values = HashMap::new();
        if let Some(entries) = frame
            .get("value")
            .and_then(|value| value.get("projections"))
            .and_then(Value::as_object)
        {
            for (session, entry) in entries {
                values.insert(
                    session.clone(),
                    entry.get("values").cloned().unwrap_or(Value::Null),
                );
            }
        }
        Ok(values)
    }

    pub fn load_conversation(&mut self) -> anyhow::Result<()> {
        let Some(index) = self.selected else {
            return Ok(());
        };
        let Some(session) = self.sessions.get(index).cloned() else {
            return Ok(());
        };
        self.messages.clear();
        let mut mux = Mux::connect(&self.host.origin, self.api.cookie())?;
        let address = serde_json::json!({ "kind": "session", "sessionId": session.id });
        let stream = mux.open(
            "session/follow",
            serde_json::json!({
                "request": { "address": address, "maxMessages": 60, "assistantStream": true }
            }),
        )?;
        let opening = mux.read()?;
        let _ = mux.cancel(&stream);
        if opening.get("type").and_then(Value::as_str) == Some("error") {
            return Ok(());
        }
        let snapshot = opening.get("value").cloned().unwrap_or(Value::Null);
        if let Some(values) = snapshot
            .get("projections")
            .and_then(|projections| projections.get("values"))
        {
            if let Some(session) = self.sessions.get_mut(index) {
                if let Some(title) = values.get("title").and_then(Value::as_str) {
                    session.title = title.to_string();
                }
                let model = model_of(values);
                if !model.is_empty() {
                    session.model = model;
                }
                session.context = context_of(values);
                session.tokens = tokens_of(values);
                session.questions = active_questions(values);
            }
        }
        let records = snapshot
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.messages = records_to_messages(&records);
        Ok(())
    }

    pub fn select(&mut self, index: usize) {
        self.selected = Some(index);
        let _ = self.load_conversation();
    }

    pub fn selected_session(&self) -> Option<&Session> {
        self.selected.and_then(|index| self.sessions.get(index))
    }

    pub fn send_prompt(&mut self, text: &str) -> anyhow::Result<()> {
        let Some(session) = self.selected_session() else {
            anyhow::bail!("会話が選択されていません");
        };
        let session_id = session.id.clone();
        let request_id = format!(
            "rdsh-desktop-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or(0)
        );
        self.api.unary(
            "session/prompt",
            serde_json::json!({
                "request": {
                    "requestId": request_id,
                    "sessionId": session_id,
                    "mode": "queue",
                    "content": [ { "type": "text", "text": text } ]
                }
            }),
        )?;
        Ok(())
    }

    pub fn cancel(&self) -> anyhow::Result<()> {
        let Some(session) = self.selected_session() else {
            return Ok(());
        };
        let session_id = session.id.clone();
        self.api
            .unary("session/cancel", serde_json::json!({ "sessionId": session_id }))?;
        Ok(())
    }

    pub fn select_model(&mut self, provider: &str, model: &str) -> anyhow::Result<()> {
        let Some(session) = self.selected_session() else {
            anyhow::bail!("会話が選択されていません");
        };
        let session_id = session.id.clone();
        self.api.unary(
            "session/selectModel",
            serde_json::json!({
                "request": { "sessionId": session_id, "provider": provider, "model": model }
            }),
        )?;
        if let Some(index) = self.selected {
            if let Some(session) = self.sessions.get_mut(index) {
                session.model = Model {
                    provider: provider.to_string(),
                    model: model.to_string(),
                };
            }
        }
        Ok(())
    }

    pub fn create_session(&mut self, cwd: Option<&str>) -> anyhow::Result<String> {
        let mut request = serde_json::json!({});
        if let Some(cwd) = cwd {
            request["cwd"] = Value::String(cwd.to_string());
        }
        let value = self
            .api
            .unary("session/create", serde_json::json!({ "request": request }))?;
        let id = value
            .get("sessionId")
            .or_else(|| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            anyhow::bail!("作成された会話IDを取得できませんでした");
        }
        self.sessions.insert(
            0,
            Session {
                id: id.clone(),
                cwd: cwd.unwrap_or_default().to_string(),
                updated: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_millis() as i64)
                    .unwrap_or(0),
                blank: true,
                running: false,
                title: String::new(),
                model: Model::default(),
                context: String::new(),
                tokens: String::new(),
                questions: 0,
            },
        );
        self.selected = Some(0);
        self.messages.clear();
        Ok(id)
    }

    pub fn approve(
        &self,
        client_id: &str,
        event_id: &str,
        allow: bool,
    ) -> anyhow::Result<()> {
        let value = if allow { "allowed-once" } else { "rejected" };
        self.api.unary(
            "$events/result",
            serde_json::json!({
                "clientId": client_id,
                "eventId": event_id,
                "outcome": { "kind": "result", "value": value }
            }),
        )?;
        Ok(())
    }

    pub fn answer_question(
        &self,
        session_id: &str,
        call_id: &str,
        label: &str,
    ) -> anyhow::Result<()> {
        self.api.unary(
            "userQuestions/answer",
            serde_json::json!({
                "sessionId": session_id,
                "callId": call_id,
                "answer": { "answers": [ { "id": "q1", "selected": [label] } ] }
            }),
        )?;
        Ok(())
    }

    pub fn fill_titles(
        &mut self,
        limit: usize,
        mut on_batch: impl FnMut(Vec<(String, String)>),
    ) {
        let pending: Vec<String> = self
            .sessions
            .iter()
            .filter(|session| session.title.is_empty())
            .take(limit)
            .map(|session| session.id.clone())
            .collect();
        let mut batch = Vec::new();
        for id in pending {
            if let Ok(title) = self.session_title(&id) {
                if !title.is_empty() {
                    if let Some(session) = self.sessions.iter_mut().find(|session| session.id == id) {
                        session.title = title.clone();
                    }
                    batch.push((id, title));
                }
            }
            if batch.len() >= 8 {
                on_batch(std::mem::take(&mut batch));
            }
        }
        if !batch.is_empty() {
            on_batch(batch);
        }
    }

    pub fn session_title(&self, session: &str) -> anyhow::Result<String> {
        fetch_title(self.origin(), self.api.cookie(), session)
    }

    pub fn groups(&self) -> Vec<Group> {
        let mut groups: Vec<Group> = Vec::new();
        for (index, session) in self.sessions.iter().enumerate() {
            let label = project_label(&session.cwd);
            match groups.iter_mut().find(|group| group.label == label) {
                Some(group) => group.sessions.push((index, session.clone())),
                None => groups.push(Group {
                    label,
                    path: project_path(&session.cwd),
                    sessions: vec![(index, session.clone())],
                }),
            }
        }
        groups
    }
}


/// Read one conversation title over a short-lived socket. Free function so the
/// title workers can run after the window already owns the connection.
pub fn fetch_title(origin: &str, cookie: &str, session: &str) -> anyhow::Result<String> {
    let mut mux = Mux::connect(origin, cookie)?;
    let address = serde_json::json!({ "kind": "session", "sessionId": session });
    let stream = mux.open(
        "session/follow",
        serde_json::json!({ "request": { "address": address, "maxMessages": 1 } }),
    )?;
    let opening = mux.read()?;
    let _ = mux.cancel(&stream);
    let value = opening.get("value").cloned().unwrap_or(Value::Null);
    Ok(value
        .get("projections")
        .and_then(|projections| projections.get("values"))
        .and_then(|values| values.get("title"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

fn model_of(values: &Value) -> Model {
    let selection = values.get("modelSelection");
    let next = selection
        .and_then(|selection| selection.get("next"))
        .or_else(|| selection.and_then(|selection| selection.get("lastUsed")));
    Model {
        provider: next
            .and_then(|next| next.get("provider"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: next
            .and_then(|next| next.get("model"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn context_of(values: &Value) -> String {
    let pressure = values.get("contextPressure");
    let used = pressure
        .and_then(|pressure| pressure.get("pressureTokens"))
        .and_then(Value::as_i64);
    let window = pressure
        .and_then(|pressure| pressure.get("contextWindow"))
        .and_then(Value::as_i64);
    match (used, window) {
        (Some(used), Some(window)) if window > 0 => {
            format!("ctx {}%", (used * 100 / window).min(100))
        }
        (Some(used), _) => format!("ctx {}", compact(used)),
        _ => String::new(),
    }
}

fn tokens_of(values: &Value) -> String {
    let usage = values.get("tokenUsage");
    let input = usage
        .and_then(|usage| usage.get("uncachedInputTokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output = usage
        .and_then(|usage| usage.get("outputTokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if input == 0 && output == 0 {
        return String::new();
    }
    format!("{} in / {} out", compact(input), compact(output))
}

fn active_questions(values: &Value) -> usize {
    values
        .get("userQuestions")
        .and_then(|questions| questions.get("active"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn compact(value: i64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.0}k", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn part_text(parts: &Value, kind: &str) -> String {
    let Some(items) = parts.as_array() else {
        return String::new();
    };
    let mut text = String::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some(kind) {
            if let Some(value) = item.get("text").and_then(Value::as_str) {
                text.push_str(value);
            }
        }
    }
    text
}

fn records_to_messages(records: &[Value]) -> Vec<Message> {
    let mut messages = Vec::new();
    for record in records {
        let event = record.get("event").cloned().unwrap_or(Value::Null);
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("event");
        let data = event.get("data").cloned().unwrap_or(Value::Null);
        match kind {
            "user/message" => {
                let mut text = part_text(data.get("content").unwrap_or(&Value::Null), "text");
                if text.is_empty() {
                    collect_text(&data, &mut text);
                }
                if !text.trim().is_empty() {
                    messages.push(Message {
                        role: "user".to_string(),
                        text: text.trim().to_string(),
                    });
                }
            }
            "assistant/message" => {
                let content = data.get("content").cloned().unwrap_or(Value::Null);
                let reasoning = part_text(&content, "reasoning");
                if !reasoning.trim().is_empty() {
                    messages.push(Message {
                        role: "reasoning".to_string(),
                        text: reasoning.trim().to_string(),
                    });
                }
                let text = part_text(&content, "text");
                if !text.trim().is_empty() {
                    messages.push(Message {
                        role: "assistant".to_string(),
                        text: text.trim().to_string(),
                    });
                }
            }
            "tool/call" => {
                let name = data
                    .get("name")
                    .or_else(|| data.get("toolName"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let mut summary = String::new();
                collect_text(data.get("args").unwrap_or(&Value::Null), &mut summary);
                let summary = summary.trim();
                let text = if summary.is_empty() {
                    name.to_string()
                } else {
                    format!("{name} · {}", truncate(summary, 120))
                };
                messages.push(Message {
                    role: "tool".to_string(),
                    text,
                });
            }
            _ => {}
        }
    }
    messages
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

pub(crate) fn collect_text(value: &Value, out: &mut String) {
    match value {
        Value::String(text) => out.push_str(text),
        Value::Array(items) => {
            for item in items {
                collect_text(item, out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                if matches!(key.as_str(), "text" | "content") {
                    collect_text(item, out);
                }
            }
        }
        _ => {}
    }
}

pub fn project_label(cwd: &str) -> String {
    if cwd.is_empty() {
        return "その他".to_string();
    }
    let name = cwd.trim_end_matches('/').rsplit('/').next().unwrap_or(cwd);
    if let Some((prefix, rest)) = name.split_once('-') {
        if prefix.len() >= 8 && prefix.chars().all(|character| character.is_ascii_hexdigit()) {
            return rest.to_string();
        }
    }
    name.to_string()
}

pub fn project_path(cwd: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let short = if !home.is_empty() && cwd.starts_with(&home) {
        format!("~{}", &cwd[home.len()..])
    } else {
        cwd.to_string()
    };
    let parts: Vec<&str> = short.trim_end_matches('/').split('/').collect();
    match parts.len() {
        0 => short,
        1 => parts[0].to_string(),
        _ => format!(
            "{}/{}",
            parts[parts.len() - 2],
            project_label(short.as_str())
        ),
    }
}

fn short_model(model: &str) -> String {
    model.rsplit('/').next().unwrap_or(model).to_string()
}

#[cfg(test)]
mod tests {
    use super::{project_label, project_path, short_model, Model};

    #[test]
    fn strips_checkout_hashes_from_folder_names() {
        assert_eq!(
            project_label("/home/sahen/Projects/windows-migration/c1a2a17f4caf-rustdsh"),
            "rustdsh"
        );
    }

    #[test]
    fn keeps_plain_folder_names() {
        assert_eq!(project_label("/home/sahen/File/Prog/rustdsh"), "rustdsh");
        assert_eq!(project_label("/srv/team/26.10.04"), "26.10.04");
        assert_eq!(project_label(""), "その他");
    }

    #[test]
    fn header_shows_parent_and_project_for_foreign_paths() {
        assert_eq!(project_path("/srv/work/rustdsh"), "work/rustdsh");
        assert_eq!(
            project_path("/srv/team/2026/c1a2a17f4caf-rustdsh"),
            "2026/rustdsh"
        );
    }

    #[test]
    fn model_label_keeps_the_provider_visible() {
        let model = Model {
            provider: "commandcode-goat".to_string(),
            model: "deepseek/deepseek-v4.1-flash".to_string(),
        };
        assert_eq!(model.label(), "deepseek-v4.1-flash · commandcode-goat");
        assert_eq!(
            short_model("opencode/deepseek-v4.1-flash-free"),
            "deepseek-v4.1-flash-free"
        );
    }

    #[test]
    fn empty_model_is_reported_as_empty() {
        assert!(Model::default().is_empty());
    }
}

fn short_id(id: &str) -> String {
    id.chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn relative(updated: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    let minutes = ((now - updated) / 60_000).max(0);
    if minutes < 1 {
        "たった今".to_string()
    } else if minutes < 60 {
        format!("{minutes}分前")
    } else if minutes < 60 * 24 {
        format!("{}時間前", minutes / 60)
    } else {
        format!("{}日前", minutes / (60 * 24))
    }
}

pub struct DesktopApp {
    chat: Option<Box<Chat>>,
    titles: HashMap<String, String>,
    status: String,
    input: String,
    focus: FocusHandle,
    live: Sender<LiveCmd>,
    pending: Option<Pending>,
    client_id: Option<String>,
    streaming: String,
    running: bool,
    dirty: bool,
    picker: bool,
    sidebar_scroll: ScrollHandle,
    timeline_scroll: ScrollHandle,
}

impl DesktopApp {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let (update_tx, update_rx) = mpsc::channel();
        let (live_cmd_tx, live_cmd_rx) = mpsc::channel();
        let (live_evt_tx, live_evt_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let progress = update_tx.clone();
            let mut chat = match Chat::connect(move |step| {
                let _ = progress.send(Update::Step(step.to_string()));
            }) {
                Ok(chat) => chat,
                Err(error) => {
                    let _ = update_tx.send(Update::Failed(format!(
                        "ハーネスに接続できませんでした: {error}"
                    )));
                    return;
                }
            };
            // Ready arrives before titles: the sidebar shows the list at once and
            // titles stream in from worker threads while the window is usable.
            let origin = chat.origin().to_string();
            let cookie = chat.cookie().to_string();
            let pending: Vec<String> = chat
                .sessions
                .iter()
                .filter(|session| session.title.is_empty())
                .take(80)
                .map(|session| session.id.clone())
                .collect();
            let titles = update_tx.clone();
            let _ = update_tx.send(Update::Ready(Box::new(chat)));
            if !pending.is_empty() {
                std::thread::spawn(move || {
                    let queue = std::sync::Arc::new(std::sync::Mutex::new(pending));
                    let mut workers = Vec::new();
                    for _ in 0..4 {
                        let queue = queue.clone();
                        let titles = titles.clone();
                        let origin = origin.clone();
                        let cookie = cookie.clone();
                        workers.push(std::thread::spawn(move || loop {
                            let next = queue.lock().ok().and_then(|mut queue| queue.pop());
                            let Some(id) = next else {
                                break;
                            };
                            if let Ok(title) = fetch_title(&origin, &cookie, &id) {
                                if !title.is_empty() {
                                    let _ = titles.send(Update::Titles(vec![(id, title)]));
                                }
                            }
                        }));
                    }
                    for worker in workers {
                        let _ = worker.join();
                    }
                });
            }
        });

        poll(cx, update_rx, live_evt_rx, live_cmd_rx, live_evt_tx);

        Self {
            chat: None,
            titles: HashMap::new(),
            status: "ハーネスを起動しています…".to_string(),
            input: String::new(),
            focus: cx.focus_handle(),
            live: live_cmd_tx,
            pending: None,
            client_id: None,
            streaming: String::new(),
            running: false,
            dirty: false,
            picker: false,
            sidebar_scroll: ScrollHandle::new(),
            timeline_scroll: ScrollHandle::new(),
        }
    }

    fn follow_selected(&self) {
        let Some(session) = self.chat.as_ref().and_then(|chat| chat.selected_session()) else {
            return;
        };
        let id = session.id.clone();
        let _ = self.live.send(LiveCmd::Follow(id));
    }

    fn submit(&mut self) {
        let text = self.input.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.input.clear();
        let Some(chat) = self.chat.as_mut() else {
            self.status = "接続が完了していません".to_string();
            return;
        };
        match chat.send_prompt(&text) {
            Ok(()) => {
                self.status = "送信しました".to_string();
                self.running = true;
                self.follow_selected();
            }
            Err(error) => self.status = format!("送信できませんでした: {error}"),
        }
    }

    fn stop(&mut self) {
        if let Some(chat) = self.chat.as_ref() {
            match chat.cancel() {
                Ok(()) => self.status = "停止を要求しました".to_string(),
                Err(error) => self.status = format!("停止できませんでした: {error}"),
            }
        }
        self.running = false;
    }

    fn new_conversation(&mut self) {
        let cwd = self
            .chat
            .as_ref()
            .and_then(|chat| chat.selected_session())
            .map(|session| session.cwd.clone())
            .filter(|cwd| !cwd.is_empty());
        let Some(chat) = self.chat.as_mut() else {
            return;
        };
        match chat.create_session(cwd.as_deref()) {
            Ok(_) => {
                self.status = "新しい会話を作成しました".to_string();
                self.running = false;
                self.streaming.clear();
                self.follow_selected();
            }
            Err(error) => self.status = format!("作成できませんでした: {error}"),
        }
    }

    fn answer_pending(&mut self, allow: bool, choice: Option<String>) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        let Some(chat) = self.chat.as_mut() else {
            return;
        };
        let result = match (pending, choice) {
            (Pending::Approval { event_id, .. }, _) => match self.client_id.clone() {
                Some(client_id) => chat.approve(&client_id, &event_id, allow),
                None => Ok(()),
            },
            (Pending::Question { call_id, session_id, .. }, Some(label)) => {
                chat.answer_question(&session_id, &call_id, &label)
            }
            (Pending::Question { .. }, None) => Ok(()),
        };
        match result {
            Ok(()) => self.status = "応答しました".to_string(),
            Err(error) => self.status = format!("応答できませんでした: {error}"),
        }
    }
}

fn poll(
    cx: &mut Context<DesktopApp>,
    updates: Receiver<Update>,
    live_events: Receiver<LiveEvent>,
    live_cmd: Receiver<LiveCmd>,
    live_out: Sender<LiveEvent>,
) {
    cx.spawn(async move |this, cx| {
        // Startup: wait for the background connect, then start the live threads.
        loop {
            match updates.try_recv() {
                Ok(Update::Step(step)) => {
                    let _ = this.update(cx, |app, cx| {
                        app.status = step;
                        cx.notify();
                    });
                }
                Ok(Update::Titles(batch)) => {
                    let _ = this.update(cx, |app, cx| {
                        for (id, title) in batch {
                            app.titles.insert(id, title);
                        }
                        cx.notify();
                    });
                }
                Ok(Update::Ready(chat)) => {
                    let origin = chat.origin().to_string();
                    let cookie = chat.cookie().to_string();
                    live::spawn(&origin, &cookie, live_cmd, live_out.clone());
                    let follow = chat.selected_session().map(|session| session.id.clone());
                    let _ = this.update(cx, |app, cx| {
                        app.status = chat.status.clone();
                        app.chat = Some(chat);
                        app.running = false;
                        cx.notify();
                    });
                    if let Some(id) = follow {
                        let _ = this.update(cx, |app, _| {
                            let _ = app.live.send(LiveCmd::Follow(id));
                        });
                    }
                    break;
                }
                Ok(Update::Failed(error)) => {
                    let _ = this.update(cx, |app, cx| {
                        app.status = error;
                        cx.notify();
                    });
                    return;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => return,
            }
            cx.background_executor().timer(POLL).await;
        }

        // Live loop: stream deltas, pending decisions and debounced reloads.
        let mut last_reload = Instant::now();
        loop {
            let mut changed = false;
            loop {
                match live_events.try_recv() {
                    Ok(LiveEvent::Ready(client_id)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.client_id = Some(client_id);
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Pending(pending)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.status = "応答待ちの要求があります".to_string();
                            app.pending = Some(pending);
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Dismissed(_)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.pending = None;
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Delta(text)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.streaming.push_str(&text);
                            app.running = true;
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Activity) => {
                        let _ = this.update(cx, |app, _| {
                            app.dirty = true;
                            app.running = true;
                        });
                    }
                    Ok(LiveEvent::Idle) => {
                        let _ = this.update(cx, |app, cx| {
                            app.running = false;
                            app.dirty = true;
                            cx.notify();
                        });
                    }
                    Ok(LiveEvent::Note(note)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.status = note;
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Closed(error)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.status = format!("ストリームが切れました: {error}");
                            app.running = false;
                            cx.notify();
                        });
                        changed = true;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            if last_reload.elapsed() >= RELOAD_AFTER {
                let should_reload = this
                    .update(cx, |app, _| {
                        let dirty = app.dirty;
                        app.dirty = false;
                        dirty
                    })
                    .unwrap_or(false);
                if should_reload {
                    let _ = this.update(cx, |app, cx| {
                        if let Some(chat) = app.chat.as_mut() {
                            let _ = chat.load_conversation();
                        }
                        app.streaming.clear();
                        cx.notify();
                    });
                }
                last_reload = Instant::now();
            }
            let _ = changed;
            cx.background_executor().timer(POLL).await;
        }
    })
    .detach();
}

impl Render for DesktopApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let groups = self
            .chat
            .as_ref()
            .map(|chat| chat.groups())
            .unwrap_or_default();
        let selected = self.chat.as_ref().and_then(|chat| chat.selected);
        let messages = self
            .chat
            .as_ref()
            .map(|chat| chat.messages.clone())
            .unwrap_or_default();
        let catalog = self
            .chat
            .as_ref()
            .map(|chat| chat.catalog.clone())
            .unwrap_or_default();
        let current = self
            .chat
            .as_ref()
            .and_then(|chat| chat.selected_session().cloned());
        let status = self.status.clone();
        let input = self.input.clone();
        let titles = self.titles.clone();
        let loading = self.chat.is_none();
        let streaming = self.streaming.clone();
        let running = self.running;
        let picker = self.picker;
        let pending = self.pending.clone();

        let sidebar = div()
            .flex()
            .flex_col()
            .w(px(theme::SIDEBAR_DEFAULT))
            .h_full()
            .bg(theme::sidebar())
            .border_r_1()
            .border_color(theme::hairline())
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(theme::LOGO_ROW_HEIGHT))
                    .px(px(16.))
                    .child(
                        div()
                            .text_size(theme::heading_size())
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme::label())
                            .child("DeepSeek Harness"),
                    ),
            )
            .child(
                div()
                    .id("new-session")
                    .mx(px(12.))
                    .mb(px(10.))
                    .h(px(theme::NEW_SESSION_HEIGHT))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(theme::radius_md())
                    .border_1()
                    .border_color(theme::border())
                    .text_size(theme::meta_size())
                    .text_color(theme::label())
                    .cursor_pointer()
                    .hover(|style| style.bg(rgb(0xf1f2f5)))
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.new_conversation();
                        cx.notify();
                    }))
                    .child("+ 新しい会話"),
            )
            .child(
                div()
                    .id("sessions")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.sidebar_scroll)
                    .px(px(8.))
                    .when(loading, |element| {
                        element.children((0..8).map(|row| {
                            div()
                                .h(px(theme::SESSION_ROW_HEIGHT))
                                .mb(px(6.))
                                .mx(px(4.))
                                .rounded(theme::radius_sm())
                                .bg(rgb(0xf1f2f4))
                                .when(row % 3 == 0, |element| element.w(px(120.)))
                                .when(row % 3 == 1, |element| element.w(px(180.)))
                                .when(row % 3 == 2, |element| element.w(px(150.)))
                        }))
                    })
                    .when(!loading, |element| {
                        // Only the rows that fit the viewport are built; a long
                        // history would otherwise create thousands of elements
                        // on every frame.
                        let mut budget = 60usize;
                        element.children(groups.into_iter().filter_map(|group| {
                            if budget == 0 {
                                return None;
                            }
                            let rows: Vec<AnyElement> = group
                                .sessions
                                .into_iter()
                                .take(budget)
                                .map(|(index, session)| {
                                    let active = selected == Some(index);
                                    let title = titles
                                        .get(&session.id)
                                        .cloned()
                                        .filter(|title| !title.is_empty())
                                        .or_else(|| {
                                            (!session.title.is_empty())
                                                .then(|| session.title.clone())
                                        })
                                        .unwrap_or_else(|| {
                                            if session.blank {
                                                "新しい会話".to_string()
                                            } else {
                                                short_id(&session.id)
                                            }
                                        });
                                    div()
                                        .id(("session", index))
                                        .flex()
                                        .flex_col()
                                        .justify_center()
                                        .gap(px(1.))
                                        .h(px(theme::SESSION_ROW_HEIGHT + 10.))
                                        .px(px(10.))
                                        .mb(px(1.))
                                        .rounded(theme::radius_sm())
                                        .cursor_pointer()
                                        .when(active, |element| element.bg(rgb(0xe9ecf1)))
                                        .hover(|style| style.bg(rgb(0xf1f2f5)))
                                        .on_click(cx.listener(move |this, _event, _window, cx| {
                                            if let Some(chat) = this.chat.as_mut() {
                                                chat.select(index);
                                                this.status = format!(
                                                    "{} メッセージ",
                                                    chat.messages.len()
                                                );
                                            }
                                            this.running = false;
                                            this.streaming.clear();
                                            this.follow_selected();
                                            cx.notify();
                                        }))
                                        .child(
                                            div()
                                                .flex()
                                                .flex_row()
                                                .items_center()
                                                .gap(px(6.))
                                                .when(session.running, |element| {
                                                    element.child(
                                                        div()
                                                            .w(px(6.))
                                                            .h(px(6.))
                                                            .rounded(px(999.))
                                                            .bg(theme::accent()),
                                                    )
                                                })
                                                .child(
                                                    div()
                                                        .text_size(theme::meta_size())
                                                        .text_color(theme::label())
                                                        .child(title),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .text_size(theme::micro_size())
                                                .text_color(theme::tertiary())
                                                .child(format!(
                                                    "{} ・ {}",
                                                    relative(session.updated),
                                                    short_id(&session.id)
                                                )),
                                        )
                                        .into_any_element()
                                })
                                .collect();
                            budget = budget.saturating_sub(rows.len());
                            Some(
                            div()
                                .flex()
                                .flex_col()
                                .mb(px(6.))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .h(px(theme::PROJECT_ROW_HEIGHT))
                                        .px(px(10.))
                                        .child(
                                            div()
                                                .text_size(theme::micro_size())
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme::tertiary())
                                                .child(group.path.clone()),
                                        ),
                                )
                                .children(rows)
                                .into_any_element(),
                            )
                        }))
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(theme::TOP_STRIP_HEIGHT))
                    .px(px(16.))
                    .border_t_1()
                    .border_color(theme::hairline())
                    .child(
                        div()
                            .text_size(theme::micro_size())
                            .text_color(theme::tertiary())
                            .child(status),
                    ),
            );

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .min_h(px(theme::HEADER_MIN_HEIGHT))
            .px(px(28.))
            .border_b_1()
            .border_color(theme::hairline())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(
                        div()
                            .text_size(theme::title_size())
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme::label())
                            .child(match current.as_ref() {
                                Some(session) => titles
                                    .get(&session.id)
                                    .cloned()
                                    .filter(|title| !title.is_empty())
                                    .or_else(|| {
                                        (!session.title.is_empty()).then(|| session.title.clone())
                                    })
                                    .unwrap_or_else(|| project_path(&session.cwd)),
                                None => "会話を選択してください".to_string(),
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(10.))
                            .text_size(theme::micro_size())
                            .text_color(theme::tertiary())
                            .child(
                                current
                                    .as_ref()
                                    .map(|session| project_path(&session.cwd))
                                    .unwrap_or_default(),
                            )
                            .when(
                                current
                                    .as_ref()
                                    .map(|session| !session.context.is_empty())
                                    .unwrap_or(false),
                                |element| {
                                    element.child(
                                        current
                                            .as_ref()
                                            .map(|session| session.context.clone())
                                            .unwrap_or_default(),
                                    )
                                },
                            )
                            .when(
                                current
                                    .as_ref()
                                    .map(|session| !session.tokens.is_empty())
                                    .unwrap_or(false),
                                |element| {
                                    element.child(
                                        current
                                            .as_ref()
                                            .map(|session| session.tokens.clone())
                                            .unwrap_or_default(),
                                    )
                                },
                            )
                            .when(
                                current
                                    .as_ref()
                                    .map(|session| session.questions > 0)
                                    .unwrap_or(false),
                                |element| {
                                    element.child(
                                        current
                                            .as_ref()
                                            .map(|session| {
                                                format!("未回答の質問 {}", session.questions)
                                            })
                                            .unwrap_or_default(),
                                    )
                                },
                            ),
                    ),
            );

        let mut rows: Vec<AnyElement> = messages
            .iter()
            .map(|message| {
                let bubble = div()
                    .max_w(px(620.))
                    .px(px(16.))
                    .py(px(10.))
                    .rounded(theme::radius_xl())
                    .text_size(theme::body_size())
                    .line_height(theme::body_line_height())
                    .text_color(theme::label())
                    .when(message.role == "user", |element| {
                        element.bg(theme::user_bubble())
                    })
                    .when(message.role == "assistant", |element| {
                        element.bg(theme::code_block())
                    })
                    .when(message.role == "reasoning", |element| {
                        element
                            .bg(rgb(0xfafafa))
                            .text_color(theme::tertiary())
                            .border_l_1()
                            .border_color(theme::border())
                    })
                    .child(message.text.clone());
                let row = div()
                    .flex()
                    .w_full()
                    .mb(px(14.))
                    .when(message.role == "user", |element| element.justify_end())
                    .when(message.role != "user", |element| element.justify_start());
                if message.role == "tool" {
                    return row
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .px(px(10.))
                                .py(px(4.))
                                .rounded(theme::radius_sm())
                                .bg(rgb(0xf4f5f7))
                                .text_size(theme::micro_size())
                                .text_color(theme::secondary())
                                .child("tool")
                                .child(message.text.clone()),
                        )
                        .into_any_element();
                }
                row.child(bubble).into_any_element()
            })
            .collect();
        if !streaming.is_empty() {
            rows.push(
                div()
                    .flex()
                    .w_full()
                    .mb(px(14.))
                    .justify_start()
                    .child(
                        div()
                            .max_w(px(620.))
                            .px(px(16.))
                            .py(px(10.))
                            .rounded(theme::radius_xl())
                            .bg(theme::code_block())
                            .text_size(theme::body_size())
                            .line_height(theme::body_line_height())
                            .text_color(theme::secondary())
                            .child(streaming.clone()),
                    )
                    .into_any_element(),
            );
        }
        if messages.is_empty() && streaming.is_empty() {
            rows.push(
                div()
                    .text_size(theme::body_size())
                    .text_color(theme::tertiary())
                    .child("この会話にはまだメッセージがありません")
                    .into_any_element(),
            );
        }

        let timeline = div()
            .id("timeline")
            .flex()
            .flex_col()
            .flex_1()
            .overflow_y_scroll()
            .track_scroll(&self.timeline_scroll)
            .px(px(32.))
            .py(px(24.))
            .children(rows);

        let banner = pending.as_ref().map(|pending| match pending {
            Pending::Approval { tool, reason, .. } => {
                let (tool, reason) = (tool.clone(), reason.clone());
                div()
                    .mx(px(32.))
                    .mb(px(10.))
                    .px(px(16.))
                    .py(px(12.))
                    .rounded(theme::radius_lg())
                    .bg(rgb(0xfff7e8))
                    .border_1()
                    .border_color(theme::border())
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(theme::meta_size())
                            .text_color(theme::label())
                            .child(format!("承認待ち: {tool}")),
                    )
                    .when(!reason.is_empty(), |element| {
                        element.child(
                            div()
                                .text_size(theme::micro_size())
                                .text_color(theme::secondary())
                                .child(reason),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(8.))
                            .child(action_button("allow", "許可", true, cx, |this, _| {
                                this.answer_pending(true, None)
                            }))
                            .child(action_button("deny", "拒否", false, cx, |this, _| {
                                this.answer_pending(false, None)
                            })),
                    )
                    .into_any_element()
            }
            Pending::Question {
                question, options, ..
            } => {
                let question = question.clone();
                let options = options.clone();
                let mut buttons = div().flex().flex_row().gap(px(8.));
                for (index, option) in options.into_iter().enumerate() {
                    let label = option.clone();
                    buttons = buttons.child(action_button(
                        ("answer", index),
                        label,
                        true,
                        cx,
                        move |this, label: &str| {
                            let label = label.to_string();
                            this.answer_pending(true, Some(label))
                        },
                    ));
                }
                div()
                    .mx(px(32.))
                    .mb(px(10.))
                    .px(px(16.))
                    .py(px(12.))
                    .rounded(theme::radius_lg())
                    .bg(rgb(0xf2f6ff))
                    .border_1()
                    .border_color(theme::border())
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(theme::meta_size())
                            .text_color(theme::label())
                            .child(if question.is_empty() {
                                "質問".to_string()
                            } else {
                                question
                            }),
                    )
                    .child(buttons)
                    .into_any_element()
            }
        });

        let picker_panel = picker.then(|| {
            let mut list = div().flex().flex_col().gap(px(2.)).px(px(8.)).py(px(6.));
            for entry in catalog.iter().take(60) {
                let provider = entry.provider.clone();
                let model = entry.model.clone();
                let label = entry.label.clone();
                list = list.child(
                    div()
                        .id(SharedString::from(format!("model-{provider}/{model}")))
                        .h(px(28.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .rounded(theme::radius_sm())
                        .cursor_pointer()
                        .hover(|style| style.bg(rgb(0xf1f2f5)))
                        .text_size(theme::micro_size())
                        .text_color(theme::label())
                        .on_click(cx.listener(move |this, _event, _window, cx| {
                            if let Some(chat) = this.chat.as_mut() {
                                match chat.select_model(&provider, &model) {
                                    Ok(()) => this.status = format!("モデルを変更: {model}"),
                                    Err(error) => this.status = format!("変更できません: {error}"),
                                }
                            }
                            this.picker = false;
                            cx.notify();
                        }))
                        .child(label),
                );
            }
            div()
                .mx(px(32.))
                .mb(px(8.))
                .max_h(px(260.))
                .overflow_hidden()
                .rounded(theme::radius_lg())
                .bg(theme::page())
                .border_1()
                .border_color(theme::border())
                .child(list)
                .into_any_element()
        });

        let composer = div()
            .id("composer")
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .gap(px(6.))
            .mx(px(32.))
            .mb(px(20.))
            .px(px(18.))
            .py(px(12.))
            .rounded(theme::radius_panel())
            .bg(theme::composer())
            .border_1()
            .border_color(theme::border())
            .on_click(cx.listener(|this, _event, window, cx| {
                this.focus.focus(window);
                cx.notify();
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                match event.keystroke.key.as_str() {
                    "enter" => this.submit(),
                    "backspace" => {
                        this.input.pop();
                    }
                    "space" => this.input.push(' '),
                    _ => {
                        if let Some(text) = event.keystroke.key_char.as_ref() {
                            this.input.push_str(text);
                        }
                    }
                }
                cx.notify();
            }))
            .child(
                div()
                    .min_h(px(theme::COMPOSER_MIN_HEIGHT))
                    .flex()
                    .items_center()
                    .text_size(theme::body_size())
                    .text_color(if input.is_empty() {
                        theme::tertiary()
                    } else {
                        theme::label()
                    })
                    .child(if input.is_empty() {
                        "メッセージを入力…".to_string()
                    } else {
                        input.clone()
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .id("model-chip")
                            .px(px(8.))
                            .py(px(2.))
                            .rounded(theme::radius_sm())
                            .cursor_pointer()
                            .hover(|style| style.bg(rgb(0xf1f2f5)))
                            .text_size(theme::micro_size())
                            .text_color(theme::secondary())
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.picker = !this.picker;
                                cx.notify();
                            }))
                            .child(
                                current
                                    .as_ref()
                                    .map(|session| session.model.label())
                                    .filter(|label| !label.is_empty())
                                    .unwrap_or_else(|| "モデルを選択".to_string()),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .when(running, |element| {
                                element.child(
                                    div()
                                        .id("stop")
                                        .w(px(34.))
                                        .h(px(34.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(999.))
                                        .bg(rgb(0xf1f2f5))
                                        .text_size(theme::meta_size())
                                        .text_color(theme::label())
                                        .cursor_pointer()
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.stop();
                                            cx.notify();
                                        }))
                                        .child("■"),
                                )
                            })
                            .child(
                                div()
                                    .id("send")
                                    .w(px(34.))
                                    .h(px(34.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(999.))
                                    .bg(theme::accent())
                                    .text_size(theme::meta_size())
                                    .text_color(rgb(0xffffff))
                                    .cursor_pointer()
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        this.submit();
                                        cx.notify();
                                    }))
                                    .child("↑"),
                            ),
                    ),
            );

        let center = div()
            .flex()
            .flex_col()
            .flex_1()
            .h_full()
            .bg(theme::page())
            .child(header)
            .child(timeline)
            .children(banner)
            .children(picker_panel)
            .child(composer);

        div()
            .flex()
            .flex_row()
            .size_full()
            .bg(theme::page())
            .text_color(theme::label())
            .text_size(theme::body_size())
            .child(sidebar)
            .child(center)
            .into_any_element()
    }
}

fn action_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    primary: bool,
    cx: &mut Context<DesktopApp>,
    action: impl Fn(&mut DesktopApp, &str) + 'static,
) -> AnyElement {
    let element_id = id.into();
    let text: SharedString = label.into();
    let label_string = text.to_string();
    div()
        .id(element_id)
        .px(px(12.))
        .py(px(6.))
        .rounded(theme::radius_sm())
        .cursor_pointer()
        .when(primary, |element| element.bg(theme::accent()))
        .when(!primary, |element| element.bg(theme::page()))
        .border_1()
        .border_color(theme::border())
        .text_size(theme::micro_size())
        .text_color(if primary {
            rgb(0xffffff)
        } else {
            theme::label()
        })
        .on_click(cx.listener(move |this, _event, _window, cx| {
            action(this, &label_string);
            cx.notify();
        }))
        .child(text)
        .into_any_element()
}
