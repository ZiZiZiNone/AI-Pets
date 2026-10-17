use crate::action_executor::{execute_whitelisted_action, SafeActionCommand};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

pub const DEFAULT_WS_PORT_RANGE: (u16, u16) = (9527, 9537);
pub const DEFAULT_HEARTBEAT_SEC: u64 = 45;
pub const MIN_HEARTBEAT_SEC: u64 = 15;
const TOKEN_PREFIX: &str = "pet_tk_";

/// Derives the per-process bus token from OS-seeded randomness.
///
/// `RandomState` is seeded by the platform CSPRNG rather than by observable process
/// metadata, so the token cannot be reconstructed by another local process the way a
/// PID-derived value could.
fn generate_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(nanos);
    hasher.write_u32(std::process::id());
    let primary = hasher.finish();
    let secondary = RandomState::new().build_hasher().finish();
    format!("{}{:016x}{:016x}", TOKEN_PREFIX, primary, secondary)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingWsPacket {
    pub token: Option<String>,
    pub priority: Option<u8>,
    pub msg_type: Option<String>,
    pub text: Option<String>,
    pub emotion: Option<String>,
    pub motion: Option<String>,
    pub duration_ms: Option<u64>,
    pub action: Option<SafeActionCommand>,
    pub jsonrpc: Option<String>,
    pub id: Option<serde_json::Value>,
    pub app_id: Option<String>,
    pub method: Option<String>,
    pub params: Option<serde_json::Value>,
}

pub struct WsCommandBroker {
    expected_token: String,
    pub bound_port: AtomicU16,
    pub heartbeat_timeout_sec: AtomicU64,
    pub client_count: AtomicUsize,
    pub clients: Mutex<HashMap<usize, (String, mpsc::UnboundedSender<Message>)>>,
}

impl WsCommandBroker {
    pub fn init_with_token_file(token_path: PathBuf) -> Arc<Self> {
        let token = generate_token();
        let _ = fs::write(&token_path, &token);
        Arc::new(Self {
            expected_token: token,
            bound_port: AtomicU16::new(DEFAULT_WS_PORT_RANGE.0),
            heartbeat_timeout_sec: AtomicU64::new(DEFAULT_HEARTBEAT_SEC),
            client_count: AtomicUsize::new(0),
            clients: Mutex::new(HashMap::new()),
        })
    }

    /// Single authentication gate for the bus. Every inbound packet must present the
    /// process token, regardless of which method it carries.
    fn authorize(&self, provided: Option<&str>) -> bool {
        match provided {
            Some(token) => token == self.expected_token,
            None => false,
        }
    }

    pub async fn broadcast_event(
        &self,
        target_app_id: &str,
        method: &str,
        params: serde_json::Value,
    ) {
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        })
        .to_string();

        let clients = self.clients.lock().await;
        for (app_id, tx) in clients.values() {
            if target_app_id == "broadcast" || target_app_id.is_empty() || app_id == target_app_id {
                let _ = tx.send(Message::Text(msg.clone()));
            }
        }
    }
}

