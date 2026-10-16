//! `POST /v1/tools/search` → the seam's `WebSearchProvider` result shape.
//!
//! Response shape (200):
//! `{"results":[{"rerank_score":2.1,"title":…,"url":…,"snippet":…,"summary":…,"content":…,
//!               "site_name":…,"site_icon":…,"date":"2026-01-01T00:00:00Z","authority":3}]}`
//!
//! Only the fields the seam's closed `WebSearchSource` type can carry are mapped
//! (`url`, `title`, `snippet`, `publishedAt`). `rerank_score`, `site_name`,
//! `site_icon` and `authority` have nowhere to go — the type is closed, and
//! stuffing ranking metadata into `snippet` would misrepresent it as page text.
//!
//! Which text lands in `snippet` is a real choice, and the API documents the
//! intended split: `snippet` (100–200 chars) is "for front-end display" while
//! `summary` (600–800 chars) is "for models to read". The only consumer through
//! this seam is a model, so `summary` is the default.

use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::config::{Config, SnippetSource};
use crate::emitter::Emitter;
use crate::error::EngineError;
use crate::http::{call_api, http_failure};
use crate::protocol::SearchParams;
use crate::throttle::Throttle;

/// Search endpoint path.
pub const SEARCH_PATH: &str = "/v1/tools/search";

/// Server-side cap on `count`.
pub const MAX_COUNT: i64 = 50;

/// Server-side cap on `query`, in Unicode characters.
///
/// The API rejects anything longer with HTTP 400. Checking locally turns a wasted
/// round trip (and the rate-limit budget it consumes) into an immediate error the
/// caller can act on.
pub const MAX_QUERY_CHARS: usize = 128;

/// Run one search.
pub async fn search(
    client: &reqwest::Client,
    config: &Config,
    throttle: &Throttle,
    params: SearchParams,
    cancel: &CancellationToken,
    emitter: &Emitter,
) -> Result<Value, EngineError> {
    let query = text_opt(params.query.as_deref())
        .ok_or_else(|| EngineError::provider("deepseek search requires a non-empty query"))?;
    let query_chars = query.chars().count();
    if query_chars > MAX_QUERY_CHARS {
        return Err(EngineError::provider(format!(
            "deepseek search query exceeds {MAX_QUERY_CHARS} characters (got {query_chars})"
        )));
    }
    let api_key = api_key_required(params.api_key)?;

    // `query` goes through verbatim: documented search operators (`site:`,
    // `-site:`, `-`, `-"…"`, `"…"`, `lang:`, `after:`, `before:`) are passed
    // straight to the search backend, so rewriting it would break them.
    let mut payload = Map::new();
    payload.insert("query".to_string(), Value::String(query));
    payload.insert(
        "count".to_string(),
        json!(pick_count(params.max_results, config.count)),
    );

    if let Some(ori_question) = text_opt(Some(config.ori_question.as_str())) {
        let (clamped, truncated) = clamp_chars(&ori_question, MAX_QUERY_CHARS);
        if truncated {
            emitter.log(
                "warn",
                format!("[web-tools-deepseek] ori_question truncated to {MAX_QUERY_CHARS} characters (the search itself still ran)"),
            );
        }
        payload.insert("ori_question".to_string(), Value::String(clamped));
    }
    // `localization` is an IP address that biases results toward its region —
    // not a language tag. Languages belong in the query, as `lang:zh,en`.
    if let Some(localization) = text_opt(Some(config.localization.as_str())) {
        payload.insert("localization".to_string(), Value::String(localization));
    }

    // `need_content` is deliberately never sent. The API documents `content` as
    // each result's page body, an empty string unless `need_content` is true, and
    // the seam's closed `WebSearchSource` type has nowhere to put it — asking for
    // it would pay for bytes that must then be discarded. `WebSearchResult.content`
    // is left unset as well: stitching N summaries into a prose digest would be
    // inventing an answer. `summary` already carries the model-readable text.
    let reply = call_api(
        client,
        config,
        throttle,
        "deepseek search",
        SEARCH_PATH,
        &Value::Object(payload),
        &api_key,
        cancel,
        emitter,
    )
    .await?;

    if !reply.ok() {
        return Err(EngineError::provider(http_failure(
            "deepseek search",
            reply.status,
            &reply.message,
        )));
    }
    let results = reply
        .json
        .as_ref()
        .and_then(|body| body.get("results"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            EngineError::provider(format!(
                "deepseek search returned an unexpected payload (no \"results\" array): {}",
                truncate_chars(&reply.text, 200)
            ))
        })?;

    let mut sources = Vec::with_capacity(results.len());
    for item in results {
        if let Some(source) = to_source(item, config.snippet_source) {
            sources.push(source);
        }
    }
    // No pagination capability, so never claim there is more: `truncated` stays
    // false and the seam sets it itself if it has to cap the list.
    Ok(json!({ "sources": sources, "truncated": false }))
}

