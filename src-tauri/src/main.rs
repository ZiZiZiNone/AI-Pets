#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod action_executor;
mod win32_window;
mod ws_server;

use action_executor::{execute_general_pet_action, PetActionPayload};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use win32_window::{
    adapt_windows_to_monitor, apply_edge_peek_position, apply_no_activate_style,
    apply_window_click_through, snap_pet_window_to_foreground, start_cursor_and_window_poller,
    SnapWindowResult,
};
use ws_server::{
    start_ws_server, WsCommandBroker, DEFAULT_HEARTBEAT_SEC, DEFAULT_WS_PORT_RANGE,
    MIN_HEARTBEAT_SEC,
};

static LAST_INTERNAL_WRITE: Mutex<Option<Instant>> = Mutex::new(None);

fn mark_internal_write() {
    if let Ok(mut guard) = LAST_INTERNAL_WRITE.lock() {
        *guard = Some(Instant::now());
    }
}

fn is_recent_internal_write() -> bool {
    LAST_INTERNAL_WRITE
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|ts| ts.elapsed() < Duration::from_millis(800))
        .unwrap_or(false)
}

fn validate_safe_pet_id(pet_id: &str) -> Result<(), String> {
    if pet_id.is_empty()
        || pet_id.len() > 64
        || !pet_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Invalid pet_id".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalPetState {
    pub revision: u64,
    pub active_pet_id: String,
    pub emotion: String,
    pub is_click_through: bool,
    pub volume: f32,
    pub studio_mode: bool,
    pub inline_hud: bool,
    pub dnd_mode: bool,
}

