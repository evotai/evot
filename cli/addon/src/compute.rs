//! NAPI bridge for `/compute`: every call is async so file reads and the ssh
//! probe never block the CLI's JS thread. Results cross as JSON strings.

use napi::Result as NapiResult;
use napi_derive::napi;

fn to_napi(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

fn json<T: serde::Serialize>(value: &T) -> NapiResult<String> {
    serde_json::to_string(value).map_err(to_napi)
}

fn service() -> NapiResult<evot::compute::ComputeService> {
    evot::compute::ComputeService::default_location().map_err(to_napi)
}

#[napi]
pub async fn compute_list() -> NapiResult<String> {
    json(&service()?.list().await.map_err(to_napi)?)
}

/// Local-only: ssh config, shell history and tailscale. Connects to nothing.
#[napi]
pub async fn compute_discover() -> NapiResult<String> {
    json(&service()?.discover().await.map_err(to_napi)?)
}

/// One read-only ssh round trip to a machine the user chose.
#[napi]
pub async fn compute_probe(target: String) -> NapiResult<String> {
    json(&service()?.probe(&target).await.map_err(to_napi)?)
}

#[napi]
pub async fn compute_create(input_json: String) -> NapiResult<String> {
    let input: evot::compute::NewMachine = serde_json::from_str(&input_json).map_err(to_napi)?;
    json(&service()?.create(input).await.map_err(to_napi)?)
}

#[napi]
pub async fn compute_update(id: String, patch_json: String) -> NapiResult<String> {
    let patch: evot::compute::MachinePatch = serde_json::from_str(&patch_json).map_err(to_napi)?;
    json(&service()?.update(&id, patch).await.map_err(to_napi)?)
}

#[napi]
pub async fn compute_delete(id: String) -> NapiResult<bool> {
    service()?.delete(&id).await.map_err(to_napi)
}

/// Probe a stored machine and record the outcome.
#[napi]
pub async fn compute_check(id: String) -> NapiResult<String> {
    json(&service()?.check(&id).await.map_err(to_napi)?)
}
