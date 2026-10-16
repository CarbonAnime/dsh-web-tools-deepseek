//! Fixed-interval rate limiting.
//!
//! The account allows 5 QPS **per endpoint**, shared by every key on it, and a
//! 429 costs a whole round trip to discover. The limiter therefore paces requests
//! at a fixed interval instead of using a token bucket: a bucket would allow a
//! burst of 5 inside one window, and a burst is exactly what trips a sliding-window
//! limiter on the other side. One slot is reserved before each request, so the
//! `n`-th request is never sent earlier than `n × interval` after the first.
//!
//! There is no queue and no bound: reserving a slot is O(1), and a burst of
//! concurrent callers simply spreads out in reservation order.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use crate::error::EngineError;

/// Paces requests to at most `qps` per second.
pub struct Throttle {
    /// Milliseconds between consecutive request starts.
    interval_ms: AtomicU64,
    /// Earliest instant the next request may start.
    next: Mutex<Instant>,
}

impl Throttle {
    /// Build a limiter for `qps` requests per second.
    pub fn new(qps: f64) -> Self {
        Self {
            interval_ms: AtomicU64::new(interval_ms(qps)),
            next: Mutex::new(Instant::now()),
        }
    }

    /// Retune the limiter in place, so a `configure` frame does not discard the
    /// pacing state of requests already in flight.
    pub fn set_qps(&self, qps: f64) {
        self.interval_ms.store(interval_ms(qps), Ordering::Relaxed);
    }

    /// Reserve one slot and wait for it.
    ///
    /// Returns `WEB_ABORTED` if the caller cancels while waiting, so a cancelled
    /// call does not silently keep its place in line.
    pub async fn acquire(
        &self,
        cancel: &CancellationToken,
        label: &str,
    ) -> Result<(), EngineError> {
        let wait = {
            let mut next = self.next.lock().await;
            let now = Instant::now();
            let start = if *next > now { *next } else { now };
            *next = start + Duration::from_millis(self.interval_ms.load(Ordering::Relaxed));
            start.saturating_duration_since(now)
        };
        if cancel.is_cancelled() {
            return Err(EngineError::aborted(format!(
                "{label} aborted before sending"
            )));
        }
        if !wait.is_zero() {
            tokio::select! {
                _ = cancel.cancelled() => {
                    return Err(EngineError::aborted(format!("{label} aborted while waiting for a rate-limit slot")));
                }
                _ = sleep(wait) => {}
            }
        }
        Ok(())
    }
}

/// Milliseconds between request starts for a target QPS, never below 1 ms.
fn interval_ms(qps: f64) -> u64 {
    if qps.is_finite() && qps > 0.0 {
        let value = (1000.0 / qps).ceil();
        value.max(1.0) as u64
    } else {
        // Defensive: a non-positive or non-finite QPS would otherwise mean "no
        // pacing at all", which is the one thing this type exists to prevent.
        200
    }
}
