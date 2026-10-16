//! `POST /v1/tools/fetch` → the seam's `WebFetchProvider` result shape.
//!
//! Response shape (200): `{"title":"…","content":"<markdown>"}` — `content` is the
//! page already converted to Markdown, which is why the result is reported as
//! `{kind:'text'}` (the seam's `kind:'html'` branch would run turndown over
//! Markdown and mangle it).
//!
//! The 403/404 split is the interesting part. Both are **answers about the URL**,
//! not failures of our call: 403 means the service's safety policy refused it, 404
//! means no usable page content could be obtained. `WebFetchResult.statusCode`
//! exists for exactly this, and a model that sees `HTTP 403` can switch source —
//! whereas a thrown error ends the tool call. So they are returned as results
//! (with a body that says plainly that it is *not* page content), while every
//! other non-2xx — 400/401/402/408/413/429/5xx — is a failure of *this* call and
//! throws.

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::config::Config;
use crate::emitter::Emitter;
use crate::error::EngineError;
use crate::http::{call_api, http_failure};
use crate::protocol::FetchParams;
use crate::search::{api_key_required, text_opt};
use crate::throttle::Throttle;

/// Fetch endpoint path.
pub const FETCH_PATH: &str = "/v1/tools/fetch";

/// Server-side cap on the URL length.
pub const MAX_URL_CHARS: usize = 8192;

/// Statuses that describe the URL rather than a failure of this call.
pub const URL_VERDICT_STATUS: [u16; 2] = [403, 404];

/// Prefix marking a body that must not be mistaken for retrieved page text.
pub const FAILURE_MARKER: &str = "[FETCH FAILED — NOT PAGE CONTENT]";

/// Run one fetch.
pub async fn fetch(
    client: &reqwest::Client,
    config: &Config,
    throttle: &Throttle,
    params: FetchParams,
    cancel: &CancellationToken,
    emitter: &Emitter,
) -> Result<Value, EngineError> {
    let url = assert_fetch_url(params.url.as_deref())?;
    let api_key = api_key_required(params.api_key)?;

    let reply = call_api(
        client,
        config,
        throttle,
        "deepseek fetch",
        FETCH_PATH,
        &json!({ "url": url.as_str() }),
        &api_key,
        cancel,
        emitter,
    )
    .await?;

    if reply.ok() {
        let content = reply
            .json
            .as_ref()
            .and_then(|body| body.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let title = reply
            .json
            .as_ref()
            .and_then(|body| body.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("");
        return Ok(json!({
            "url": url.as_str(),
            "statusCode": 200,
            "body": { "kind": "text", "content": with_title(title, content, config.include_title) },
            "truncated": false,
        }));
    }
    if config.blocked_as_result && URL_VERDICT_STATUS.contains(&reply.status) {
        return Ok(json!({
            "url": url.as_str(),
            "statusCode": reply.status,
            "body": { "kind": "text", "content": refusal_note(&url, reply.status, &reply.message) },
            "truncated": false,
        }));
    }
    Err(EngineError::provider(http_failure(
        "deepseek fetch",
        reply.status,
        &reply.message,
    )))
}

/// Validate a fetch target locally before spending a request on it.
///
/// Returns the original URL string, trimmed but otherwise unchanged, so the tool
/// header echoes exactly what was asked for.
pub fn assert_fetch_url(raw: Option<&str>) -> Result<String, EngineError> {
    let url = text_opt(raw)
        .ok_or_else(|| EngineError::provider("deepseek fetch requires a non-empty url"))?;
    let chars = url.chars().count();
    if chars > MAX_URL_CHARS {
        return Err(EngineError::provider(format!(
            "deepseek fetch url exceeds {MAX_URL_CHARS} characters (got {chars})"
        )));
    }
    let parsed = Url::parse(&url).map_err(|_| {
        EngineError::provider(format!(
            "deepseek fetch url is not a valid absolute URL: {url}"
        ))
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(EngineError::provider(format!(
            "deepseek fetch url must use http or https, got \"{}:\"",
            parsed.scheme()
        )));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err(EngineError::provider(format!(
            "deepseek fetch url has no host: {url}"
        )));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(EngineError::provider(
            "deepseek fetch url must not embed a username or password",
        ));
    }
    Ok(url)
}

/// Keep the API's `title` visible to the model without duplicating it.
///
/// `kind:'text'` bodies are passed through verbatim, so a separate `title` field
/// would otherwise be dropped on the floor. It is prepended as an H1 only when the
/// Markdown does not already carry it, which keeps the body byte-identical for the
/// common case where extraction already emitted the heading.
pub fn with_title(title: &str, content: &str, include_title: bool) -> String {
    if !include_title {
        return content.to_string();
    }
    let heading = title.trim();
    if heading.is_empty() {
        return content.to_string();
    }
    // The API escapes Markdown metacharacters in extracted text, so the page's own
    // heading usually arrives as `\# Title \- …`; comparing with the backslashes
    // stripped is what keeps this from prepending a second, redundant heading.
    let head: String = content
        .chars()
        .take(600)
        .collect::<String>()
        .replace('\\', "")
        .to_lowercase();
    if head.contains(&heading.to_lowercase()) {
        content.to_string()
    } else {
        format!("# {heading}\n\n{content}")
    }
}

/// Render an explicit, non-deceptive body for a 403/404 verdict.
pub fn refusal_note(url: &str, status: u16, message: &str) -> String {
    let reason = if status == 403 {
        "the DeepSeek fetch service refused this URL under its safety policy".to_string()
    } else {
        "the DeepSeek fetch service could not obtain usable page content for this URL (unavailable URL, blocked by the site, an error page, an unsupported content type, or no extractable Markdown body)".to_string()
    };
    let detail = if message.is_empty() {
        String::new()
    } else {
        format!("\nDeepSeek API said: {message}")
    };
    format!(
        "{FAILURE_MARKER}\nThe page was NOT retrieved: {reason}.\nHTTP status: {status}\nRequested URL: {url}{detail}\nNo page text is available for this URL. Try a different URL or a different source."
    )
}
