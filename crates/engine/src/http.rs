//! Shared HTTP client for the DeepSeek native tools API.
//!
//! Both endpoints are plain JSON over HTTPS with `Authorization: Bearer <key>`,
//! and both share one error envelope:
//! `{"error":{"message":…,"type":…,"param":null,"code":…}}`.
//!
//! Retry policy — only `408` / `429` / `5xx` are retried, at most `retries` times,
//! honouring `Retry-After`. Every other 4xx is terminal: a 403 "URL access denied"
//! or a 401 bad key fails identically on the second attempt, and the retry still
//! burns rate-limit budget. A transport failure (DNS / TLS / socket reset) counts
//! as retryable, because no HTTP answer arrived at all; it is as transient as a
//! 500. A timeout and a cancellation are terminal: the caller asked to stop.

use std::time::{Duration, Instant};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::emitter::Emitter;
use crate::error::{describe, EngineError};
use crate::throttle::Throttle;

/// HTTP statuses worth a second attempt.
pub const RETRYABLE_STATUS: [u16; 6] = [408, 429, 500, 502, 503, 504];

/// Default ceiling for a server-hinted `Retry-After` wait.
pub const RETRY_AFTER_CAP_MS: u64 = 30_000;

/// Hard cap on a captured response body, so one hostile or oversized reply
/// cannot balloon memory.
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// A normalized reply, successful or not.
pub struct Reply {
    /// HTTP status.
    pub status: u16,
    /// Raw body text.
    pub text: String,
    /// Parsed body, when it was JSON.
    pub json: Option<Value>,
    /// Human-readable failure text from the API envelope, or a trimmed body.
    pub message: String,
}

impl Reply {
    /// Whether the status is 2xx.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Why a single attempt did not produce a reply.
enum AttemptError {
    /// No HTTP answer arrived: DNS, TLS, connection reset, body read failure.
    Transport(String),
    /// The attempt ended for a reason that must not be retried.
    Fatal(EngineError),
}

/// Call the tools API, retrying the transient classes described above.
#[allow(clippy::too_many_arguments)]
pub async fn call_api(
    client: &reqwest::Client,
    config: &Config,
    throttle: &Throttle,
    label: &str,
    path: &str,
    payload: &Value,
    api_key: &str,
    cancel: &CancellationToken,
    emitter: &Emitter,
) -> Result<Reply, EngineError> {
    let endpoint = config.endpoint(path);
    let mut attempt: u32 = 0;
    loop {
        if cancel.is_cancelled() {
            return Err(EngineError::aborted(format!(
                "{label} aborted before sending"
            )));
        }
        throttle.acquire(cancel, label).await?;
        let started = Instant::now();

        match send_once(client, &endpoint, payload, api_key, config, label, cancel).await {
            Err(AttemptError::Fatal(error)) => {
                emitter.call(serde_json::json!({
                    "label": label,
                    "endpoint": endpoint,
                    "status": 0,
                    "ok": false,
                    "code": error.code,
                    "ms": started.elapsed().as_millis() as u64,
                    "attempts": attempt + 1,
                }));
                return Err(error);
            }
            Err(AttemptError::Transport(detail)) => {
                emitter.call(serde_json::json!({
                    "label": label,
                    "endpoint": endpoint,
                    "status": 0,
                    "ok": false,
                    "code": "TRANSPORT",
                    "detail": detail,
                    "ms": started.elapsed().as_millis() as u64,
                    "attempts": attempt + 1,
                }));
                if attempt >= config.retries {
                    return Err(EngineError::provider(format!(
                        "{label} transport failure: {detail}"
                    )));
                }
                attempt += 1;
                wait_or_cancel(backoff_ms(attempt), cancel, label).await?;
            }
            Ok((status, text, retry_after)) => {
                let json = parse_json(&text);
                let message = api_error_message(json.as_ref(), &text);
                let ok = (200..300).contains(&status);
                let elapsed_ms = started.elapsed().as_millis() as u64;
                emitter.call(serde_json::json!({
                    "label": label,
                    "endpoint": endpoint,
                    "status": status,
                    "ok": ok,
                    "ms": elapsed_ms,
                    "attempts": attempt + 1,
                }));
                if ok {
                    return Ok(Reply {
                        status,
                        text,
                        json,
                        message,
                    });
                }
                if RETRYABLE_STATUS.contains(&status) && attempt < config.retries {
                    let wait = parse_retry_after(retry_after.as_deref())
                        .unwrap_or_else(|| backoff_ms(attempt + 1));
                    attempt += 1;
                    wait_or_cancel(wait, cancel, label).await?;
                    continue;
                }
                return Ok(Reply {
                    status,
                    text,
                    json,
                    message,
                });
            }
        }
    }
}

/// One attempt at `POST <endpoint>`, bounded by the configured deadline and the
/// caller's cancellation.
///
/// `timeout_ms == 0` disables the deadline but still honours cancellation.
async fn send_once(
    client: &reqwest::Client,
    endpoint: &str,
    payload: &Value,
    api_key: &str,
    config: &Config,
    label: &str,
    cancel: &CancellationToken,
) -> Result<(u16, String, Option<String>), AttemptError> {
    let mut builder = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"));
    if !config.user_agent.is_empty() {
        builder = builder.header(reqwest::header::USER_AGENT, config.user_agent.as_str());
    }
    let request = builder.json(payload);

    let work = async {
        let response = request
            .send()
            .await
            .map_err(|error| AttemptError::Transport(describe(&error)))?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        // Read the body incrementally. `Response::bytes()` buffers the whole thing
        // before returning, which is precisely what the size cap exists to prevent:
        // a hostile or runaway server could hand us gigabytes before the check ran.
        let mut response = response;
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| AttemptError::Transport(describe(&error)))?
        {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(AttemptError::Fatal(EngineError::provider(format!(
                    "{label} response exceeds {MAX_RESPONSE_BYTES} bytes"
                ))));
            }
            body.extend_from_slice(&chunk);
        }
        Ok((
            status,
            String::from_utf8_lossy(&body).into_owned(),
            retry_after,
        ))
    };

    if config.timeout_ms == 0 {
        tokio::select! {
            _ = cancel.cancelled() => Err(AttemptError::Fatal(EngineError::aborted(format!("{label} aborted")))),
            result = work => result,
        }
    } else {
        let deadline = Duration::from_millis(config.timeout_ms);
        tokio::select! {
            _ = cancel.cancelled() => Err(AttemptError::Fatal(EngineError::aborted(format!("{label} aborted")))),
            result = tokio::time::timeout(deadline, work) => match result {
                Ok(inner) => inner,
                Err(_) => Err(AttemptError::Fatal(EngineError::timeout(format!(
                    "{label} timed out after {} ms",
                    config.timeout_ms
                )))),
            },
        }
    }
}

