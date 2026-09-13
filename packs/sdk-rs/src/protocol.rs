//! Pack Runtime Protocol v1 framing, exactly as dext core (`src/pack_runtime.rs`)
//! expects: one JSON request on stdin, one JSON response on stdout.
//! `RuntimeResponse` is `deny_unknown_fields` on the dext side — never add keys.
//!
//! Packs that declare `ui_protocol: 1` in `runtime.json` may also return a
//! `ui_request` (method `form` or `progress`). Dext forwards it to the host UI
//! and re-invokes the runtime with event `ui_response` carrying the answer in
//! [`Request::ui`]. State is round-tripped via [`Response::state`].
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
/// dext's `UI_PAYLOAD_CAP`: one ui_request params / ui response value cap.
pub const UI_PARAMS_CAP: usize = 64 * 1024;
/// Host UI methods (see `context.ui_methods` for what the host supports).
pub const METHOD_FORM: &str = "form";
pub const METHOD_PROGRESS: &str = "progress";
/// dext's ui round cap per tool invocation chain (see `UI_ROUND_LIMIT`).
pub const UI_ROUND_LIMIT: usize = 16;

/// dext's ui request/response token rule: 1-64 ASCII letters, digits, `.`, `_`, `-`.
pub fn safe_ui_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

#[derive(Debug, Clone, Deserialize)]
pub struct Context {
    #[serde(default)]
    pub turn_id: String,
    #[serde(default)]
    pub iteration: u32,
    #[serde(default)]
    pub history_messages: usize,
    #[serde(default)]
    pub compacted: bool,
    /// UI methods the host renders (`form`, `progress`); empty when the host
    /// or pack does not support the UI channel. Check before returning
    /// `ui_request`s and fall back to plain content.
    #[serde(default)]
    pub ui_methods: Vec<String>,
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
    /// Present when `event == "ui_response"`: the host's answer to a
    /// `ui_request` this runtime previously returned.
    #[serde(default)]
    pub ui: Option<UiRound>,
}

/// The host's reply to a previously emitted `ui_request`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UiRound {
    pub request_id: String,
    pub method: String,
    pub response: UiAnswer,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UiAnswer {
    /// Submitted: `value` is the form's answers (multiselect values are arrays).
    Ok { #[serde(default)] value: Value },
    /// Dismissed by the user.
    Cancelled,
    /// Transport-level failure (e.g. `ui.response_failed`); safe to retry the
    /// question or finish with a partial result.
    Error { code: String, message: String },
}

impl UiAnswer {
    pub fn field<'a>(&'a self, id: &str) -> Option<&'a Value> {
        match self { UiAnswer::Ok { value } => value.get(id), _ => None }
    }
}

/// A UI request the runtime asks the host to render. `method` is `form` or
/// `progress`; `params` shapes are defined by the host (DextUI's
/// `pack-ui.mjs`): forms are `{title, description?, submit_label?, fields:[…]}`
/// and progress is `{id?, title?, message?, current?, total?, state?}`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UiAsk {
    pub id: String,
    pub method: String,
    pub params: Value,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_request: Option<UiAsk>,
}

