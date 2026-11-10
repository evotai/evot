use std::collections::HashMap;
use std::time::Duration;

use futures::SinkExt;
use futures::StreamExt;
use prost::Message as ProstMessage;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::message::MessageDedup;
use super::message::ParsedMessage;
use super::token::TokenCache;
use crate::base::error::EvotError;
use crate::base::error::Result;

// ── Protobuf (pbbp2) ──

#[derive(Clone, PartialEq, ProstMessage)]
pub struct PbHeader {
    #[prost(string, required, tag = "1")]
    pub key: String,
    #[prost(string, required, tag = "2")]
    pub value: String,
}

#[derive(Clone, PartialEq, ProstMessage)]
pub struct PbFrame {
    #[prost(uint64, required, tag = "1")]
    pub seq_id: u64,
    #[prost(uint64, required, tag = "2")]
    pub log_id: u64,
    #[prost(int32, required, tag = "3")]
    pub service: i32,
    #[prost(int32, required, tag = "4")]
    pub method: i32,
    #[prost(message, repeated, tag = "5")]
    pub headers: Vec<PbHeader>,
    #[prost(string, optional, tag = "6")]
    pub payload_encoding: Option<String>,
    #[prost(string, optional, tag = "7")]
    pub payload_type: Option<String>,
    #[prost(bytes = "vec", optional, tag = "8")]
    pub payload: Option<Vec<u8>>,
    #[prost(string, optional, tag = "9")]
    pub log_id_new: Option<String>,
}

impl PbFrame {
    fn get_header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }
}

const FRAME_METHOD_CONTROL: i32 = 0;
const FRAME_METHOD_DATA: i32 = 1;
const DEFAULT_PING_INTERVAL_SECS: u64 = 120;
const FEISHU_DOMAIN: &str = "https://open.feishu.cn";

type MultiPartCache = HashMap<String, (tokio::time::Instant, Vec<Option<Vec<u8>>>)>;

// ── Decoded frame ──

pub struct DecodedFrame {
    pub response: Option<PbFrame>,
    pub event_payload: Option<String>,
    pub updated_ping_interval: Option<Duration>,
}

pub fn decode_frame(data: &[u8], msg_cache: &mut MultiPartCache) -> DecodedFrame {
    let frame = match PbFrame::decode(data) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(channel = "feishu", error = %e, "failed to decode protobuf frame");
            return DecodedFrame {
                response: None,
                event_payload: None,
                updated_ping_interval: None,
            };
        }
    };

    if frame.method == FRAME_METHOD_CONTROL {
        let mut updated_ping_interval = None;
        let msg_type = frame.get_header("type").unwrap_or("");
        if msg_type == "pong" {
            if let Some(payload) = &frame.payload {
                if let Ok(conf) = serde_json::from_slice::<serde_json::Value>(payload) {
                    if let Some(pi) = conf.get("PingInterval").and_then(|v| v.as_u64()) {
                        if pi > 0 {
                            updated_ping_interval = Some(Duration::from_secs(pi));
                        }
                    }
                }
            }
        }
        return DecodedFrame {
            response: None,
            event_payload: None,
            updated_ping_interval,
        };
    }

    if frame.method != FRAME_METHOD_DATA {
        return DecodedFrame {
            response: None,
            event_payload: None,
            updated_ping_interval: None,
        };
    }

    let msg_type = frame.get_header("type").unwrap_or("").to_string();
    let msg_id = frame.get_header("message_id").unwrap_or("").to_string();
    let sum: usize = frame
        .get_header("sum")
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let seq: usize = frame
        .get_header("seq")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let payload_bytes = frame.payload.clone().unwrap_or_default();

    // Multi-part message combining
    let full_payload = if sum > 1 {
        let (_, buf) = msg_cache
            .entry(msg_id.clone())
            .or_insert_with(|| (tokio::time::Instant::now(), vec![None; sum]));
        if seq < buf.len() {
            buf[seq] = Some(payload_bytes);
        }
        if buf.iter().all(|p| p.is_some()) {
            let combined: Vec<u8> = buf
                .iter()
                .filter_map(|p| p.as_ref())
                .flat_map(|p| p.clone())
                .collect();
            msg_cache.remove(&msg_id);
            combined
        } else {
            return DecodedFrame {
                response: None,
                event_payload: None,
                updated_ping_interval: None,
            };
        }
    } else {
        payload_bytes
    };

    let payload_str = String::from_utf8_lossy(&full_payload).to_string();

    // Build ACK response
    let mut resp_frame = frame.clone();
    resp_frame.payload = Some(r#"{"code": 200}"#.as_bytes().to_vec());

    let event_payload = if msg_type == "event" {
        Some(payload_str)
    } else {
        None
    };

    DecodedFrame {
        response: Some(resp_frame),
        event_payload,
        updated_ping_interval: None,
    }
}