/// Choose the `count` to request: exactly what the caller can consume, so the
/// seam's own `capSources` never has to truncate (which would append a misleading
/// "more results exist" note to an otherwise complete answer). `count` does not
/// affect the per-call price.
pub fn pick_count(max_results: Option<f64>, configured: i64) -> i64 {
    let requested = match max_results {
        Some(value) if value.is_finite() && value > 0.0 => value.trunc() as i64,
        _ => configured,
    };
    requested.clamp(1, MAX_COUNT)
}

/// Map one API result onto the seam's `WebSearchSource`.
pub fn to_source(item: &Value, snippet_source: SnippetSource) -> Option<Value> {
    if !item.is_object() {
        return None;
    }
    let url = text_opt(item.get("url").and_then(Value::as_str))?;
    let mut source = Map::new();
    source.insert("url".to_string(), Value::String(url));
    if let Some(title) = text_opt(item.get("title").and_then(Value::as_str)) {
        source.insert("title".to_string(), Value::String(title));
    }
    let (preferred, fallback) = match snippet_source {
        SnippetSource::Summary => ("summary", "snippet"),
        SnippetSource::Snippet => ("snippet", "summary"),
    };
    let snippet = text_opt(item.get(preferred).and_then(Value::as_str))
        .or_else(|| text_opt(item.get(fallback).and_then(Value::as_str)));
    if let Some(snippet) = snippet {
        source.insert("snippet".to_string(), Value::String(snippet));
    }
    if let Some(published_at) = iso_date(item.get("date")) {
        source.insert("publishedAt".to_string(), Value::String(published_at));
    }
    Some(Value::Object(source))
}

/// Reduce an RFC3339 timestamp to a bare `YYYY-MM-DD` date.
///
/// The renderer puts the value straight into `(…)` in the sources list, so a full
/// timestamp would be noise; and an unknown date arrives as `null`, which must not
/// become the string `"null"`. The day is range-checked but not calendar-checked
/// (a `2026-02-31` would pass), which is deliberate: the API emits real timestamps
/// and a calendar dependency is not worth carrying for an impossible input.
pub fn iso_date(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let bytes = raw.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    for (index, byte) in bytes[..10].iter().enumerate() {
        let is_separator = index == 4 || index == 7;
        if is_separator {
            if *byte != b'-' {
                return None;
            }
        } else if !byte.is_ascii_digit() {
            return None;
        }
    }
    let month: u32 = raw[5..7].parse().ok()?;
    let day: u32 = raw[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(raw[0..10].to_string())
}

/// Truncate text to a number of Unicode code points.
///
/// Counted by code point rather than by UTF-16 length so an astral character
/// counts once, which is what the API's "characters" bound means.
pub fn clamp_chars(value: &str, limit: usize) -> (String, bool) {
    let mut points = value.chars();
    let text: String = points.by_ref().take(limit).collect();
    (text, points.next().is_some())
}

/// Trimmed non-empty text, or `None`.
pub fn text_opt(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Truncate to `limit` code points, appending an ellipsis when anything was cut.
fn truncate_chars(value: &str, limit: usize) -> String {
    let (text, truncated) = clamp_chars(value, limit);
    if truncated {
        format!("{text}…")
    } else {
        text
    }
}

/// Reject an absent or blank bearer token before it can be sent.
pub fn api_key_required(api_key: Option<String>) -> Result<String, EngineError> {
    text_opt(api_key.as_deref()).ok_or_else(EngineError::missing_credential)
}
