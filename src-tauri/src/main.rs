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
use tauri::{AppHandle, Emitter, Manager, State};
use win32_window::{
    adapt_windows_to_monitor, apply_edge_peek_position, apply_no_activate_style,
    apply_window_click_through, snap_pet_window_to_foreground, start_cursor_and_window_poller,
    SnapWindowResult,
};
use ws_server::{
    start_ws_server, WsCommandBroker, DEFAULT_HEARTBEAT_SEC, DEFAULT_WS_PORT_RANGE,
    MIN_HEARTBEAT_SEC, TOKEN_FILE_NAME,
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
    pub memory_usage_mb: Option<u64>,
    pub uptime_sec: u64,
    pub ws_port: u16,
    pub connected_clients: usize,
}

pub struct HostRuntimeMeta {
    pub started_at: Instant,
    pub broker: Arc<WsCommandBroker>,
}

/// Locations a project directory may live in, nearest first.
///
/// The list exists because the same tree is reached from four different arrangements: a
/// development run with the repository as the working directory, a run from `src-tauri`,
/// a portable build beside its files, and an installed build.
fn project_dir_candidates(sub: &str, exe_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from(sub), PathBuf::from("..").join(sub)];
    if let Some(dir) = exe_dir {
        candidates.push(dir.join(sub));
        // A resource declared in `tauri.conf.json` as `../<name>` is unpacked under
        // `_up_/<name>`, which is how a parent-directory component is encoded
        // (`tauri-utils`, `resources::resource_relpath`). That is the only location a
        // bundled `config/` or `pets/` has in an installed build, so without this
        // candidate the packaged settings would never be read.
        candidates.push(dir.join("_up_").join(sub));
    }
    candidates
}

fn resolve_project_dir(sub: &str) -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    project_dir_candidates(sub, exe_dir.as_deref())
        .into_iter()
        .find(|candidate| candidate.exists())
        .unwrap_or_else(|| PathBuf::from(sub))
}

/// Where the bus token may be written, in order of preference.
///
/// The working directory comes first so a development or portable run keeps the
/// `.pet_ws_token` file clients already look for. That directory is not always
/// writable: a per-machine install runs from `Program Files`, where a standard user
/// cannot create files, and a token that is never written leaves the bus looking
/// healthy while no client can authenticate. The app data directory is per-user and
/// always writable, so it is the fallback that keeps the bus reachable.
fn token_path_candidates(app: &tauri::App) -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from(TOKEN_FILE_NAME)];
    if let Ok(dir) = app.path().app_data_dir() {
        candidates.push(dir.join(TOKEN_FILE_NAME));
    }
    candidates
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

/// Returns the `index`-th comma-separated field of `line`, honouring double quotes.
///
/// `tasklist /FO CSV` quotes any field containing a comma, so the memory column arrives
/// as `"60,776 K"`. Splitting on `,` alone truncates that to `776 K` and reports the
/// process as using 1 MB instead of 59 MB.
fn csv_field(line: &str, index: usize) -> Option<String> {
    let mut current = String::new();
    let mut seen = 0usize;
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                if seen == index {
                    return Some(current);
                }
                seen += 1;
                current.clear();
            }
            _ => current.push(c),
        }
    }

    (seen == index).then_some(current)
}

/// Reads the memory column out of `tasklist /NH` output.
///
/// Returns `None` rather than a placeholder so the UI can say "unknown" instead of
/// showing a fabricated reading.
fn parse_tasklist_memory_mb(csv: &str) -> Option<u64> {
    let line = csv.lines().find(|l| !l.trim().is_empty())?;
    let kb: u64 = csv_field(line, 4)?
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()?;
    (kb > 0).then(|| (kb / 1024).max(1))
}

