use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    App, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow,
};

static PRE_PEEK_POSITION: Mutex<Option<(i32, i32)>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CursorScreenPoint {
    pub x: f64,
    pub y: f64,
    pub in_window_bounds: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopWindowState {
    pub has_foreground_window: bool,
    pub is_fullscreen: bool,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub screen_width: i32,
    pub screen_height: i32,
}

impl Default for DesktopWindowState {
    fn default() -> Self {
        Self {
            has_foreground_window: false,
            is_fullscreen: false,
            title: String::new(),
            x: 200,
            y: 140,
            width: 1280,
            height: 800,
            screen_width: 1920,
            screen_height: 1080,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapWindowResult {
    pub snapped: bool,
    pub target_title: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

pub fn apply_window_click_through(
    window: &WebviewWindow,
    ignore_cursor: bool,
) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore_cursor)
        .map_err(|e| format!("Failed to set ignore_cursor_events: {}", e))
}

pub fn apply_no_activate_style(window: &WebviewWindow, no_activate: bool) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        };
        if let Ok(raw_hwnd) = window.hwnd() {
            let hwnd = HWND(raw_hwnd.0);
            unsafe {
                let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let next = if no_activate {
                    current | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize)
                } else {
                    current & !(WS_EX_NOACTIVATE.0 as isize)
                };
                let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, no_activate);
    }
}

pub fn adapt_windows_to_monitor(app: &App) {
    if let Some(main_win) = app.get_webview_window("main") {
        apply_no_activate_style(&main_win, true);

        if let Ok(Some(monitor)) = main_win
            .current_monitor()
            .or_else(|_| main_win.primary_monitor())
        {
            let mon_size = monitor.size();
            let mon_pos = monitor.position();
            let scale = monitor.scale_factor();

            let win_w = (360.0 * scale) as i32;
            let win_h = (420.0 * scale) as i32;
            let margin_x = (48.0 * scale) as i32;
            let margin_y = (72.0 * scale) as i32;

            let safe_x = (mon_pos.x + mon_size.width as i32 - win_w - margin_x).max(mon_pos.x + 20);
            let safe_y =
                (mon_pos.y + mon_size.height as i32 - win_h - margin_y).max(mon_pos.y + 20);
            let _ = main_win.set_position(Position::Physical(PhysicalPosition::new(safe_x, safe_y)));

            if let Some(hud_win) = app.get_webview_window("hud") {
                let _ = hud_win.set_position(Position::Physical(*mon_pos));
                let _ = hud_win.set_size(Size::Physical(PhysicalSize::new(
                    mon_size.width,
                    mon_size.height,
                )));
            }
        }
    }

    if let Some(hud_win) = app.get_webview_window("hud") {
        let _ = apply_window_click_through(&hud_win, true);
        apply_no_activate_style(&hud_win, true);
    }
}

pub fn check_cursor_in_window_bounds(
    window: &WebviewWindow,
    cursor_x: f64,
    cursor_y: f64,
) -> CursorScreenPoint {
    let pos = window.outer_position().unwrap_or_default();
    let size = window.outer_size().unwrap_or_default();
    let scale = window.scale_factor().unwrap_or(1.0);

    let win_x = pos.x as f64;
    let win_y = pos.y as f64;
    let win_w = size.width as f64;
    let win_h = size.height as f64;

    let inside = cursor_x >= win_x
        && cursor_x <= (win_x + win_w)
        && cursor_y >= win_y
        && cursor_y <= (win_y + win_h);

    let local_css_x = (cursor_x - win_x) / scale;
    let local_css_y = (cursor_y - win_y) / scale;

    CursorScreenPoint {
        x: local_css_x,
        y: local_css_y,
        in_window_bounds: inside,
    }
}