/// Sleep, unless the caller cancels first.
async fn wait_or_cancel(
    ms: u64,
    cancel: &CancellationToken,
    label: &str,
) -> Result<(), EngineError> {
    tokio::select! {
        _ = cancel.cancelled() => Err(EngineError::aborted(format!("{label} aborted"))),
        _ = tokio::time::sleep(Duration::from_millis(ms)) => Ok(()),
    }
}

/// Exponentially back off between retries: 500 ms, 1 s, 2 s, capped at 4 s.
fn backoff_ms(attempt: u32) -> u64 {
    (500u64.saturating_mul(1u64 << attempt.min(20).saturating_sub(1))).min(4_000)
}

/// Parse a `Retry-After` header (delta-seconds or HTTP-date) into a wait in ms.
pub fn parse_retry_after(value: Option<&str>) -> Option<u64> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(seconds) = raw.parse::<f64>() {
        if seconds.is_finite() && seconds >= 0.0 {
            return Some(((seconds * 1000.0) as u64).min(RETRY_AFTER_CAP_MS));
        }
    }
    let at = httpdate::parse_http_date(raw).ok()?;
    let wait = at
        .duration_since(std::time::SystemTime::now())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(wait.min(RETRY_AFTER_CAP_MS))
}

/// Pull the human-readable failure text out of the API's error envelope.
pub fn api_error_message(json: Option<&Value>, text: &str) -> String {
    if let Some(message) = json
        .and_then(|value| value.get("error"))
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        if !message.is_empty() {
            return message.to_string();
        }
    }
    let trimmed = text.trim();
    if trimmed.chars().count() > 256 {
        format!("{}…", trimmed.chars().take(256).collect::<String>())
    } else {
        trimmed.to_string()
    }
}

/// Render `HTTP <status> <message>` for a non-2xx API response.
pub fn http_failure(label: &str, status: u16, message: &str) -> String {
    if message.is_empty() {
        format!("{label} failed with HTTP {status}")
    } else {
        format!("{label} failed with HTTP {status} {message}")
    }
}

/// Parse a body as JSON, tolerating a non-JSON reply.
fn parse_json(text: &str) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}
