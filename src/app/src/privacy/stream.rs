//! Restoring a reply as it streams. A placeholder can arrive split across
//! deltas (`{{API_` then `KEY_k3v9x2mq}}`), so the tail of each delta that
//! may still become one is held until the next delta, or any other event,
//! settles it.
use evot_engine::provider::StreamEvent;

use super::request::restore_message;
use super::request::restore_value;
use super::vault::Vault;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Channel {
    Text,
    Thinking,
    /// Raw JSON fragments of tool-call arguments: values go in escaped.
    ToolArgs,
}

struct Pending {
    channel: Channel,
    index: usize,
    id: String,
    name: String,
    held: String,
}

pub struct StreamRestorer<'a> {
    vault: &'a Vault,
    pending: Vec<Pending>,
}

impl<'a> StreamRestorer<'a> {
    pub(super) fn new(vault: &'a Vault) -> Self {
        Self {
            vault,
            pending: Vec::new(),
        }
    }

    /// The events to forward for one from the provider.
    pub fn push(&mut self, event: StreamEvent) -> Vec<StreamEvent> {
        match event {
            StreamEvent::TextDelta {
                content_index,
                delta,
            } => self.delta(
                Channel::Text,
                content_index,
                String::new(),
                String::new(),
                delta,
            ),
            StreamEvent::ThinkingDelta {
                content_index,
                delta,
            } => self.delta(
                Channel::Thinking,
                content_index,
                String::new(),
                String::new(),
                delta,
            ),
            StreamEvent::ToolCallDelta {
                content_index,
                id,
                name,
                delta,
            } => self.delta(Channel::ToolArgs, content_index, id, name, delta),
            mut event => {
                let mut out = self.flush();
                match &mut event {
                    StreamEvent::ToolCallEnd { arguments, .. } => {
                        restore_value(self.vault, arguments)
                    }
                    StreamEvent::Done { message } | StreamEvent::Error { message } => {
                        restore_message(self.vault, message);
                    }
                    _ => {}
                }
                out.push(event);
                out
            }
        }
    }

    /// Everything still held, restored.
    pub fn flush(&mut self) -> Vec<StreamEvent> {
        std::mem::take(&mut self.pending)
            .into_iter()
            .filter(|p| !p.held.is_empty())
            .map(|p| {
                let text = self.restore(p.channel, p.held);
                event(p.channel, p.index, p.id, p.name, text)
            })
            .collect()
    }

    fn delta(
        &mut self,
        channel: Channel,
        index: usize,
        id: String,
        name: String,
        delta: String,
    ) -> Vec<StreamEvent> {
        let slot = match self
            .pending
            .iter()
            .position(|p| p.channel == channel && p.index == index)
        {
            Some(slot) => slot,
            None => {
                self.pending.push(Pending {
                    channel,
                    index,
                    id: id.clone(),
                    name: name.clone(),
                    held: String::new(),
                });
                self.pending.len() - 1
            }
        };
        let pending = &mut self.pending[slot];
        pending.held.push_str(&delta);
        let ready = pending.held.len() - self.vault.partial_tail(&pending.held);
        if ready == 0 || !pending.held.is_char_boundary(ready) {
            return Vec::new();
        }
        let tail = pending.held.split_off(ready);
        let text = std::mem::replace(&mut pending.held, tail);
        let text = self.restore(channel, text);
        vec![event(channel, index, id, name, text)]
    }

    fn restore(&self, channel: Channel, text: String) -> String {
        self.vault
            .restore(&text, channel == Channel::ToolArgs)
            .unwrap_or(text)
    }
}

fn event(
    channel: Channel,
    content_index: usize,
    id: String,
    name: String,
    delta: String,
) -> StreamEvent {
    match channel {
        Channel::Text => StreamEvent::TextDelta {
            content_index,
            delta,
        },
        Channel::Thinking => StreamEvent::ThinkingDelta {
            content_index,
            delta,
        },
        Channel::ToolArgs => StreamEvent::ToolCallDelta {
            content_index,
            id,
            name,
            delta,
        },
    }
}
