//! Live connections: the host-wide event stream and the followed conversation.
//!
//! Two background threads keep sockets open and forward what they see:
//!   * events:  the $events logical stream (approvals, questions, list activity)
//!   * follow:  the selected conversation (assistant deltas, durable events)
//! Unary calls (cancel, approve, answer, create, selectModel) stay on the caller
//! so no command channel is needed for them.

use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::Duration;

use serde_json::Value;

use crate::mux::Mux;

/// One pending decision the host is waiting on.
#[derive(Clone, Debug)]
pub enum Pending {
    Approval {
        event_id: String,
        tool: String,
        reason: String,
    },
    Question {
        call_id: String,
        session_id: String,
        question: String,
        options: Vec<String>,
        multi: bool,
    },
}

#[derive(Clone, Debug)]
pub enum LiveEvent {
    Ready(String),
    Pending(Pending),
    Dismissed(String),
    Delta(String),
    Activity,
    Idle,
    Note(String),
    Closed(String),
}

/// Commands for the live threads. The app owns the sending half so the poller
/// can create the threads once the session cookie exists.
#[derive(Clone, Debug)]
pub enum LiveCmd {
    Follow(String),
    Stop,
}

/// Start the live threads; they report through the supplied sender.
pub fn spawn(
    origin: &str,
    cookie: &str,
    commands: Receiver<LiveCmd>,
    event_tx: Sender<LiveEvent>,
) {
    let events_origin = origin.to_string();
    let events_cookie = cookie.to_string();
    let events_out = event_tx.clone();
    std::thread::spawn(move || {
        if let Err(error) = run_events(&events_origin, &events_cookie, &events_out) {
            let _ = events_out.send(LiveEvent::Note(format!("イベント接続が切れました: {error}")));
        }
    });

    let follow_origin = origin.to_string();
    let follow_cookie = cookie.to_string();
    let follow_out = event_tx;
    std::thread::spawn(move || {
        run_follow(&follow_origin, &follow_cookie, &commands, &follow_out);
    });
}

