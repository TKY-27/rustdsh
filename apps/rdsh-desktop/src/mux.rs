//! Multiplexed stream transport (/api/remote.mux).
//!
//! Unary calls ride plain POSTs, but conversation history and live events arrive
//! on one WebSocket multiplexed by streamId. The host pings every two seconds,
//! so the reader answers pings while it waits for the next message.

use std::net::TcpStream;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

pub struct Mux {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Mux {
    /// The browser-trust fence wants the session cookie; Origin is not sent.
    pub fn connect(origin: &str, cookie: &str) -> Result<Self> {
        let ws = origin.replacen("http://", "ws://", 1);
        let url = format!("{ws}/api/remote.mux");
        let mut request = url
            .as_str()
            .into_client_request()
            .context("build the mux handshake")?;
        request.headers_mut().insert(
            "Cookie",
            HeaderValue::from_str(cookie).context("session cookie is not a valid header value")?,
        );
        let (socket, _response) = connect(request).context("connect to /api/remote.mux")?;
        Ok(Self { socket, next_id: 0 })
    }

    /// Bound each read so a quiet stream still lets the caller make progress.
    pub fn set_read_timeout(&mut self, timeout: std::time::Duration) -> Result<()> {
        match self.socket.get_mut() {
            MaybeTlsStream::Plain(stream) => {
                stream.set_read_timeout(Some(timeout))?;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Open one logical stream; the returned id keys every later message.
    pub fn open(&mut self, endpoint: &str, args: Value) -> Result<String> {
        let stream_id = format!("rdsh-desktop-{}", self.next_id);
        self.next_id += 1;
        let message = json!({
            "type": "open",
            "streamId": stream_id,
            "endpoint": endpoint,
            "payload": { "args": args }
        });
        self.socket
            .send(Message::Text(message.to_string().into()))
            .with_context(|| format!("open {endpoint}"))?;
        Ok(stream_id)
    }

    pub fn cancel(&mut self, stream_id: &str) -> Result<()> {
        let message = json!({ "type": "cancel", "streamId": stream_id });
        self.socket.send(Message::Text(message.to_string().into()))?;
        Ok(())
    }

    /// Read one message, treating a socket read timeout as "nothing yet" so a
    /// quiet stream is not mistaken for a closed connection.
    pub fn try_read(&mut self) -> Result<Option<Value>> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    return Ok(Some(
                        serde_json::from_str(&text).context("mux message is not JSON")?,
                    ))
                }
                Ok(Message::Binary(bytes)) => {
                    return Ok(Some(
                        serde_json::from_slice(&bytes).context("mux message is not JSON")?,
                    ))
                }
                Ok(Message::Ping(payload)) => {
                    self.socket.send(Message::Pong(payload))?;
                }
                Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => continue,
                Ok(Message::Close(frame)) => {
                    return Err(anyhow!("mux closed by the host: {frame:?}"))
                }
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None)
                }
                Err(error) => return Err(anyhow!("{error}")),
            }
        }
    }

    /// Next host message as JSON, answering pings while waiting.
    pub fn read(&mut self) -> Result<Value> {
        loop {
            let message = self.socket.read().context("read from the mux")?;
            match message {
                Message::Text(text) => {
                    return serde_json::from_str(&text).context("mux message is not JSON")
                }
                Message::Binary(bytes) => {
                    return serde_json::from_slice(&bytes).context("mux message is not JSON")
                }
                Message::Ping(payload) => {
                    self.socket.send(Message::Pong(payload))?;
                }
                Message::Pong(_) => continue,
                Message::Close(frame) => {
                    return Err(anyhow!("mux closed by the host: {frame:?}"))
                }
                Message::Frame(_) => continue,
            }
        }
    }

    /// Read until the stream ends, returning every value seen for it.
    pub fn drain(&mut self, stream_id: &str, limit: usize) -> Result<Vec<Value>> {
        let mut values = Vec::new();
        while values.len() < limit {
            let message = self.read()?;
            let kind = message.get("type").and_then(Value::as_str).unwrap_or_default();
            let id = message
                .get("streamId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if id != stream_id {
                continue;
            }
            match kind {
                "item" => values.push(message.get("value").cloned().unwrap_or(Value::Null)),
                "end" => break,
                "error" => {
                    return Err(anyhow!(
                        "stream {stream_id} failed: {}",
                        message
                            .get("error")
                            .map(|error| error.to_string())
                            .unwrap_or_else(|| message.to_string())
                    ))
                }
                _ => continue,
            }
        }
        Ok(values)
    }
}
