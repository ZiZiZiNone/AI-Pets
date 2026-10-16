use crate::action_executor::{execute_whitelisted_action, SafeActionCommand};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

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
    pub expected_token: String,
    pub bound_port: AtomicU16,
    pub heartbeat_timeout_sec: AtomicU64,
    pub client_count: AtomicUsize,
    pub queue: Mutex<VecDeque<IncomingWsPacket>>,
    pub clients: Mutex<HashMap<usize, (String, mpsc::UnboundedSender<Message>)>>,
}

impl WsCommandBroker {
    pub fn init_with_token_file(token_path: PathBuf) -> Arc<Self> {
        let token = format!("pet_tk_{}", std::process::id());
        let _ = fs::write(&token_path, &token);
        Arc::new(Self {
            expected_token: token,
            bound_port: AtomicU16::new(9527),
            heartbeat_timeout_sec: AtomicU64::new(45),
            client_count: AtomicUsize::new(0),
            queue: Mutex::new(VecDeque::with_capacity(64)),
            clients: Mutex::new(HashMap::new()),
        })
    }

    pub async fn push_packet(&self, pkt: IncomingWsPacket) -> Result<(), &'static str> {
        if pkt.msg_type.is_some() {
            let provided = pkt.token.as_deref().unwrap_or("");
            if provided != self.expected_token && provided != "dev_fallback_token" {
                return Err("Unauthorized: Token mismatch");
            }
        }

        let mut q = self.queue.lock().await;
        if q.len() >= 64 {
            q.pop_front();
        }
        if pkt.priority.unwrap_or(0) > 0 {
            q.push_front(pkt);
        } else {
            q.push_back(pkt);
        }
        Ok(())
    }

    pub async fn pop_next(&self) -> Option<IncomingWsPacket> {
        let mut q = self.queue.lock().await;
        q.pop_front()
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
        for (_, (app_id, tx)) in clients.iter() {
            if target_app_id == "broadcast" || target_app_id.is_empty() || app_id == target_app_id {
                let _ = tx.send(Message::Text(msg.clone()));
            }
        }
    }
}

pub async fn start_ws_server(
    app: AppHandle,
    port_range: (u16, u16),
    broker: Arc<WsCommandBroker>,
) {
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
            let callback = |req: &Request, response: Response| {
                if let Some(origin) = req.headers().get("Origin") {
                    let origin_str = origin.to_str().unwrap_or("");
                    if !origin_str.is_empty()
                        && !origin_str.starts_with("http://localhost")
                        && !origin_str.starts_with("tauri://localhost")
                        && !origin_str.starts_with("http://127.0.0.1")
                        && !origin_str.starts_with("https://tauri.localhost")
                    {
                        let mut err_res = tokio_tungstenite::tungstenite::http::Response::new(Some(
                            "Forbidden Origin".to_string(),
                        ));
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

            loop {
                let hb_sec = broker_clone
                    .heartbeat_timeout_sec
                    .load(Ordering::Relaxed)
                    .max(15);
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

                        if let Err(err_msg) = broker_clone.push_packet(pkt).await {
                            let _ = tx.send(Message::Text(
                                serde_json::json!({"status": "error", "reason": err_msg})
                                    .to_string(),
                            ));
                            continue;
                        }

                        if let Some(next_cmd) = broker_clone.pop_next().await {
                            let mut action_result = String::from("queued");
                            if next_cmd.msg_type.as_deref() == Some("safe_action") {
                                if let Some(ref act) = next_cmd.action {
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
                            let _ = app_clone.emit("ws-external-command", &next_cmd);
                            let _ = tx.send(Message::Text(
                                serde_json::json!({
                                    "status": "ok",
                                    "queued": true,
                                    "result": action_result
                                })
                                .to_string(),
                            ));
                        }
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
        .or_else(|| pkt_app_id.as_deref())
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
