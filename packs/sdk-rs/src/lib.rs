//! `dextui_pack_sdk` — the shared Rust core for DextUI's consumer packs.
//!
//! - [`protocol`]: Pack Runtime Protocol v1 framing (request on stdin, one
//!   JSON response on stdout, `view` effects → `runtime_view` cards).
//! - [`util`]: money as integer cents, RFC-4180 CSV, dates, confined paths,
//!   and the ```chart / ```csv fences DextUI renders interactively.
//!
//! Packs implement [`Runtime`] and call [`run`] from `main`.
pub mod protocol;
pub mod util;

pub use protocol::{run, handle, safe_ui_token, Effect, Request, Response, Runtime, UiAnswer, UiAsk, UiRound,
    METHOD_FORM, METHOD_PROGRESS, UI_PARAMS_CAP, UI_ROUND_LIMIT};
pub use util::*;
