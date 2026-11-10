//! Compute operations used by the CLI: list, discover, probe, and the
//! confirmed create / update / delete of machine records.

use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use super::alias;
use super::discover;
use super::model::CheckStatus;
use super::model::ComputeCandidate;
use super::model::ComputeMachine;
use super::model::MachinePatch;
use super::model::NewMachine;
use super::model::ProbeResult;
use super::probe;
use super::store;
use super::validate;
use crate::base::blocking::blocking_io;
use crate::base::error::EvotError;
use crate::base::error::Result;

const TAILSCALE_TIMEOUT: Duration = Duration::from_secs(2);

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn not_found(id: &str) -> EvotError {
    EvotError::Store(format!("compute machine not found: {id}"))
}

fn ensure_unique(
    machines: &[ComputeMachine],
    except_id: Option<&str>,
    name: Option<&str>,
    target: Option<&str>,
) -> Result<()> {
    for machine in machines {
        if Some(machine.id.as_str()) == except_id {
            continue;
        }
        if let Some(name) = name {
            if machine.name.eq_ignore_ascii_case(name) {
                return Err(EvotError::Conf(format!(
                    "a machine named {name} already exists"
                )));
            }
        }
        if let Some(target) = target {
            if machine.ssh_target == target {
                return Err(EvotError::Conf(format!(
                    "{target} is already added as {}",
                    machine.name
                )));
            }
        }
    }
    Ok(())
}

/// Build a validated record from caller input. Pure; does not touch storage.
pub fn build_machine(input: NewMachine, id: String, at: &str) -> Result<ComputeMachine> {
    Ok(ComputeMachine {
        id,
        name: validate::name(&input.name)?,
        ssh_target: validate::ssh_target(&input.ssh_target)?,
        description: validate::description(&input.description)?,
        enabled: true,
        profile: input.profile,
        last_check: input.last_check,
        created_at: at.to_string(),
        updated_at: at.to_string(),
    })
}

/// Apply a validated patch. Pure; does not touch storage.
pub fn apply_patch(machine: &mut ComputeMachine, patch: MachinePatch, at: &str) -> Result<()> {
    if let Some(name) = patch.name {
        machine.name = validate::name(&name)?;
    }
    if let Some(description) = patch.description {
        machine.description = validate::description(&description)?;
    }
    if let Some(enabled) = patch.enabled {
        machine.enabled = enabled;
    }
    machine.updated_at = at.to_string();
    Ok(())
}