pub async fn start_ws_server(app: AppHandle, port_range: (u16, u16), broker: Arc<WsCommandBroker>) {
    let start_port = port_range.0.max(1024);
    let end_port = port_range.1.max(start_port);

    let mut listener_opt = None;
    let mut active_port: u16 = start_port;

    for p in start_port..=end_port {
        if let Ok(l) = TcpListener::bind(format!("127.0.0.1:{}", p)).await {
            listener_opt = Some(l);
            active_port = p;
            break;
        }
    }

    let listener = match listener_opt {
        Some(l) => l,
        None => {
            eprintln!(
                "[ws_server] Failed to bind any port in range {}..={}",
                start_port, end_port
            );
            return;
        }
    };

    broker.bound_port.store(active_port, Ordering::Relaxed);
    let mut next_conn_id: usize = 1;

    while let Ok((stream, _)) = listener.accept().await {
        let conn_id = next_conn_id;
        next_conn_id += 1;

        let app_clone = app.clone();
        let broker_clone = broker.clone();

        tokio::spawn(async move {
            // `accept_hdr_async` fixes this signature, so the large `Err` variant is
            // dictated by tungstenite and cannot be boxed away.
            #[allow(clippy::result_large_err)]
            let callback = |req: &Request, response: Response| {
                if let Some(origin) = req.headers().get("Origin") {
                    let origin_str = origin.to_str().unwrap_or("");
                    if !origin_str.is_empty()
                        && !origin_str.starts_with("http://localhost")
                        && !origin_str.starts_with("tauri://localhost")
                        && !origin_str.starts_with("http://127.0.0.1")
                        && !origin_str.starts_with("https://tauri.localhost")
                    {
                        let mut err_res = tokio_tungstenite::tungstenite::http::Response::new(
                            Some("Forbidden Origin".to_string()),
                        );
                        *err_res.status_mut() =
                            tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                        return Err(err_res);
                    }
                }
                Ok(response)
            };

            let ws_stream = match accept_hdr_async(stream, callback).await {
                Ok(ws) => ws,
                Err(_) => return,
            };

            let (mut write, mut read) = ws_stream.split();
            let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

            broker_clone.client_count.fetch_add(1, Ordering::Relaxed);
            {
                let mut map = broker_clone.clients.lock().await;
                map.insert(conn_id, (format!("ext_{}", conn_id), tx.clone()));
            }

            let write_task = tokio::spawn(async move {
                while let Some(out_msg) = rx.recv().await {
                    if write.send(out_msg).await.is_err() {
                        break;
                    }
                }
            });

            let mut registered_app_ids: HashSet<String> = HashSet::new();

            // The server drives the heartbeat. Relying on client-initiated Pings alone
            // would drop healthy but quiet connections once the read timeout elapsed.
            let ping_broker = broker_clone.clone();
            let ping_tx = tx.clone();
            let ping_task = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(
                    (ping_broker.heartbeat_timeout_sec.load(Ordering::Relaxed) / 2).max(1),
                ));
                loop {
                    ticker.tick().await;
                    if ping_tx.send(Message::Ping(Vec::new())).is_err() {
                        break;
                    }
                }
            });

            loop {
                let hb_sec = broker_clone
                    .heartbeat_timeout_sec
                    .load(Ordering::Relaxed)
                    .max(MIN_HEARTBEAT_SEC);
                let frame_res =
                    tokio::time::timeout(Duration::from_secs(hb_sec), read.next()).await;

                let msg = match frame_res {
                    Ok(Some(Ok(m))) => m,
                    Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
                };

                let raw_text = match msg {
                    Message::Text(t) => t,
                    Message::Ping(payload) => {
                        let _ = tx.send(Message::Pong(payload));
                        continue;
                    }
                    Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => continue,
                    Message::Close(_) => break,
                };

                match serde_json::from_str::<IncomingWsPacket>(&raw_text) {
                    Ok(pkt) => {
                        if !broker_clone.authorize(pkt.token.as_deref()) {
                            let _ = tx.send(Message::Text(
                                serde_json::json!({
                                    "status": "error",
                                    "reason": "Unauthorized: Token mismatch"
                                })
                                .to_string(),
                            ));
                            continue;
                        }

                        let resolved_aid = pkt.app_id.clone().or_else(|| {
                            pkt.params
                                .as_ref()
                                .and_then(|p| p.get("app_id"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        });

                        if let Some(ref aid) = resolved_aid {
                            registered_app_ids.insert(aid.clone());
                            let mut map = broker_clone.clients.lock().await;
                            if let Some(entry) = map.get_mut(&conn_id) {
                                entry.0 = aid.clone();
                            }
                        }

                        if let Some(ref method) = pkt.method {
                            let params = pkt.params.clone().unwrap_or(serde_json::json!({}));
                            handle_hotplug_method(&app_clone, method, &params, &resolved_aid);
                            let reply = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": pkt.id,
                                "status": "ok",
                                "method": method
                            });
                            let _ = tx.send(Message::Text(reply.to_string()));
                            continue;
                        }

                        let mut action_result = String::from("queued");
                        if pkt.msg_type.as_deref() == Some("safe_action") {
                            if let Some(ref act) = pkt.action {
                                match execute_whitelisted_action(act) {
                                    Ok(res) => action_result = res,
                                    Err(err) => {
                                        let _ = tx.send(Message::Text(
                                            serde_json::json!({"status": "error", "reason": err})
                                                .to_string(),
                                        ));
                                        continue;
                                    }
                                }
                            }
                        }

                        let _ = app_clone.emit("ws-external-command", &pkt);
                        let _ = tx.send(Message::Text(
                            serde_json::json!({
                                "status": "ok",
                                "queued": true,
                                "result": action_result
                            })
                            .to_string(),
                        ));
                    }
                    Err(e) => {
                        let _ = tx.send(Message::Text(
                            serde_json::json!({"status": "error", "reason": e.to_string()})
                                .to_string(),
                        ));
                    }
                }
            }

            broker_clone.client_count.fetch_sub(1, Ordering::Relaxed);
            {
                let mut map = broker_clone.clients.lock().await;
                map.remove(&conn_id);
            }
            for app_id in registered_app_ids {
                let _ = app_clone.emit(
                    "ws-menu-unregister",
                    serde_json::json!({ "app_id": app_id }),
                );
                let _ = app_clone.emit("hud-clear", serde_json::json!({ "app_id": app_id }));
            }
            write_task.abort();
            ping_task.abort();
        });
    }
}