#[cfg(target_os = "windows")]
pub fn query_os_cursor_pos() -> Option<(f64, f64)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt).is_ok() {
            return Some((pt.x as f64, pt.y as f64));
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
pub fn query_os_cursor_pos() -> Option<(f64, f64)> {
    None
}

#[cfg(target_os = "windows")]
pub fn query_foreground_window_state() -> DesktopWindowState {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextW, SM_CXSCREEN,
        SM_CYSCREEN,
    };

    unsafe {
        let screen_w = GetSystemMetrics(SM_CXSCREEN).max(1280);
        let screen_h = GetSystemMetrics(SM_CYSCREEN).max(720);
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return DesktopWindowState {
                screen_width: screen_w,
                screen_height: screen_h,
                ..Default::default()
            };
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return DesktopWindowState {
                screen_width: screen_w,
                screen_height: screen_h,
                ..Default::default()
            };
        }

        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut buf);
        let title = if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::from("Active Window")
        };

        let width = (rect.right - rect.left).max(0);
        let height = (rect.bottom - rect.top).max(0);
        let is_fullscreen =
            rect.left <= 0 && rect.top <= 0 && width >= screen_w && height >= screen_h;

        DesktopWindowState {
            has_foreground_window: !title.contains("DesktopPetHost"),
            is_fullscreen: is_fullscreen && !title.contains("DesktopPetHost"),
            title,
            x: rect.left,
            y: rect.top,
            width,
            height,
            screen_width: screen_w,
            screen_height: screen_h,
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn query_foreground_window_state() -> DesktopWindowState {
    DesktopWindowState {
        has_foreground_window: true,
        is_fullscreen: false,
        title: "Workspace Active Window".to_string(),
        x: 240,
        y: 160,
        width: 1200,
        height: 760,
        screen_width: 1920,
        screen_height: 1080,
    }
}

pub fn snap_pet_window_to_foreground(
    main_win: &WebviewWindow,
    only_if_near_top: bool,
) -> SnapWindowResult {
    let fg = query_foreground_window_state();
    if !fg.has_foreground_window || fg.is_fullscreen {
        return SnapWindowResult {
            snapped: false,
            target_title: None,
            x: None,
            y: None,
        };
    }

    let pet_pos = main_win.outer_position().unwrap_or_default();
    let pet_size = main_win.outer_size().unwrap_or_default();
    let scale = main_win.scale_factor().unwrap_or(1.0);
    let pet_w = (pet_size.width as i32).max((360.0 * scale) as i32);
    let pet_h = (pet_size.height as i32).max((320.0 * scale) as i32);
    let grip_overlap = (75.0 * scale) as i32;

    let target_y = (fg.y - pet_h + grip_overlap).max(0);
    let target_x = if only_if_near_top {
        pet_pos.x.clamp(fg.x, (fg.x + fg.width - pet_w).max(fg.x))
    } else {
        fg.x + (fg.width - pet_w).max(40) / 2
    };

    if only_if_near_top {
        let snap_threshold = (95.0 * scale) as i32;
        let vertical_diff = (pet_pos.y - target_y).abs();
        let horizontal_inside =
            pet_pos.x + pet_w / 2 >= fg.x && pet_pos.x <= fg.x + fg.width;
        if vertical_diff > snap_threshold || !horizontal_inside {
            return SnapWindowResult {
                snapped: false,
                target_title: None,
                x: None,
                y: None,
            };
        }
    }

    let _ = main_win.set_position(Position::Physical(PhysicalPosition::new(
        target_x, target_y,
    )));

    SnapWindowResult {
        snapped: true,
        target_title: Some(if fg.title.is_empty() {
            "活动窗口".to_string()
        } else {
            fg.title
        }),
        x: Some(target_x),
        y: Some(target_y),
    }
}

pub fn apply_edge_peek_position(main_win: &WebviewWindow, enable: bool) -> Result<(), String> {
    let fg = query_foreground_window_state();
    let pos = main_win.outer_position().unwrap_or_default();
    let scale = main_win.scale_factor().unwrap_or(1.0);

    let (target_x, target_y) = if enable {
        if let Ok(mut saved) = PRE_PEEK_POSITION.lock() {
            *saved = Some((pos.x, pos.y));
        }
        let peek_offset = (130.0 * scale) as i32;
        ((fg.screen_width - peek_offset).max(400), pos.y.max(120))
    } else {
        let restored = PRE_PEEK_POSITION
            .lock()
            .ok()
            .and_then(|mut s| s.take());
        match restored {
            Some((rx, ry)) => (rx, ry),
            None => {
                let normal_offset = (420.0 * scale) as i32;
                ((fg.screen_width - normal_offset).max(200), pos.y.max(120))
            }
        }
    };

    main_win
        .set_position(Position::Physical(PhysicalPosition::new(target_x, target_y)))
        .map_err(|e| e.to_string())
}

pub fn start_cursor_and_window_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick_count: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(33)).await;
            tick_count += 1;

            if let Some((cx, cy)) = query_os_cursor_pos() {
                if let Some(main_win) = app.get_webview_window("main") {
                    let pt = check_cursor_in_window_bounds(&main_win, cx, cy);
                    if pt.in_window_bounds || tick_count % 5 == 0 {
                        let _ = app.emit("cursor-in-window", &pt);
                    }
                }
            }

            if tick_count % 45 == 0 {
                let win_state = query_foreground_window_state();
                let _ = app.emit("desktop-window-state", &win_state);
            }
        }
    });
}