/// Scan local files under `home` and rank what they name. Blocking.
pub fn discover_in(
    home: &Path,
    histfile: Option<&Path>,
    tailscale_status: Option<&str>,
    existing_targets: &[String],
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Vec<ComputeCandidate>> {
    let scan = discover::scan_local(home, histfile, cancel)?;
    let peers = tailscale_status
        .map(discover::parse_tailscale_status)
        .unwrap_or_default();
    Ok(discover::rank(
        &scan,
        &peers,
        existing_targets,
        chrono::Utc::now().timestamp(),
    ))
}

async fn tailscale_status() -> Option<String> {
    let child = tokio::process::Command::new("tailscale")
        .arg("status")
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = tokio::time::timeout(TAILSCALE_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Debug, Clone)]
pub struct ComputeService {
    path: PathBuf,
    /// Home whose `~/.ssh/config` holds machine aliases. `None` leaves ssh
    /// config alone and stores targets as given.
    home: Option<PathBuf>,
}

impl ComputeService {
    pub fn new(path: PathBuf) -> Self {
        Self { path, home: None }
    }

    /// Add machine aliases to the ssh config under `home`.
    pub fn with_ssh_home(mut self, home: PathBuf) -> Self {
        self.home = Some(home);
        self
    }

    /// The service for `~/.evotai/compute.json`, with aliases in
    /// `~/.ssh/config`.
    pub fn default_location() -> Result<Self> {
        Ok(Self::new(store::default_path()?).with_ssh_home(crate::base::paths::home_dir()?))
    }

    pub async fn list(&self) -> Result<Vec<ComputeMachine>> {
        let path = self.path.clone();
        blocking_io("compute reader", move |_| {
            store::read_document(&path).map(|doc| doc.machines)
        })
        .await
    }

    /// Local-only discovery: reads files and asks the local tailscale daemon.
    /// Connects to no machine.
    pub async fn discover(&self) -> Result<Vec<ComputeCandidate>> {
        let existing: Vec<String> = self
            .list()
            .await?
            .into_iter()
            .map(|machine| machine.ssh_target)
            .collect();
        let tailscale = tailscale_status().await;
        let home = crate::base::paths::home_dir()?;
        let histfile = std::env::var_os("HISTFILE").map(PathBuf::from);
        blocking_io("compute discovery", move |cancel| {
            discover_in(
                &home,
                histfile.as_deref(),
                tailscale.as_deref(),
                &existing,
                cancel,
            )
        })
        .await
    }

    pub async fn probe(&self, target: &str) -> Result<ProbeResult> {
        let mut result = probe::probe(target).await?;
        if let Some(home) = self.home.clone() {
            let target = result.target.clone();
            result.ssh_alias = blocking_io("ssh config reader", move |cancel| {
                Ok(alias::is_config_alias(&home, &target, cancel))
            })
            .await?;
        }
        Ok(result)
    }

    pub async fn create(&self, input: NewMachine) -> Result<ComputeMachine> {
        let mut machine = build_machine(input, crate::types::new_id(), &now())?;
        let path = self.path.clone();
        let home = self.home.clone();
        blocking_io("compute writer", move |cancel| {
            store::mutate(&path, |machines| {
                ensure_unique(
                    machines,
                    None,
                    Some(&machine.name),
                    Some(&machine.ssh_target),
                )?;
                if let Some(home) = &home {
                    machine.ssh_target =
                        alias::ensure_alias(home, &machine.name, &machine.ssh_target, cancel)?;
                    ensure_unique(machines, None, None, Some(&machine.ssh_target))?;
                }
                machines.push(machine.clone());
                Ok(machine)
            })
        })
        .await
        .map(|(machine, _)| machine)
    }

    pub async fn update(&self, id: &str, patch: MachinePatch) -> Result<ComputeMachine> {
        let id = id.to_string();
        let path = self.path.clone();
        let at = now();
        blocking_io("compute writer", move |_| {
            store::mutate(&path, |machines| {
                let mut updated = machines
                    .iter()
                    .find(|machine| machine.id == id)
                    .cloned()
                    .ok_or_else(|| not_found(&id))?;
                apply_patch(&mut updated, patch, &at)?;
                ensure_unique(machines, Some(&id), Some(&updated.name), None)?;
                for machine in machines.iter_mut() {
                    if machine.id == id {
                        *machine = updated.clone();
                    }
                }
                Ok(updated)
            })
        })
        .await
        .map(|(machine, _)| machine)
    }

    pub async fn delete(&self, id: &str) -> Result<bool> {
        let id = id.to_string();
        let path = self.path.clone();
        blocking_io("compute writer", move |_| {
            store::mutate(&path, |machines| {
                let before = machines.len();
                machines.retain(|machine| machine.id != id);
                Ok(machines.len() < before)
            })
        })
        .await
        .map(|(removed, _)| removed)
    }

    /// Probe a stored machine and record the outcome. A failed probe keeps the
    /// last known profile and records why it failed.
    pub async fn check(&self, id: &str) -> Result<ComputeMachine> {
        let machine = self
            .list()
            .await?
            .into_iter()
            .find(|machine| machine.id == id)
            .ok_or_else(|| not_found(id))?;
        let result = probe::probe(&machine.ssh_target).await?;
        self.record_check(id, result).await
    }

    pub async fn record_check(&self, id: &str, result: ProbeResult) -> Result<ComputeMachine> {
        let id = id.to_string();
        let path = self.path.clone();
        blocking_io("compute writer", move |_| {
            store::mutate(&path, |machines| {
                let machine = machines
                    .iter_mut()
                    .find(|machine| machine.id == id)
                    .ok_or_else(|| not_found(&id))?;
                if result.check.status == CheckStatus::Ok {
                    if let Some(profile) = result.profile.clone() {
                        machine.profile = Some(profile);
                    }
                }
                machine.last_check = Some(result.check.clone());
                Ok(machine.clone())
            })
        })
        .await
        .map(|(machine, _)| machine)
    }
}