impl Default for CanonicalPetState {
    fn default() -> Self {
        Self {
            revision: 1,
            active_pet_id: "aether_mecha_core".to_string(),
            emotion: "idle".to_string(),
            is_click_through: false,
            volume: 0.85,
            studio_mode: false,
            inline_hud: true,
            dnd_mode: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetManifestEntry {
    pub id: String,
    pub yaml: String,
    pub base_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConfigBundle {
    pub settings_yaml: Option<String>,
    pub global_menu_yaml: Option<String>,
    pub pets: Vec<PetManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemTelemetry {
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_cores: usize,
    pub memory_usage_mb: u64,
    pub uptime_sec: u64,
    pub ws_port: u16,
    pub connected_clients: usize,
}

pub struct HostRuntimeMeta {
    pub started_at: Instant,
    pub broker: Arc<WsCommandBroker>,
}

fn resolve_project_dir(sub: &str) -> PathBuf {
    let candidates = [
        PathBuf::from(sub),
        PathBuf::from("..").join(sub),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(sub)))
            .unwrap_or_else(|| PathBuf::from(sub)),
    ];
    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    PathBuf::from(sub)
}

fn parse_ws_config_from_settings() -> ((u16, u16), u64) {
    let mut port_start = DEFAULT_WS_PORT_RANGE.0;
    let mut port_end = DEFAULT_WS_PORT_RANGE.1;
    let mut hb_sec = DEFAULT_HEARTBEAT_SEC;

    let settings_path = resolve_project_dir("config").join("settings.yaml");
    let raw = match fs::read_to_string(settings_path) {
        Ok(s) => s,
        Err(_) => return ((port_start, port_end), hb_sec),
    };

    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("ws_port_range:") {
            let nums: Vec<u16> = rest
                .trim_matches(|c: char| !c.is_ascii_digit())
                .split(|c: char| !c.is_ascii_digit())
                .filter_map(|t| t.parse::<u16>().ok())
                .collect();
            if nums.len() >= 2 {
                port_start = nums[0];
                port_end = nums[1];
            }
        } else if let Some(rest) = trimmed.strip_prefix("heartbeat_timeout_sec:") {
            if let Ok(val) = rest.trim().parse::<u64>() {
                hb_sec = val.max(MIN_HEARTBEAT_SEC);
            }
        }
    }

    ((port_start, port_end), hb_sec)
}

fn query_process_memory_mb() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(status) = fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    let kb: u64 = rest
                        .split_whitespace()
                        .next()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    if kb > 0 {
                        return (kb / 1024).max(1);
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let pid = std::process::id().to_string();
        if let Ok(out) = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &pid])
            .output()
        {
            let kb: u64 = String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse()
                .unwrap_or(0);
            if kb > 0 {
                return (kb / 1024).max(1);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let pid = std::process::id();
        if let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
            .output()
        {
            let line = String::from_utf8_lossy(&out.stdout);
            if let Some(last_col) = line.split(',').last() {
                let digits: String = last_col.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(kb) = digits.parse::<u64>() {
                    if kb > 0 {
                        return (kb / 1024).max(1);
                    }
                }
            }
        }
    }

    42
}

#[tauri::command]
fn get_canonical_state(state: State<'_, Mutex<CanonicalPetState>>) -> CanonicalPetState {
    state.lock().unwrap().clone()
}

#[tauri::command]
fn mutate_canonical_state(
    app: AppHandle,
    state: State<'_, Mutex<CanonicalPetState>>,
    patch: serde_json::Value,
) -> CanonicalPetState {
    let mut s = state.lock().unwrap();
    if let Some(v) = patch.get("active_pet_id").and_then(|v| v.as_str()) {
        s.active_pet_id = v.to_string();
    }
    if let Some(v) = patch.get("emotion").and_then(|v| v.as_str()) {
        s.emotion = v.to_string();
    }
    if let Some(v) = patch.get("is_click_through").and_then(|v| v.as_bool()) {
        s.is_click_through = v;
        if let Some(main_win) = app.get_webview_window("main") {
            let _ = apply_window_click_through(&main_win, v);
        }
    }
    if let Some(v) = patch.get("volume").and_then(|v| v.as_f64()) {
        s.volume = v as f32;
    }
    if let Some(v) = patch.get("studio_mode").and_then(|v| v.as_bool()) {
        s.studio_mode = v;
    }
    if let Some(v) = patch.get("inline_hud").and_then(|v| v.as_bool()) {
        s.inline_hud = v;
    }
    if let Some(v) = patch.get("dnd_mode").and_then(|v| v.as_bool()) {
        s.dnd_mode = v;
    }
    s.revision += 1;
    let snapshot = s.clone();
    let _ = app.emit("pet-state:sync", &snapshot);
    snapshot
}

#[tauri::command]
fn set_stage_click_through(app: AppHandle, ignore: bool) -> Result<(), String> {
    if let Some(main_win) = app.get_webview_window("main") {
        apply_window_click_through(&main_win, ignore)
    } else {
        Err("Main window not found".into())
    }
}

#[tauri::command]
fn set_companion_focusable(app: AppHandle, focusable: bool) -> Result<(), String> {
    if let Some(comp_win) = app.get_webview_window("companion") {
        apply_no_activate_style(&comp_win, !focusable);
        if focusable {
            let _ = comp_win.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
fn open_companion_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("companion") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "companion", WebviewUrl::App("companion.html".into()))
        .title("DesktopPetHost Companion")
        .inner_size(380.0, 520.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_host_configs() -> HostConfigBundle {
    let config_dir = resolve_project_dir("config");
    let pets_dir = resolve_project_dir("pets");

    let settings_yaml = fs::read_to_string(config_dir.join("settings.yaml")).ok();
    let global_menu_yaml = fs::read_to_string(config_dir.join("global_menu.yaml")).ok();

    let mut pets = Vec::new();
    if let Ok(entries) = fs::read_dir(&pets_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let yaml_path = path.join("pet.yaml");
                if let Ok(yaml_text) = fs::read_to_string(&yaml_path) {
                    let id = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let abs_base = fs::canonicalize(&path)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string();
                    pets.push(PetManifestEntry {
                        id,
                        yaml: yaml_text,
                        base_path: abs_base,
                    });
                }
            }
        }
    }

    pets.sort_by(|a, b| {
        let rank = |id: &str| match id {
            "aether_mecha_core" => 0,
            "nyx_abyssal_familiar" => 1,
            "pulse_glitch_phantom" => 2,
            "demo_sprite_pet" => 3,
            _ => 4,
        };
        rank(&a.id).cmp(&rank(&b.id)).then_with(|| a.id.cmp(&b.id))
    });

    HostConfigBundle {
        settings_yaml,
        global_menu_yaml,
        pets,
    }
}

#[tauri::command]
fn save_pet_manifest(pet_id: String, yaml_content: String) -> Result<(), String> {
    validate_safe_pet_id(&pet_id)?;
    mark_internal_write();
    let target_dir = resolve_project_dir("pets").join(&pet_id);
    if !target_dir.exists() {
        fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    }
    fs::write(target_dir.join("pet.yaml"), yaml_content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_host_settings(yaml_content: String) -> Result<(), String> {
    mark_internal_write();
    let config_dir = resolve_project_dir("config");
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    }
    fs::write(config_dir.join("settings.yaml"), yaml_content).map_err(|e| e.to_string())
}

#[tauri::command]
fn execute_pet_action(
    action: PetActionPayload,
    extra_args: Option<Vec<String>>,
) -> Result<String, String> {
    execute_general_pet_action(&action, extra_args)
}

#[tauri::command]
async fn ws_send_event(
    meta: State<'_, HostRuntimeMeta>,
    app_id: String,
    method: String,
    params: serde_json::Value,
) -> Result<(), String> {
    meta.broker.broadcast_event(&app_id, &method, params).await;
    Ok(())
}

#[tauri::command]
fn snap_pet_to_foreground_window(app: AppHandle, only_if_near_top: bool) -> SnapWindowResult {
    if let Some(main_win) = app.get_webview_window("main") {
        snap_pet_window_to_foreground(&main_win, only_if_near_top)
    } else {
        SnapWindowResult {
            snapped: false,
            target_title: None,
            x: None,
            y: None,
        }
    }
}

#[tauri::command]
fn set_edge_peek_mode(app: AppHandle, enable: bool) -> Result<(), String> {
    if let Some(main_win) = app.get_webview_window("main") {
        apply_edge_peek_position(&main_win, enable)
    } else {
        Err("Main window not found".into())
    }
}

#[tauri::command]
fn get_system_telemetry(meta: State<'_, HostRuntimeMeta>) -> SystemTelemetry {
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    SystemTelemetry {
        os_name: std::env::consts::OS.to_uppercase(),
        os_version: std::env::consts::FAMILY.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_cores,
        memory_usage_mb: query_process_memory_mb(),
        uptime_sec: meta.started_at.elapsed().as_secs(),
        ws_port: meta.broker.bound_port.load(Ordering::Relaxed),
        connected_clients: meta.broker.client_count.load(Ordering::Relaxed),
    }
}

fn setup_config_hot_reload_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(_) => return,
        };

        for dir in [resolve_project_dir("config"), resolve_project_dir("pets")] {
            if Path::new(&dir).exists() {
                let _ = watcher.watch(Path::new(&dir), RecursiveMode::Recursive);
            }
        }

        let mut last_emit = Instant::now() - Duration::from_secs(1);
        for res in rx {
            if res.is_ok()
                && !is_recent_internal_write()
                && last_emit.elapsed() >= Duration::from_millis(300)
            {
                last_emit = Instant::now();
                let _ = app.emit("config-hot-reload", ());
            }
        }
    });
}

