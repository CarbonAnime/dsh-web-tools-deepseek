//! The stdio wire protocol.
//!
//! One JSON object per line, in both directions. Requests carry an integer `id`
//! chosen by the Node bridge; every request gets exactly one response with the
//! same `id`. Unsolicited frames use `"event"` instead of `"id"`, so the bridge
//! can route them without keeping a table of known ids.
//!
//! ```text
//! → {"id":2,"method":"search","params":{"query":"…","maxResults":8,"apiKey":"…"}}
//! ← {"event":"ready","engine":"rust","version":"0.2.0"}
//! ← {"id":2,"ok":true,"result":{"sources":[…],"truncated":false}}
//! ← {"id":3,"ok":false,"error":{"code":"WEB_TIMEOUT","message":"…"}}
//! ← {"event":"call","record":{"label":"deepseek search","status":200,…}}
//! ```

use serde::{Deserialize, Serialize};

use crate::error::EngineError;

/// One request frame.
#[derive(Debug, Deserialize)]
pub struct Envelope {
    /// Correlation id; absent for fire-and-forget frames.
    #[serde(default)]
    pub id: Option<u64>,
    /// `configure` / `search` / `fetch` / `cancel` / `ping` / `shutdown`.
    pub method: String,
    /// Method-specific arguments. Left as raw JSON so an unknown extra key from a
    /// newer bridge cannot fail the whole call.
    #[serde(default)]
    pub params: serde_json::Value,
}

/// One response frame.
#[derive(Debug, Serialize)]
pub struct Response {
    /// Echoes the request's `id`.
    pub id: u64,
    /// Whether `result` (true) or `error` (false) is present.
    pub ok: bool,
    /// Success payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Failure payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<EngineError>,
}

impl Response {
    /// A successful response.
    pub fn ok(id: u64, result: serde_json::Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    /// A failed response.
    pub fn err(id: u64, error: EngineError) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

/// An unsolicited frame.
#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// Sent once, immediately after the process starts and before it reads stdin.
    /// The bridge waits for it, so "spawned" cannot be mistaken for "usable".
    Ready {
        /// Engine kind, always `rust`.
        engine: String,
        /// Engine version, matching the crate version.
        version: String,
    },
    /// A line for the plugin's diagnostics log.
    Log {
        /// `info` or `warn`.
        level: String,
        /// Message text.
        message: String,
    },
    /// One per HTTP attempt, mirroring the JS client's `onCall` records.
    Call {
        /// The attempt record.
        record: serde_json::Value,
    },
}

/// `search` arguments.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchParams {
    /// The query, verbatim (documented search operators are passed through).
    pub query: Option<String>,
    /// `WebSearchRequest.maxResults`, when the caller named one.
    pub max_results: Option<f64>,
    /// Bearer token, resolved by the Node side on every call so key rotation works.
    pub api_key: Option<String>,
}

/// `fetch` arguments.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FetchParams {
    /// Target URL.
    pub url: Option<String>,
    /// Bearer token.
    pub api_key: Option<String>,
}