fn handle_hotplug_method(
    app: &AppHandle,
    method: &str,
    params: &serde_json::Value,
    pkt_app_id: &Option<String>,
) {
    let app_id = params
        .get("app_id")
        .and_then(|v| v.as_str())
        .or(pkt_app_id.as_deref())
        .unwrap_or("external_app");

    match method {
        "pet.act" => {
            let _ = app.emit("ws-pet-act", params);
        }
        "pet.say" | "speak" => {
            let _ = app.emit("pet-speech-bubble", params);
        }
        "menu.register" => {
            let mut payload = params.clone();
            if let Some(obj) = payload.as_object_mut() {
                obj.entry("app_id")
                    .or_insert_with(|| serde_json::Value::String(app_id.to_string()));
            }
            let _ = app.emit("ws-menu-register", payload);
        }
        "menu.unregister" => {
            let _ = app.emit(
                "ws-menu-unregister",
                serde_json::json!({ "app_id": app_id }),
            );
        }
        "panel.open" => {
            if let Some(comp) = app.get_webview_window("companion") {
                let _ = comp.show();
            }
            let _ = app.emit("companion-load", params);
        }
        "panel.update" => {
            let _ = app.emit("companion-update-state", params);
        }
        "hud.draw" => {
            if let Some(hud) = app.get_webview_window("hud") {
                let _ = hud.show();
            }
            let _ = app.emit("hud-draw", params);
        }
        "hud.clear" => {
            let _ = app.emit("hud-clear", params);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker_with_token(name: &str) -> Arc<WsCommandBroker> {
        let path = std::env::temp_dir().join(format!("desktop-pet-host-{name}.token"));
        WsCommandBroker::init_with_token_file(path)
    }

    #[test]
    fn token_has_the_documented_shape() {
        let token = generate_token();
        assert!(token.starts_with(TOKEN_PREFIX), "missing prefix: {token}");
        // 128 bits rendered as two 16-digit hex halves.
        assert_eq!(
            token.len(),
            TOKEN_PREFIX.len() + 32,
            "wrong length: {token}"
        );
        let body = &token[TOKEN_PREFIX.len()..];
        assert!(
            body.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "token body must be lowercase hex: {token}"
        );
    }

    #[test]
    fn consecutive_tokens_differ() {
        let tokens: Vec<String> = (0..64).map(|_| generate_token()).collect();
        let unique: std::collections::HashSet<&String> = tokens.iter().collect();
        assert_eq!(
            unique.len(),
            tokens.len(),
            "token generator repeated itself"
        );
    }

    #[test]
    fn token_does_not_leak_the_process_id() {
        // The previous scheme was `pet_tk_{pid}`, which any local process could guess.
        let pid = std::process::id().to_string();
        let token = generate_token();
        assert!(
            !token.ends_with(&pid),
            "token still embeds the pid: {token}"
        );
    }

    #[test]
    fn authorize_accepts_only_the_exact_token() {
        let broker = broker_with_token("accepts");
        let valid = broker.expected_token.clone();
        assert!(broker.authorize(Some(&valid)));
    }

    #[test]
    fn authorize_rejects_missing_wrong_and_near_miss_tokens() {
        let broker = broker_with_token("rejects");
        let valid = broker.expected_token.clone();

        assert!(!broker.authorize(None), "missing token must be rejected");
        assert!(!broker.authorize(Some("")), "empty token must be rejected");
        assert!(!broker.authorize(Some("dev_fallback_token")));
        assert!(
            !broker.authorize(Some(&valid.to_uppercase())),
            "case must matter"
        );
        assert!(
            !broker.authorize(Some(&valid[..valid.len() - 1])),
            "prefix must not pass"
        );
        assert!(
            !broker.authorize(Some(&format!("{valid}x"))),
            "extension must not pass"
        );
        assert!(!broker.authorize(Some("pet_tk_0")));
    }

    #[test]
    fn tokens_from_two_brokers_are_not_interchangeable() {
        let a = broker_with_token("broker-a");
        let b = broker_with_token("broker-b");
        let a_token = a.expected_token.clone();
        let b_token = b.expected_token.clone();

        assert_ne!(a_token, b_token, "two processes must not share a token");
        assert!(
            !b.authorize(Some(&a_token)),
            "cross-process token must fail"
        );
        assert!(a.authorize(Some(&a_token)));
    }

    #[test]
    fn token_is_written_to_the_supplied_path() {
        let path = std::env::temp_dir().join("desktop-pet-host-written.token");
        let broker = WsCommandBroker::init_with_token_file(path.clone());
        let on_disk = std::fs::read_to_string(&path).expect("token file");
        assert_eq!(on_disk.trim(), broker.expected_token);
    }
}