// ── Helpers ──

fn build_ping_frame(service_id: i32) -> PbFrame {
    PbFrame {
        seq_id: 0,
        log_id: 0,
        service: service_id,
        method: FRAME_METHOD_CONTROL,
        headers: vec![PbHeader {
            key: "type".into(),
            value: "ping".into(),
        }],
        payload_encoding: None,
        payload_type: None,
        payload: None,
        log_id_new: None,
    }
}

// ── Endpoint ──

pub async fn get_ws_endpoint(
    client: &reqwest::Client,
    app_id: &str,
    app_secret: &str,
) -> Result<(String, u64)> {
    let url = format!("{FEISHU_DOMAIN}/callback/ws/endpoint");
    let resp = client
        .post(&url)
        .header("locale", "zh")
        .json(&serde_json::json!({
            "AppID": app_id,
            "AppSecret": app_secret,
        }))
        .send()
        .await
        .map_err(|e| EvotError::Run(format!("feishu ws endpoint: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(EvotError::Run(format!(
            "feishu ws endpoint HTTP {status}: {body}"
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| EvotError::Run(format!("feishu ws endpoint response: {e}")))?;

    let code = json["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = json["msg"].as_str().unwrap_or("unknown error");
        return Err(EvotError::Run(format!(
            "feishu ws endpoint failed: code={code}, msg={msg}"
        )));
    }

    let ws_url = json["data"]["URL"]
        .as_str()
        .ok_or_else(|| EvotError::Run("feishu ws endpoint: missing URL".into()))?
        .to_string();

    let ping_interval = json["data"]["ClientConfig"]["PingInterval"]
        .as_u64()
        .unwrap_or(DEFAULT_PING_INTERVAL_SECS);

    Ok((ws_url, ping_interval))
}

// ── Receive loop ──

pub struct WsContext<'a> {
    pub client: &'a reqwest::Client,
    pub app_id: &'a str,
    pub app_secret: &'a str,
    pub token_cache: &'a TokenCache,
    pub config: &'a crate::conf::channels::FeishuChannelConfig,
    pub bot_open_id: &'a str,
}

/// Result of one WS connection session. Returns parsed messages via callback.
pub async fn ws_receive_loop<F, Fut>(
    ctx: &WsContext<'_>,
    cancel: &tokio_util::sync::CancellationToken,
    mut on_message: F,
) -> Result<()>
where
    F: FnMut(ParsedMessage) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let (ws_url, ping_interval_secs) =
        get_ws_endpoint(ctx.client, ctx.app_id, ctx.app_secret).await?;

    // Rustls (webpki roots) via tokio-tungstenite's default connector — avoids
    // linking against the system OpenSSL so releases stay portable to older distros.
    let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| EvotError::Run(format!("feishu ws connect: {e}")))?;

    // Only a completed WebSocket handshake means the transport is connected.
    let key = crate::surface::gateway::health::credential_key(ctx.app_id, ctx.app_secret);
    crate::surface::gateway::health::set(
        &key,
        crate::surface::gateway::health::ConnectionState::Connected,
        "Connected",
    );
    let (mut write, mut read) = ws_stream.split();

    let service_id: i32 = reqwest::Url::parse(&ws_url)
        .ok()
        .and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == "service_id")
                .and_then(|(_, v)| v.parse().ok())
        })
        .unwrap_or(0);

    let mut ping_interval_dur = Duration::from_secs(ping_interval_secs);
    let mut ping_timer = tokio::time::interval(ping_interval_dur);
    ping_timer.tick().await;

    // Send initial ping
    let initial_ping = build_ping_frame(service_id);
    write
        .send(WsMessage::Binary(initial_ping.encode_to_vec().into()))
        .await
        .map_err(|e| EvotError::Run(format!("feishu ws initial ping: {e}")))?;

    let mut msg_cache: MultiPartCache = HashMap::new();
    let mut dedup = MessageDedup::new(Duration::from_secs(30 * 60));
    let mut last_recv = tokio::time::Instant::now();
    let mut cache_cleanup = tokio::time::interval(Duration::from_secs(60));
    cache_cleanup.tick().await;

    loop {
        let heartbeat_timeout = ping_interval_dur.max(Duration::from_secs(120)) * 3;
        tokio::select! {
            biased;

            _ = cancel.cancelled() => {
                let _ = write.send(WsMessage::Close(None)).await;
                return Ok(());
            }

            _ = cache_cleanup.tick() => {
                if last_recv.elapsed() > heartbeat_timeout {
                    tracing::warn!(channel = "feishu", "heartbeat timeout, reconnecting");
                    return Err(EvotError::Run("feishu ws: heartbeat timeout".into()));
                }
                msg_cache.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(300));
            }

            msg = read.next() => {
                match msg {
                    Some(Ok(WsMessage::Binary(data))) => {
                        last_recv = tokio::time::Instant::now();
                        let decoded = decode_frame(&data, &mut msg_cache);

                        if let Some(new_dur) = decoded.updated_ping_interval {
                            if new_dur != ping_interval_dur {
                                ping_interval_dur = new_dur;
                                ping_timer = tokio::time::interval(ping_interval_dur);
                                ping_timer.tick().await;
                            }
                        }

                        // Send ACK before processing
                        if let Some(resp) = decoded.response {
                            let _ = write.send(WsMessage::Binary(resp.encode_to_vec().into())).await;
                        }

                        if let Some(payload) = decoded.event_payload {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&payload) {
                                if let Some(parsed) =
                                    super::message::parse_event(
                                        &json,
                                        ctx.config,
                                        ctx.bot_open_id,
                                        &mut dedup,
                                    )
                                {
                                    // Add thumbsup reaction only for messages we will process
                                    if !parsed.message_id.is_empty() {
                                        let c = ctx.client.clone();
                                        let tc = ctx.token_cache.clone();
                                        let aid = ctx.app_id.to_string();
                                        let asec = ctx.app_secret.to_string();
                                        let mid = parsed.message_id.clone();
                                        tokio::spawn(async move {
                                            super::delivery::add_reaction(
                                                &c, &tc, &aid, &asec, &mid, "THUMBSUP",
                                            )
                                            .await;
                                        });
                                    }
                                    on_message(parsed).await;
                                }
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        let _ = write.send(WsMessage::Pong(data)).await;
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        tracing::info!(channel = "feishu", "websocket closed");
                        return Ok(());
                    }
                    Some(Err(e)) => {
                        return Err(EvotError::Run(format!("feishu ws read: {e}")));
                    }
                    _ => {}
                }
            }

            _ = ping_timer.tick() => {
                let encoded = build_ping_frame(service_id).encode_to_vec();
                if write.send(WsMessage::Binary(encoded.into())).await.is_err() {
                    return Err(EvotError::Run("feishu ws ping failed".into()));
                }
            }
        }
    }
}
