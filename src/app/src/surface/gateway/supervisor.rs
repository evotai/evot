//! Generic channel lifecycle reconciliation. Adapter registrations own config
//! interpretation and startup; transports own their reconnect/backoff policy.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::channel_tasks::ChannelTasks;
use super::registry::PreparedChannel;
use super::registry::{self};
use crate::agent::Agent;
use crate::agent::RunManager;
use crate::conf::Config;

struct RunningChannel {
    revision: String,
    tasks: ChannelTasks,
}

/// Owns every child task, including when its supervisor is force-aborted.
#[derive(Default)]
pub struct ChannelSupervisor {
    running: HashMap<&'static str, RunningChannel>,
}

impl ChannelSupervisor {
    pub async fn reconcile(&mut self, desired: Vec<PreparedChannel>, cancel: &CancellationToken) {
        let obsolete: Vec<_> = self
            .running
            .iter()
            .filter(|(name, running)| {
                running.tasks.is_finished()
                    || !desired
                        .iter()
                        .any(|next| next.name == **name && next.revision == running.revision)
            })
            .map(|(name, _)| *name)
            .collect();
        for name in obsolete {
            if let Some(old) = self.running.remove(name) {
                old.tasks.shutdown(Duration::from_secs(2)).await;
            }
        }
        for channel in desired {
            if cancel.is_cancelled() {
                break;
            }
            if self.running.contains_key(channel.name) {
                continue;
            }
            let child = cancel.child_token();
            let handle = (channel.start)(child.clone());
            self.running.insert(channel.name, RunningChannel {
                revision: channel.revision,
                tasks: ChannelTasks::new(child, vec![handle]),
            });
        }
    }

    pub async fn shutdown(mut self) {
        for (_, running) in self.running.drain() {
            running.tasks.shutdown(Duration::from_secs(2)).await;
        }
    }
}

pub fn spawn(config: &Config, agent: Arc<Agent>, cancel: CancellationToken) -> JoinHandle<()> {
    let mut config = config.clone();
    tokio::spawn(async move {
        let manager = RunManager::new(agent);
        let mut supervisor = ChannelSupervisor::default();
        // Start from the already validated startup configuration, then reload.
        supervisor
            .reconcile(
                registry::prepare_all(&config.channels, manager.clone()),
                &cancel,
            )
            .await;
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tick.tick() => {},
            }
            match Config::load_with_env_file(config.env_file_path.to_str()) {
                Ok(fresh) => config = fresh,
                Err(_) => {
                    tracing::warn!("channel config reload failed; keeping current transports");
                    continue;
                }
            }
            supervisor
                .reconcile(
                    registry::prepare_all(&config.channels, manager.clone()),
                    &cancel,
                )
                .await;
        }
        supervisor.shutdown().await;
    })
}
