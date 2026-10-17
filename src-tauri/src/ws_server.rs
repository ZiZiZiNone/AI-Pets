use crate::action_executor::{execute_whitelisted_action, SafeActionCommand};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

pub const DEFAULT_WS_PORT_RANGE: (u16, u16) = (9527, 9537);
pub const DEFAULT_HEARTBEAT_SEC: u64 = 45;
pub const MIN_HEARTBEAT_SEC: u64 = 15;
pub const TOKEN_FILE_NAME: &str = ".pet_ws_token";
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
    token_path: Option<PathBuf>,
    pub bound_port: AtomicU16,
    pub heartbeat_timeout_sec: AtomicU64,
    pub client_count: AtomicUsize,
    pub clients: Mutex<HashMap<usize, (String, mpsc::UnboundedSender<Message>)>>,
}

impl WsCommandBroker {
    /// Builds the broker, writing the bus token to the first candidate that accepts it.
    ///
    /// Candidates are tried in order because the working directory is not always
    /// writable: a per-machine install runs from `Program Files`, where a standard user
    /// cannot create files. A token that is never written leaves the bus looking healthy
    /// while no client can authenticate, so the caller passes a per-user location as a
    /// fallback and this reports the case where even that fails.
    pub fn init_with_token_candidates(candidates: &[PathBuf]) -> Arc<Self> {
        let token = generate_token();
        let mut token_path = None;
        for candidate in candidates {
            if let Some(dir) = candidate.parent() {
                let _ = fs::create_dir_all(dir);
            }
            if fs::write(candidate, &token).is_ok() {
                token_path = Some(candidate.clone());
                break;
            }
        }
        if token_path.is_none() {
            eprintln!(
                "[ws_server] no writable location for {TOKEN_FILE_NAME}; clients cannot authenticate"
            );
        }
        Arc::new(Self {
            expected_token: token,
            token_path,
            bound_port: AtomicU16::new(DEFAULT_WS_PORT_RANGE.0),
            heartbeat_timeout_sec: AtomicU64::new(DEFAULT_HEARTBEAT_SEC),
            client_count: AtomicUsize::new(0),
            clients: Mutex::new(HashMap::new()),
        })
    }

    /// Where the token was written, so the same location can be cleaned up on exit.
    pub fn token_path(&self) -> Option<&Path> {
        self.token_path.as_deref()
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

/// Decides whether a handshake `Origin` header may open a bus connection.
///
/// The gate keeps web pages off the bus: a page served from an origin this host does
/// not own must not be able to open a socket. Comparing the raw string with
/// `starts_with` cannot express that, because `http://localhost.attacker.test` starts
/// with `http://localhost`; the authority has to be parsed and its host compared
/// exactly.
///
/// Whether a header is present at all is the caller's business. A caller that finds no
/// `Origin` header should allow the request: that is not a browser, and every
/// non-browser client still has to present the bus token.
fn origin_is_allowed(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        // Not visible ASCII, so not a value a browser produced.
        return false;
    };
    let origin = origin.trim();
    if origin.is_empty() {
        return true;
    }

    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };

    // The authority ends at the first path, query or fragment delimiter.
    let authority = match rest.find(['/', '?', '#']) {
        Some(end) => &rest[..end],
        None => rest,
    };