fn run_events(origin: &str, cookie: &str, out: &Sender<LiveEvent>) -> anyhow::Result<()> {
    let mut mux = Mux::connect(origin, cookie)?;
    let stream = mux.open("$events", serde_json::json!({}))?;
    let mut client_id: Option<String> = None;
    loop {
        let message = mux.read()?;
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "end" || kind == "error" {
            break;
        }
        let value = message.get("value").cloned().unwrap_or(Value::Null);
        match value.get("type").and_then(Value::as_str).unwrap_or_default() {
            "ready" => {
                let id = value
                    .get("clientId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                client_id = Some(id.clone());
                let _ = out.send(LiveEvent::Ready(id));
            }
            "waterfall" => {
                let event_id = value
                    .get("eventId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = value.get("event").and_then(Value::as_str).unwrap_or_default();
                let request = value.get("request").cloned().unwrap_or(Value::Null);
                match name {
                    "approval/request" => {
                        let tool = request
                            .get("toolName")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let reason = request
                            .get("displayReason")
                            .or_else(|| request.get("reason"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let _ = out.send(LiveEvent::Pending(Pending::Approval {
                            event_id,
                            tool,
                            reason,
                        }));
                    }
                    "user-questions/request" => {
                        let call_id = request
                            .get("callId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let session_id = value
                            .get("agentId")
                            .or_else(|| request.get("agentId"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let first = request
                            .get("questions")
                            .and_then(Value::as_array)
                            .and_then(|questions| questions.first())
                            .cloned()
                            .unwrap_or(Value::Null);
                        let question = first
                            .get("question")
                            .or_else(|| first.get("header"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let options = first
                            .get("options")
                            .and_then(Value::as_array)
                            .map(|options| {
                                options
                                    .iter()
                                    .filter_map(|option| {
                                        option
                                            .get("label")
                                            .or_else(|| option.get("header"))
                                            .and_then(Value::as_str)
                                            .map(str::to_string)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let multi = first
                            .get("multiSelect")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let _ = out.send(LiveEvent::Pending(Pending::Question {
                            call_id,
                            session_id,
                            question,
                            options,
                            multi,
                        }));
                    }
                    other => {
                        let _ = out.send(LiveEvent::Note(format!("未対応の要求: {other}")));
                    }
                }
            }
            "cancel" => {
                let event_id = value
                    .get("eventId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let _ = out.send(LiveEvent::Dismissed(event_id));
            }
            "emit" => {
                let _ = out.send(LiveEvent::Activity);
            }
            _ => {}
        }
        let _ = client_id.as_deref();
        let _ = &stream;
    }
    Ok(())
}

fn run_follow(
    origin: &str,
    cookie: &str,
    commands: &Receiver<LiveCmd>,
    out: &Sender<LiveEvent>,
) {
    let mut current: Option<String> = None;
    let mut following: Option<String> = None;
    let mut mux: Option<Mux> = None;
    let mut stream = String::new();
    loop {
        // Apply pending commands without blocking the socket read for long.
        while let Ok(command) = commands.try_recv() {
            match command {
                LiveCmd::Follow(session) => current = Some(session),
                LiveCmd::Stop => {
                    current = None;
                    mux = None;
                    stream.clear();
                }
            }
        }
        if current != following {
            // (re)open for the requested session
            if let Some(session) = current.clone() {
                match follow_open(origin, cookie, &session) {
                    Ok((new_mux, new_stream)) => {
                        mux = Some(new_mux);
                        stream = new_stream;
                        following = Some(session);
                        let _ = out.send(LiveEvent::Activity);
                    }
                    Err(error) => {
                        let _ = out.send(LiveEvent::Note(format!("会話に接続できません: {error}")));
                        std::thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                }
            } else {
                mux = None;
                stream.clear();
                following = None;
            }
        }

        let Some(active) = mux.as_mut() else {
            std::thread::sleep(Duration::from_millis(120));
            continue;
        };
        match active.try_read() {
            Ok(Some(message)) => {
                let kind = message
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if kind == "error" {
                    let _ = out.send(LiveEvent::Note(format!(
                        "会話ストリーム: {}",
                        message.get("error").map(|error| error.to_string()).unwrap_or_default()
                    )));
                    mux = None;
                    stream.clear();
                    continue;
                }
                if kind == "end" {
                    let _ = out.send(LiveEvent::Idle);
                    mux = None;
                    stream.clear();
                    continue;
                }
                let value = message.get("value").cloned().unwrap_or(Value::Null);
                match value.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "assistant-stream" => {
                        let frame = value.get("frame").cloned().unwrap_or(Value::Null);
                        match frame.get("type").and_then(Value::as_str) {
                            Some("chunk") => {
                                let mut text = String::new();
                                crate::app::collect_text(
                                    frame.get("chunk").unwrap_or(&Value::Null),
                                    &mut text,
                                );
                                if !text.is_empty() {
                                    let _ = out.send(LiveEvent::Delta(text));
                                }
                            }
                            Some("end") => {
                                let _ = out.send(LiveEvent::Idle);
                            }
                            _ => {}
                        }
                    }
                    "event" => {
                        let _ = out.send(LiveEvent::Activity);
                    }
                    _ => {}
                }
            }
            Ok(None) => {}
            Err(error) => {
                let _ = out.send(LiveEvent::Closed(error.to_string()));
                mux = None;
                stream.clear();
                std::thread::sleep(Duration::from_millis(400));
            }
        }
        while let Ok(command) = commands.try_recv() {
            match command {
                LiveCmd::Follow(session) => current = Some(session),
                LiveCmd::Stop => {
                    current = None;
                    mux = None;
                    stream.clear();
                }
            }
        }
    }
}

fn follow_open(origin: &str, cookie: &str, session: &str) -> anyhow::Result<(Mux, String)> {
    let mut mux = Mux::connect(origin, cookie)?;
    mux.set_read_timeout(Duration::from_millis(300))?;
    let address = serde_json::json!({ "kind": "session", "sessionId": session });
    let stream = mux.open(
        "session/follow",
        serde_json::json!({
            "request": { "address": address, "maxMessages": 40, "assistantStream": true }
        }),
    )?;
    // The opening snapshot arrives first; report it as activity so the caller
    // loads the durable timeline.
    let _opening = mux.read()?;
    Ok((mux, stream))
}

#[allow(dead_code)]
fn unused(_: TryRecvError) {}