fn setup_system_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_pet = MenuItem::with_id(
        app,
        "tray_show_pet",
        "💠 召唤/归位桌面宠物",
        true,
        None::<&str>,
    )?;
    let open_comp = MenuItem::with_id(
        app,
        "tray_open_companion",
        "🎛️ 打开空间伴生控制中心",
        true,
        None::<&str>,
    )?;
    let toggle_ct = MenuItem::with_id(
        app,
        "tray_toggle_click_through",
        "👻 切换全局鼠标穿透",
        true,
        None::<&str>,
    )?;
    let toggle_dnd = MenuItem::with_id(
        app,
        "tray_toggle_dnd",
        "🔕 切换勿扰隐匿模式",
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(
        app,
        "tray_quit",
        "✕ 退出 DesktopPetHost",
        true,
        None::<&str>,
    )?;

    let menu = Menu::with_items(
        app,
        &[&show_pet, &open_comp, &toggle_ct, &toggle_dnd, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("DesktopPetHost — 全息微内核桌面伴侣")
        .on_menu_event(|app_handle, event| match event.id.as_ref() {
            "tray_show_pet" => {
                let state = app_handle.state::<Mutex<CanonicalPetState>>();
                let mut s = state.lock().unwrap();
                s.is_click_through = false;
                s.revision += 1;
                if let Some(main_win) = app_handle.get_webview_window("main") {
                    let _ = main_win.show();
                    let _ = main_win.center();
                    let _ = apply_window_click_through(&main_win, false);
                }
                let _ = app_handle.emit("pet-state:sync", &*s);
            }
            "tray_open_companion" => {
                let _ = open_companion_window(app_handle.clone());
            }
            "tray_toggle_click_through" => {
                let state = app_handle.state::<Mutex<CanonicalPetState>>();
                let mut s = state.lock().unwrap();
                s.is_click_through = !s.is_click_through;
                s.revision += 1;
                if let Some(main_win) = app_handle.get_webview_window("main") {
                    let _ = apply_window_click_through(&main_win, s.is_click_through);
                }
                let _ = app_handle.emit("pet-state:sync", &*s);
            }
            "tray_toggle_dnd" => {
                let state = app_handle.state::<Mutex<CanonicalPetState>>();
                let mut s = state.lock().unwrap();
                s.dnd_mode = !s.dnd_mode;
                s.revision += 1;
                let _ = app_handle.emit("pet-state:sync", &*s);
            }
            "tray_quit" => {
                let _ = fs::remove_file(".pet_ws_token");
                app_handle.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let _ = builder.build(app);
    Ok(())
}

fn main() {
    let token_file = PathBuf::from(".pet_ws_token");
    let (port_range, hb_timeout_sec) = parse_ws_config_from_settings();
    let broker = WsCommandBroker::init_with_token_file(token_file);
    broker
        .heartbeat_timeout_sec
        .store(hb_timeout_sec, Ordering::Relaxed);
    let broker_for_setup = broker.clone();

    tauri::Builder::default()
        .manage(Mutex::new(CanonicalPetState::default()))
        .manage(HostRuntimeMeta {
            started_at: Instant::now(),
            broker,
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            adapt_windows_to_monitor(app);
            let _ = setup_system_tray(app);
            start_cursor_and_window_poller(handle.clone());
            setup_config_hot_reload_watcher(handle.clone());

            tauri::async_runtime::spawn(async move {
                start_ws_server(handle, port_range, broker_for_setup).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_canonical_state,
            mutate_canonical_state,
            set_stage_click_through,
            set_companion_focusable,
            open_companion_window,
            load_host_configs,
            save_pet_manifest,
            save_host_settings,
            execute_pet_action,
            ws_send_event,
            snap_pet_to_foreground_window,
            set_edge_peek_mode,
            get_system_telemetry
        ])
        .run(tauri::generate_context!())
        .expect("error while running DesktopPetHost application");
}
