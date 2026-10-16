//! Stdio entry point for the engine.
//!
//! The Node half of the plugin spawns this binary and speaks newline-delimited
//! JSON to it: one request per line in, one response per line out. Nothing is
//! written to stdout except protocol frames — a stray `println!` would corrupt the
//! stream for every in-flight call, so diagnostics travel as `log` events.
//!
//! Requests are handled concurrently: the read loop never blocks on an HTTP call,
//! and each in-flight request owns a `CancellationToken` that the `cancel` frame can
//! trip. `configure` is applied immediately and without disturbing requests already
//! running.

mod config;
mod emitter;
mod error;
mod fetch;
mod http;
mod protocol;
mod search;
mod throttle;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::emitter::Emitter;
use crate::error::EngineError;
use crate::protocol::{Envelope, Event, FetchParams, Response, SearchParams};
use crate::throttle::Throttle;

/// Engine kind reported in the `ready` frame.
const ENGINE: &str = "rust";

/// How long to wait for the writer task to drain after `shutdown`.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

/// Everything shared by the concurrently running requests.
struct Session {
    /// Current configuration, replaced wholesale by `configure`.
    config: RwLock<Config>,
    /// One pooled client for both endpoints; URL-agnostic, so a `baseURL` change
    /// needs no new client.
    client: reqwest::Client,
    /// Search and fetch are limited independently, exactly as the API limits them.
    search_throttle: Throttle,
    /// See `search_throttle`.
    fetch_throttle: Throttle,
    /// Cancellation token per in-flight request id.
    inflight: Mutex<HashMap<u64, CancellationToken>>,
    /// Frame writer.
    emitter: Emitter,
}

#[tokio::main]
async fn main() {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Single writer task: requests finish independently, and two of them writing
    // to stdout at once would interleave into a corrupted line.
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.write_all(b"\n").await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
        let _ = stdout.flush().await;
    });

    let emitter = Emitter::new(tx);
    let config = Config::default().sanitized();
    let session = Arc::new(Session {
        search_throttle: Throttle::new(config.qps),
        fetch_throttle: Throttle::new(config.qps),
        config: RwLock::new(config),
        client: reqwest::Client::builder().build().unwrap_or_default(),
        inflight: Mutex::new(HashMap::new()),
        emitter: emitter.clone(),
    });

    // Announced before stdin is read: "the process exists" must not be mistaken for
    // "the engine is usable".
    emitter.send(&Event::Ready {
        engine: ENGINE.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    });
    emitter.log(
        "info",
        format!(
            "engine {} ready (pid {})",
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        ),
    );

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                emitter.log("warn", format!("stdin read failed: {error}"));
                break;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let envelope: Envelope = match serde_json::from_str(line) {
            Ok(envelope) => envelope,
            Err(error) => {
                // No id could be recovered, so this can only be reported, not answered.
                emitter.log("warn", format!("discarding unparsable frame: {error}"));
                continue;
            }
        };
        if handle(&session, envelope).await {
            break;
        }
    }

    // Dropping the session releases the last emitter clone; without that the writer
    // would wait for a channel that can never close.
    drop(session);
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, writer).await;
}

/// Handle one frame. Returns `true` when the loop should stop.
async fn handle(session: &Arc<Session>, envelope: Envelope) -> bool {
    let id = envelope.id;
    let method = envelope.method.as_str();
    match method {
        "configure" => {
            // A frame that does not parse must not quietly fall back to the defaults:
            // the defaults point at the real API, so a typo in one config key would
            // silently redirect every call (and every billable request) there. The
            // previous configuration is kept and the failure is reported instead.
            let config = match serde_json::from_value::<Config>(envelope.params) {
                Ok(config) => config.sanitized(),
                Err(error) => {
                    let message = format!("configure frame is not a valid configuration: {error}");
                    session.emitter.log("warn", message.clone());
                    if let Some(id) = id {
                        session
                            .emitter
                            .send(&Response::err(id, EngineError::provider(message)));
                    }
                    return false;
                }
            };
            session.search_throttle.set_qps(config.qps);
            session.fetch_throttle.set_qps(config.qps);
            let ack = json!({
                "baseURL": config.base_url,
                "count": config.count,
                "qps": config.qps,
                "timeoutMs": config.timeout_ms,
                "retries": config.retries,
                "userAgent": config.user_agent,
            });
            session.emitter.log(
                "info",
                format!(
                    "engine configured baseURL={} count={} qps={} timeoutMs={} retries={}",
                    config.base_url, config.count, config.qps, config.timeout_ms, config.retries
                ),
            );
            *session.config.write().await = config;
            if let Some(id) = id {
                session.emitter.send(&Response::ok(id, ack));
            }
        }
        "ping" => {
            if let Some(id) = id {
                session.emitter.send(&Response::ok(
                    id,
                    json!({ "pong": true, "engine": ENGINE, "version": env!("CARGO_PKG_VERSION") }),
                ));
            }
        }
        "cancel" => {
            let target = envelope.params.get("id").and_then(Value::as_u64);
            let cancelled = match target {
                Some(target) => match session.inflight.lock().await.get(&target) {
                    Some(token) => {
                        token.cancel();
                        true
                    }
                    None => false,
                },
                None => false,
            };
            if let Some(id) = id {
                session.emitter.send(&Response::ok(
                    id,
                    json!({ "cancelled": cancelled, "target": target }),
                ));
            }
        }
        "shutdown" => {
            if let Some(id) = id {
                session
                    .emitter
                    .send(&Response::ok(id, json!({ "stopping": true })));
            }
            return true;
        }
        // Dispatched on a task so the read loop keeps accepting frames — including
        // the `cancel` that may be the only way this call ever ends.
        "search" | "fetch" => {
            let params = envelope.params;
            let cancel = CancellationToken::new();
            let session = Arc::clone(session);
            if let Some(id) = id {
                session.inflight.lock().await.insert(id, cancel.clone());
            }
            let method = envelope.method;
            tokio::spawn(async move {
                let outcome = run(&session, &method, params, &cancel).await;
                if let Some(id) = id {
                    session.inflight.lock().await.remove(&id);
                    match outcome {
                        Ok(result) => session.emitter.send(&Response::ok(id, result)),
                        Err(error) => session.emitter.send(&Response::err(id, error)),
                    }
                }
            });
        }
        other => {
            let error = EngineError::provider(format!("unknown method \"{other}\""));
            if let Some(id) = id {
                session.emitter.send(&Response::err(id, error.clone()));
            }
            session.emitter.log("warn", error.message);
        }
    }
    false
}

/// Run one request to completion.
async fn run(
    session: &Session,
    method: &str,
    params: Value,
    cancel: &CancellationToken,
) -> Result<Value, EngineError> {
    match method {
        "search" => {
            let params: SearchParams = serde_json::from_value(params).unwrap_or_default();
            let config = session.config.read().await.clone();
            search::search(
                &session.client,
                &config,
                &session.search_throttle,
                params,
                cancel,
                &session.emitter,
            )
            .await
        }
        "fetch" => {
            let params: FetchParams = serde_json::from_value(params).unwrap_or_default();
            let config = session.config.read().await.clone();
            fetch::fetch(
                &session.client,
                &config,
                &session.fetch_throttle,
                params,
                cancel,
                &session.emitter,
            )
            .await
        }
        other => Err(EngineError::provider(format!("unknown method \"{other}\""))),
    }
}
