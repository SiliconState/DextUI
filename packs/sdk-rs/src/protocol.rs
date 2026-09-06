//! Pack Runtime Protocol v1 framing, exactly as dext core (`src/pack_runtime.rs`)
//! expects: one JSON request on stdin, one JSON response on stdout.
//! `RuntimeResponse` is `deny_unknown_fields` on the dext side — never add keys.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;

pub const PROTOCOL_VERSION: u32 = 1;
pub const REQUEST_CAP: usize = 256 * 1024;
/// dext caps: content 128 KiB, view markdown 128 KiB, state 64 KiB, 16 effects.
pub const CONTENT_CAP: usize = 128 * 1024;
pub const VIEW_CAP: usize = 128 * 1024;
pub const STATE_CAP: usize = 64 * 1024;
pub const EFFECT_LIMIT: usize = 16;

#[derive(Debug, Clone, Deserialize)]
pub struct Context {
    #[serde(default)]
    pub turn_id: String,
    #[serde(default)]
    pub iteration: u32,
    #[serde(default)]
    pub history_messages: usize,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub version: u32,
    /// `activate` | `tool` | `idle`
    pub event: String,
    #[serde(default)]
    pub pack: String,
    #[serde(default)]
    pub session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub state: Option<Value>,
    #[serde(default)]
    pub context: Option<Context>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub input: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Effect {
    Steer { text: String },
    Continue { prompt: String, delay_ms: u64 },
    View { title: String, markdown: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub version: u32,
    pub content: String,
    pub is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    pub effects: Vec<Effect>,
}

impl Response {
    pub fn ok(content: impl Into<String>) -> Self {
        Self { version: PROTOCOL_VERSION, content: content.into(), is_error: false, state: None, effects: Vec::new() }
    }
    pub fn error(content: impl Into<String>) -> Self {
        Self { version: PROTOCOL_VERSION, content: content.into(), is_error: true, state: None, effects: Vec::new() }
    }
    pub fn with_state(mut self, state: Value) -> Self {
        self.state = Some(state);
        self
    }
    /// Add a `view` effect (a `runtime_view` card in DextUI). Title ≤ 256 chars.
    pub fn view(mut self, title: impl Into<String>, markdown: impl Into<String>) -> Self {
        let mut title: String = title.into();
        title.truncate(256);
        let mut markdown: String = markdown.into();
        if markdown.len() > VIEW_CAP {
            markdown.truncate(VIEW_CAP - 64);
            markdown.push_str("\n\n_(view truncated)_");
        }
        if self.effects.len() < EFFECT_LIMIT {
            self.effects.push(Effect::View { title, markdown });
        }
        self
    }
    pub fn steer(mut self, text: impl Into<String>) -> Self {
        if self.effects.len() < EFFECT_LIMIT {
            self.effects.push(Effect::Steer { text: text.into() });
        }
        self
    }
    /// Bound content/state to dext's caps so the response is never rejected.
    fn clamp(mut self) -> Self {
        if self.content.len() > CONTENT_CAP {
            self.content.truncate(CONTENT_CAP - 32);
            self.content.push_str("\n…(truncated)");
        }
        if let Some(state) = &self.state {
            if serde_json::to_string(state).map(|s| s.len()).unwrap_or(0) > STATE_CAP {
                self.state = None;
                self.content.push_str("\n(state too large; not persisted)");
            }
        }
        self
    }
}

/// Read the request from stdin (bounded) and parse it.
pub fn read_request() -> Result<Request, String> {
    let mut input = String::new();
    std::io::stdin()
        .take(REQUEST_CAP as u64 + 1)
        .read_to_string(&mut input)
        .map_err(|e| format!("read runtime request: {e}"))?;
    if input.len() > REQUEST_CAP {
        return Err("runtime request exceeds 256 KiB".into());
    }
    let req: Request = serde_json::from_str(&input).map_err(|e| format!("parse runtime request: {e}"))?;
    if req.version != PROTOCOL_VERSION {
        return Err(format!("unsupported runtime request version {}; expected {PROTOCOL_VERSION}", req.version));
    }
    Ok(req)
}

/// Print a response as the single stdout line dext reads.
pub fn write_response(resp: Response) {
    let resp = resp.clamp();
    match serde_json::to_string(&resp) {
        Ok(s) => println!("{s}"),
        Err(e) => println!(
            "{{\"version\":1,\"content\":\"response serialization failed: {}\",\"is_error\":true,\"effects\":[]}}",
            e.to_string().replace('"', "'")
        ),
    }
}

/// Handler trait a pack implements; `run` does the framing.
pub trait Runtime {
    fn activate(&mut self, req: &Request) -> Response;
    fn tool(&mut self, req: &Request, tool: &str, input: &Value) -> Response;
    fn idle(&mut self, _req: &Request) -> Response {
        Response::ok("")
    }
}

pub fn run<R: Runtime>(rt: &mut R) {
    let req = match read_request() {
        Ok(r) => r,
        Err(e) => return write_response(Response::error(e)),
    };
    let resp = match req.event.as_str() {
        "activate" => rt.activate(&req),
        "tool" => {
            let tool = req.tool.clone().unwrap_or_default();
            let input = req.input.clone().unwrap_or(Value::Object(Default::default()));
            rt.tool(&req, &tool, &input)
        }
        "idle" => rt.idle(&req),
        other => Response::error(format!("unsupported runtime event: {other}")),
    };
    write_response(resp);
}
