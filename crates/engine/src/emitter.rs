//! Outbound frame writer.
//!
//! Requests run as independent tasks, so several of them can finish at the same
//! moment. Rather than letting each one write to stdout (and interleave partial
//! lines), every frame is serialized to a complete line and pushed onto a channel
//! that a single writer task drains. That also gives shutdown a well-defined
//! flush point.

use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::Event;

/// Cheap, cloneable handle for emitting frames.
#[derive(Clone)]
pub struct Emitter {
    tx: UnboundedSender<String>,
}

impl Emitter {
    /// Wrap the writer task's channel.
    pub fn new(tx: UnboundedSender<String>) -> Self {
        Self { tx }
    }

    /// Serialize and enqueue one frame. Serialization cannot realistically fail
    /// for our own types; a closed channel means the process is already leaving.
    pub fn send<T: Serialize>(&self, message: &T) {
        if let Ok(line) = serde_json::to_string(message) {
            let _ = self.tx.send(line);
        }
    }

    /// Emit a `log` event for the plugin's diagnostics log.
    pub fn log(&self, level: &str, message: impl Into<String>) {
        self.send(&Event::Log {
            level: level.to_string(),
            message: message.into(),
        });
    }

    /// Emit one HTTP-attempt record.
    pub fn call(&self, record: serde_json::Value) {
        self.send(&Event::Call { record });
    }
}
