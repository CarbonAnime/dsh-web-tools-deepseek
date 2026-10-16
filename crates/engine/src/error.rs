//! The engine's failure type.
//!
//! Every failure crossing the stdio bridge carries a `code` alongside its
//! message, because the seam's `WebError.code` is the machine-routable half of
//! the contract: `WEB_TIMEOUT` and `WEB_ABORTED` mean "you cancelled me", while
//! `WEB_PROVIDER_ERROR` means "the provider answered and it was bad". The Node
//! bridge turns these back into `WebError` instances without reinterpreting them.

use serde::Serialize;

/// A normalized failure: a stable code plus human-readable detail.
#[derive(Debug, Clone, Serialize)]
pub struct EngineError {
    /// Machine-routable code, spelled exactly as the seam's `WebError.code`.
    pub code: &'static str,
    /// Human-readable failure text.
    pub message: String,
}

impl EngineError {
    /// Build an error with an explicit code.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The provider answered, but the answer was unusable (`WEB_PROVIDER_ERROR`).
    pub fn provider(message: impl Into<String>) -> Self {
        Self::new("WEB_PROVIDER_ERROR", message)
    }

    /// A per-attempt deadline elapsed (`WEB_TIMEOUT`). Never retried.
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new("WEB_TIMEOUT", message)
    }

    /// The caller cancelled (`WEB_ABORTED`). Never retried.
    pub fn aborted(message: impl Into<String>) -> Self {
        Self::new("WEB_ABORTED", message)
    }

    /// No usable API key reached the engine (`WEB_MISSING_CREDENTIAL`).
    ///
    /// The Node side resolves the key before dispatching, so this is a backstop:
    /// it exists so an empty key can never be sent as `Authorization: Bearer `.
    pub fn missing_credential() -> Self {
        Self::new(
            "WEB_MISSING_CREDENTIAL",
            "no DeepSeek API key available: set the DEEPSEEK_API_KEY credential or the plugin's apiKey",
        )
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

/// Render an error's cause chain the way the JavaScript client did: the message,
/// plus the first distinct cause in parentheses.
pub fn describe(error: &reqwest::Error) -> String {
    let base = error.to_string();
    match std::error::Error::source(error) {
        Some(source) => {
            let cause = source.to_string();
            if cause.is_empty() || base.contains(&cause) {
                base
            } else {
                format!("{base} ({cause})")
            }
        }
        None => base,
    }
}