impl Response {
    pub fn ok(content: impl Into<String>) -> Self {
        Self { version: PROTOCOL_VERSION, content: content.into(), is_error: false, state: None, effects: Vec::new(), ui_request: None }
    }
    pub fn error(content: impl Into<String>) -> Self {
        Self { version: PROTOCOL_VERSION, content: content.into(), is_error: true, state: None, effects: Vec::new(), ui_request: None }
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
    /// Ask the host UI to render something (method `form` or `progress`).
    /// Only packs whose `runtime.json` declares `"ui_protocol": 1` may use
    /// this; dext rejects the response otherwise. Invalid ids/methods or
    /// params over [`UI_PARAMS_CAP`] are dropped in [`Response::clamp`] with a
    /// note in `content`, so the response is never rejected outright.
    pub fn ui_request(mut self, id: impl Into<String>, method: &str, params: Value) -> Self {
        self.ui_request = Some(UiAsk { id: id.into(), method: method.to_string(), params });
        self
    }
    /// Shorthand for `.ui_request(id, METHOD_FORM, params)`.
    pub fn form(id: impl Into<String>, params: Value) -> Self {
        Response::ok("").ui_request(id, METHOD_FORM, params)
    }
    /// Shorthand for a `progress` update (`state`: running|completed|error).
    pub fn progress(id: impl Into<String>, params: Value) -> Self {
        Response::ok("").ui_request(id, METHOD_PROGRESS, params)
    }
    /// Bound content/state/ui params to dext's caps so the response is never rejected.
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
        if let Some(ask) = self.ui_request.take() {
            let broken = !safe_ui_token(&ask.id)
                || !safe_ui_token(&ask.method)
                || serde_json::to_string(&ask.params).map(|p| p.len()).unwrap_or(usize::MAX) > UI_PARAMS_CAP;
            if broken {
                self.content.push_str(&format!("\n(ui request {} dropped: invalid id/method or params over the size cap)", ask.id));
            } else {
                self.ui_request = Some(ask);
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
    /// The host answered a `ui_request` this runtime previously returned
    /// (dext re-invokes with event `ui_response`). Packs that never ask can
    /// keep the default; it is loud rather than silent if misused.
    fn ui_response(&mut self, _req: &Request, _round: &UiRound) -> Response {
        Response::error("this pack does not accept UI responses")
    }
}

/// Dispatch one already-parsed request (separated from `run` for tests).
pub fn handle<R: Runtime>(rt: &mut R, req: &Request) -> Response {
    match req.event.as_str() {
        "activate" => rt.activate(req),
        "tool" => {
            let tool = req.tool.clone().unwrap_or_default();
            let input = req.input.clone().unwrap_or(Value::Object(Default::default()));
            rt.tool(req, &tool, &input)
        }
        "idle" => rt.idle(req),
        "ui_response" => match &req.ui {
            Some(round) => rt.ui_response(req, round),
            None => Response::error("ui_response event is missing its ui payload"),
        },
        other => Response::error(format!("unsupported runtime event: {other}")),
    }
}

pub fn run<R: Runtime>(rt: &mut R) {
    let req = match read_request() {
        Ok(r) => r,
        Err(e) => return write_response(Response::error(e)),
    };
    let resp = handle(rt, &req);
    write_response(resp);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Echo {
        last: std::cell::RefCell<Option<String>>,
    }
    impl Runtime for Echo {
        fn activate(&mut self, _req: &Request) -> Response { Response::ok("activated") }
        fn tool(&mut self, _req: &Request, tool: &str, _input: &Value) -> Response { Response::ok(tool.to_string()) }
        fn ui_response(&mut self, _req: &Request, round: &UiRound) -> Response {
            *self.last.borrow_mut() = Some(round.request_id.clone());
            match &round.response {
                UiAnswer::Ok { value } => Response::ok(format!("ok:{}", value)),
                UiAnswer::Cancelled => Response::ok("cancelled"),
                UiAnswer::Error { code, .. } => Response::ok(format!("error:{code}")),
            }
        }
    }

    fn request(json: &str) -> Request {
        serde_json::from_str(json).expect("parses")
    }

    #[test]
    fn ui_response_round_trips_through_handle() {
        let mut rt = Echo::default();
        let req = request(
            r#"{"version":1,"event":"ui_response","pack":"p","session_id":"s","cwd":"/tmp","state":{},
                "context":{"turn_id":"t","iteration":1,"history_messages":2,"compacted":false,"ui_methods":["form","progress"]},
                "ui":{"request_id":"review-2","method":"form","response":{"status":"ok","value":{"l3":"receipt#9"}}}}"#,
        );
        assert_eq!(req.ui.as_ref().unwrap().method, METHOD_FORM);
        assert!(req.context.as_ref().unwrap().ui_methods.contains(&"form".to_string()));
        let resp = handle(&mut rt, &req);
        assert_eq!(resp.content, "ok:{\"l3\":\"receipt#9\"}");
        assert_eq!(*rt.last.borrow(), Some("review-2".to_string()));

        let req = request(
            r#"{"version":1,"event":"ui_response","pack":"p","session_id":"s","cwd":"/tmp","state":{},
                "context":{"turn_id":"t","iteration":1,"history_messages":2},
                "ui":{"request_id":"r","method":"form","response":{"status":"cancelled"}}}"#,
        );
        assert_eq!(handle(&mut rt, &req).content, "cancelled");

        let req = request(
            r#"{"version":1,"event":"ui_response","pack":"p","session_id":"s","cwd":"/tmp","state":{},
                "context":{"turn_id":"t","iteration":1,"history_messages":2},
                "ui":{"request_id":"r","method":"form","response":{"status":"error","code":"response_failed","message":"retry"}}}"#,
        );
        assert_eq!(handle(&mut rt, &req).content, "error:response_failed");

        let req = request(
            r#"{"version":1,"event":"ui_response","pack":"p","session_id":"s","cwd":"/tmp","state":{},
                "context":{},"ui":null}"#,
        );
        assert!(handle(&mut rt, &req).is_error);
    }

    #[test]
    fn form_response_serializes_only_known_keys() {
        let resp = Response::form("review-1", serde_json::json!({"title": "Review", "fields": []})).clamp();
        let map: serde_json::Map<String, Value> = serde_json::to_value(&resp).unwrap().as_object().unwrap().clone();
        let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, vec!["content", "effects", "is_error", "ui_request", "version"]);
        assert_eq!(map["ui_request"]["method"], "form");
        assert_eq!(map["ui_request"]["params"]["title"], "Review");
    }

    #[test]
    fn plain_response_omits_ui_request_key() {
        let resp = Response::ok("hi").clamp();
        let map = serde_json::to_value(&resp).unwrap().as_object().unwrap().clone();
        assert!(!map.contains_key("ui_request"));
        assert!(!map.contains_key("state"));
    }

    #[test]
    fn clamp_drops_invalid_ui_requests() {
        let oversize = "x".repeat(UI_PARAMS_CAP);
        let resp = Response::ok("").ui_request("review-1", METHOD_FORM, serde_json::json!({ "big": oversize })).clamp();
        assert!(resp.ui_request.is_none());
        assert!(resp.content.contains("dropped"));

        let resp = Response::ok("").ui_request("bad id!", METHOD_FORM, serde_json::json!({})).clamp();
        assert!(resp.ui_request.is_none());
    }
}