/// Resident memory of this process, or `None` when the platform query is unavailable.
fn query_process_memory_mb() -> Option<u64> {
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
                        return Some((kb / 1024).max(1));
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
                return Some((kb / 1024).max(1));
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
            if let Some(mb) = parse_tasklist_memory_mb(&String::from_utf8_lossy(&out.stdout)) {
                return Some(mb);
            }
        }
    }

    None
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
    // The lock is released before anything reaches the window layer. `emit` and the
    // Win32 calls go through the event loop, and the tray handlers below run on that
    // same loop and take this lock, so holding it across them couples the two waits.
    // Snapshots carry a revision and readers drop anything not newer, so an emit that
    // leaves the lock slightly later than the mutation it describes is still correct.
    let mut click_through = None;
    let snapshot = {
        let mut s = state.lock().unwrap();
        if let Some(v) = patch.get("active_pet_id").and_then(|v| v.as_str()) {
            s.active_pet_id = v.to_string();
        }
        if let Some(v) = patch.get("emotion").and_then(|v| v.as_str()) {
            s.emotion = v.to_string();
        }
        if let Some(v) = patch.get("is_click_through").and_then(|v| v.as_bool()) {
            s.is_click_through = v;
            click_through = Some(v);
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
        s.clone()
    };

    if let Some(ignore) = click_through {
        if let Some(main_win) = app.get_webview_window("main") {
            let _ = apply_window_click_through(&main_win, ignore);
        }
    }
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
    // The window is declared in `tauri.conf.json` and is never destroyed, because the
    // window-event handler turns close requests into hides. Looking it up is the whole
    // job here; a second definition of its geometry in this file would only be a place
    // for the two to drift apart.
    let companion = app
        .get_webview_window("companion")
        .ok_or_else(|| "Companion window is not available".to_string())?;
    let _ = companion.show();
    let _ = companion.set_focus();
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
    let quit_item = MenuItem::with_id(app, "tray_quit", "✕ 退出 AI-Pets", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show_pet, &open_comp, &toggle_ct, &toggle_dnd, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("AI-Pets — 全息微内核桌面伴侣")
        .on_menu_event(|app_handle, event| match event.id.as_ref() {
            "tray_show_pet" => {
                let state = app_handle.state::<Mutex<CanonicalPetState>>();
                let snapshot = {
                    let mut s = state.lock().unwrap();
                    s.is_click_through = false;
                    s.revision += 1;
                    s.clone()
                };
                if let Some(main_win) = app_handle.get_webview_window("main") {
                    let _ = main_win.show();
                    let _ = main_win.center();
                    let _ = apply_window_click_through(&main_win, false);
                }
                let _ = app_handle.emit("pet-state:sync", &snapshot);
            }
            "tray_open_companion" => {
                let _ = open_companion_window(app_handle.clone());
            }
            "tray_toggle_click_through" => {
                let state = app_handle.state::<Mutex<CanonicalPetState>>();
                let (snapshot, ignore) = {
                    let mut s = state.lock().unwrap();
                    s.is_click_through = !s.is_click_through;
                    s.revision += 1;
                    (s.clone(), s.is_click_through)
                };
                if let Some(main_win) = app_handle.get_webview_window("main") {
                    let _ = apply_window_click_through(&main_win, ignore);
                }
                let _ = app_handle.emit("pet-state:sync", &snapshot);
            }
            "tray_toggle_dnd" => {
                let state = app_handle.state::<Mutex<CanonicalPetState>>();
                let snapshot = {
                    let mut s = state.lock().unwrap();
                    s.dnd_mode = !s.dnd_mode;
                    s.revision += 1;
                    s.clone()
                };
                let _ = app_handle.emit("pet-state:sync", &snapshot);
            }
            "tray_quit" => {
                // Remove the token from wherever it was actually written, which is not
                // necessarily the working directory.
                let meta = app_handle.state::<HostRuntimeMeta>();
                if let Some(path) = meta.broker.token_path() {
                    let _ = fs::remove_file(path);
                }
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
    let (port_range, hb_timeout_sec) = parse_ws_config_from_settings();

    tauri::Builder::default()
        .manage(Mutex::new(CanonicalPetState::default()))
        .on_window_event(|window, event| {
            // Every window here is a surface that is shown and hidden: `panel.open`,
            // `hud.draw`, the tray items and the in-app close controls all look the
            // window up by label and then call `show()` or `hide()`. A destroyed window
            // can never be found again, so one stray close request would leave the pet
            // or a panel unreachable for the rest of the session. Leaving the app is the
            // tray's quit item, which calls `AppHandle::exit` and not this event.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let broker = WsCommandBroker::init_with_token_candidates(&token_path_candidates(app));
            broker
                .heartbeat_timeout_sec
                .store(hb_timeout_sec, Ordering::Relaxed);
            let broker_for_setup = broker.clone();
            app.manage(HostRuntimeMeta {
                started_at: Instant::now(),
                broker,
            });

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
        .expect("error while running AI-Pets application");
}

#[cfg(test)]
mod tests {
    use super::{csv_field, parse_tasklist_memory_mb, project_dir_candidates};
    use std::path::{Path, PathBuf};

    const REAL: &str = "\"powershell.exe\",\"24924\",\"Console\",\"1\",\"60,776 K\"\r\n";

    #[test]
    fn candidate_locations_are_tried_in_the_documented_order() {
        let candidates = project_dir_candidates("config", Some(Path::new("/opt/app")));
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("config"),               // beside the working directory
                PathBuf::from("../config"),            // one level up, as a dev run has it
                PathBuf::from("/opt/app/config"),      // beside the executable
                PathBuf::from("/opt/app/_up_/config")  // unpacked `../config` resource
            ]
        );
    }

    #[test]
    fn a_bundled_resource_is_looked_for_under_the_up_prefix() {
        // Regression: the installed build keeps `../config/**` and `../pets/**` under
        // `_up_/`, and the resource-less candidates alone never reach them, so the
        // packaged settings stayed inert.
        for sub in ["config", "pets"] {
            let candidates = project_dir_candidates(sub, Some(Path::new("/opt/app")));
            assert!(
                candidates.contains(&PathBuf::from(format!("/opt/app/_up_/{sub}"))),
                "{sub} must be looked for where the bundler puts it"
            );
        }
    }

    #[test]
    fn without_an_executable_directory_only_relative_locations_remain() {
        assert_eq!(
            project_dir_candidates("config", None),
            vec![PathBuf::from("config"), PathBuf::from("../config")]
        );
    }

    #[test]
    fn quoted_field_containing_a_comma_stays_intact() {
        // Splitting on `,` alone yields "776 K" here, which reads as 776 KB.
        assert_eq!(csv_field(REAL.trim(), 4).as_deref(), Some("60,776 K"));
        assert_eq!(csv_field(REAL.trim(), 0).as_deref(), Some("powershell.exe"));
        assert_eq!(csv_field(REAL.trim(), 1).as_deref(), Some("24924"));
    }

    #[test]
    fn escaped_quotes_are_treated_as_one() {
        let line = "\"a\"\"b\",\"2\",\"3\",\"4\",\"5 K\"";
        assert_eq!(csv_field(line, 0).as_deref(), Some("a\"b"));
    }

    #[test]
    fn missing_field_returns_none() {
        assert_eq!(csv_field("\"a\",\"b\"", 7), None);
    }

    #[test]
    fn memory_is_read_from_the_real_tasklist_format() {
        // 60,776 K is 59 MB; the old parser reported 1 MB.
        assert_eq!(parse_tasklist_memory_mb(REAL), Some(59));
    }

    #[test]
    fn memory_handles_values_without_a_thousands_separator() {
        assert_eq!(
            parse_tasklist_memory_mb("\"a.exe\",\"1\",\"C\",\"1\",\"912 K\"\r\n"),
            Some(1)
        );
    }

    #[test]
    fn sub_megabyte_readings_round_up_to_one() {
        assert_eq!(
            parse_tasklist_memory_mb("\"a.exe\",\"1\",\"C\",\"1\",\"4 K\"\r\n"),
            Some(1)
        );
    }

    #[test]
    fn unparsable_output_yields_none_rather_than_a_placeholder() {
        // The previous fallback invented "42", which the UI rendered as a real reading.
        assert_eq!(parse_tasklist_memory_mb(""), None);
        assert_eq!(parse_tasklist_memory_mb("\r\n\r\n"), None);
        assert_eq!(parse_tasklist_memory_mb("INFO: No tasks are running"), None);
        assert_eq!(
            parse_tasklist_memory_mb("\"a.exe\",\"1\",\"C\",\"1\",\"0 K\"\r\n"),
            None
        );
        assert_eq!(
            parse_tasklist_memory_mb("\"a.exe\",\"1\",\"C\",\"1\"\r\n"),
            None
        );
    }

    #[test]
    fn a_very_large_reading_is_not_truncated() {
        // 12,345,678 K must not be split into "345" like the old parser did.
        assert_eq!(
            parse_tasklist_memory_mb("\"a.exe\",\"1\",\"C\",\"1\",\"12,345,678 K\"\r\n"),
            Some(12056)
        );
    }
}