    // Browsers never put userinfo in `Origin`, but `http://localhost@evil.test` would
    // otherwise read as host `localhost`. Keep the part after the last `@`.
    let authority = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };

    // Strip an optional port. No entry in the allow-list is a bracketed IPv6 literal,
    // so a colon left in the authority can only separate a port, and a port is a run of
    // digits: `localhost:1420.attacker.test` names no host this host owns.
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    if !port.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }

    let scheme_is = |s: &str| scheme.eq_ignore_ascii_case(s);
    let host_is = |h: &str| host.eq_ignore_ascii_case(h);

    (scheme_is("http") && (host_is("localhost") || host_is("127.0.0.1")))
        || (scheme_is("tauri") && host_is("localhost"))
        || (scheme_is("https") && host_is("tauri.localhost"))
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
                    if !origin_is_allowed(origin) {
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
        let path = std::env::temp_dir().join(format!("ai-pets-{name}.token"));
        WsCommandBroker::init_with_token_candidates(&[path])
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
        let path = std::env::temp_dir().join("ai-pets-written.token");
        let broker = WsCommandBroker::init_with_token_candidates(std::slice::from_ref(&path));
        let on_disk = std::fs::read_to_string(&path).expect("token file");
        assert_eq!(on_disk.trim(), broker.expected_token);
        assert_eq!(broker.token_path(), Some(path.as_path()));
    }

    #[test]
    fn a_token_that_cannot_be_written_beside_the_working_directory_moves_on() {
        // `Program Files` is read-only for a standard user, and the working directory of
        // an installed build is exactly there. A candidate whose parent is a file stands
        // in for that here, because writing through it cannot succeed either.
        let dir = std::env::temp_dir();
        let blocker = dir.join("ai-pets-not-a-directory");
        std::fs::write(&blocker, b"file, not a directory").expect("blocker file");
        let unwritable = blocker.join(TOKEN_FILE_NAME);
        let fallback = dir.join("ai-pets-fallback.token");

        let broker = WsCommandBroker::init_with_token_candidates(&[unwritable, fallback.clone()]);

        assert_eq!(broker.token_path(), Some(fallback.as_path()));
        assert_eq!(
            std::fs::read_to_string(&fallback)
                .expect("fallback token file")
                .trim(),
            broker.expected_token
        );
    }

    #[test]
    fn no_writable_candidate_leaves_the_token_unplaced() {
        let dir = std::env::temp_dir();
        let blocker = dir.join("ai-pets-not-a-directory-either");
        std::fs::write(&blocker, b"file, not a directory").expect("blocker file");

        let broker = WsCommandBroker::init_with_token_candidates(&[blocker.join("token")]);

        assert_eq!(broker.token_path(), None);
    }

    fn header(value: &str) -> HeaderValue {
        HeaderValue::from_str(value).expect("valid header value")
    }

    #[test]
    fn the_declared_origins_are_allowed() {
        for value in [
            "http://localhost",
            "http://localhost:1420",
            "http://localhost:1420/",
            "tauri://localhost",
            "http://127.0.0.1:9527",
            "https://tauri.localhost",
            "HTTP://LOCALHOST:1420",
            "",
        ] {
            assert!(origin_is_allowed(&header(value)), "should allow {value:?}");
        }
    }

    #[test]
    fn a_host_that_merely_starts_with_an_allowed_one_is_rejected() {
        // Every one of these begins with an allowed origin as a raw string, which is
        // all the previous `starts_with` check looked at. An attacker who owns a
        // domain can serve a page from `localhost.<their-domain>` and have the browser
        // send exactly that Origin.
        for value in [
            "http://localhost.attacker.test",
            "http://localhost.attacker.test:1420",
            "https://tauri.localhost.attacker.test",
            "http://127.0.0.1.attacker.test",
            "http://localhost:1420.attacker.test",
        ] {
            assert!(
                !origin_is_allowed(&header(value)),
                "should reject {value:?}"
            );
        }
    }

    #[test]
    fn userinfo_cannot_masquerade_as_a_local_host() {
        // Reads as host `localhost` to anything that scans rather than parses.
        assert!(!origin_is_allowed(&header(
            "http://localhost@attacker.test"
        )));
    }

    #[test]
    fn origins_outside_the_declared_set_are_rejected() {
        for value in [
            "https://attacker.test",
            "http://example.com",
            "https://localhost", // Tauri serves http on localhost, never https
            "http://127.0.0.2",
            "null", // opaque origin, e.g. a sandboxed iframe
            "file://",
        ] {
            assert!(
                !origin_is_allowed(&header(value)),
                "should reject {value:?}"
            );
        }
    }

    #[test]
    fn a_header_that_is_not_visible_ascii_is_not_trusted() {
        let value = HeaderValue::from_bytes(&[0xff, 0xfe]).expect("opaque header value");
        assert!(!origin_is_allowed(&value));
    }
}
