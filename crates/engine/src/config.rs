//! Engine configuration.
//!
//! The Node bridge already sanitizes the plugin config; this side sanitizes
//! again, because the engine must be safe to drive by hand (the smoke tests do
//! exactly that) and a second clamping pass is cheaper than trusting the caller.

use serde::{Deserialize, Deserializer};

/// Which API field becomes each source's `snippet`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnippetSource {
    /// The API's `summary` (600–800 chars), documented as "for models to read".
    Summary,
    /// The API's `snippet` (100–200 chars), documented as "for front-end display".
    Snippet,
}

impl<'de> Deserialize<'de> for SnippetSource {
    /// Total by construction: anything that is not the literal `snippet` — a typo,
    /// a future value, a `null` — means `summary`, so a bad config value can never
    /// fail the whole `configure` frame.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(if raw == "snippet" {
            Self::Snippet
        } else {
            Self::Summary
        })
    }
}

/// Everything the engine needs that is not per-call.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// API origin, without a trailing slash.
    ///
    /// Spelled out because `rename_all = "camelCase"` would produce `baseUrl`,
    /// while the plugin's config key — and therefore the bridge's frame — is
    /// `baseURL`.
    #[serde(rename = "baseURL")]
    pub base_url: String,
    /// Results requested when the caller does not pass `maxResults`.
    pub count: i64,
    /// Preferred snippet field.
    pub snippet_source: SnippetSource,
    /// Sent as `ori_question` when non-empty.
    pub ori_question: String,
    /// Sent as `localization` when non-empty. An **IP address**, not a language.
    pub localization: String,
    /// Report a fetch 403/404 as a result instead of an error.
    pub blocked_as_result: bool,
    /// Prepend the API's `title` as an H1 when the Markdown lacks it.
    pub include_title: bool,
    /// Per-attempt deadline in ms; `0` disables it.
    pub timeout_ms: u64,
    /// Extra attempts for 408 / 429 / 5xx / transport failures.
    pub retries: u32,
    /// Per-endpoint rate limit. Search and fetch are limited independently.
    pub qps: f64,
    /// `User-Agent` header.
    pub user_agent: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".to_string(),
            count: 10,
            snippet_source: SnippetSource::Summary,
            ori_question: String::new(),
            localization: String::new(),
            blocked_as_result: true,
            include_title: true,
            timeout_ms: 30_000,
            retries: 1,
            qps: 5.0,
            user_agent: format!("dsh-web-tools-deepseek/{}", env!("CARGO_PKG_VERSION")),
        }
    }
}

impl Config {
    /// Clamp every field into its supported range.
    pub fn sanitized(mut self) -> Self {
        self.base_url = non_empty(&self.base_url, "https://api.deepseek.com");
        while self.base_url.ends_with('/') {
            self.base_url.pop();
        }
        self.count = self.count.clamp(1, 50);
        if !(self.qps.is_finite() && self.qps > 0.0) {
            self.qps = 5.0;
        }
        self.retries = self.retries.min(5);
        // A deadline beyond an hour is indistinguishable from "no deadline" and
        // only makes a wedged request harder to notice.
        self.timeout_ms = self.timeout_ms.min(3_600_000);
        self.user_agent = non_empty(
            &self.user_agent,
            &format!("dsh-web-tools-deepseek/{}", env!("CARGO_PKG_VERSION")),
        );
        self
    }

    /// Absolute URL for an endpoint path.
    pub fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

/// Trimmed value, or `fallback` when it is empty.
fn non_empty(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}
