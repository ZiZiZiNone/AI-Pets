use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(tag = "action_id", content = "params", rename_all = "snake_case")]
pub enum SafeActionCommand {
    OpenCompanion,
    ToggleStudio,
    SwitchEmotion { emotion: String },
    SwitchPet { pet_id: String },
    OpenOfficialDocs,
    TriggerGreeting,
    StartPomodoro { minutes: Option<u32> },
    TriggerScan,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PetActionPayload {
    #[serde(rename = "type")]
    pub action_type: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub target: Option<String>,
    pub url: Option<String>,
}

pub fn execute_whitelisted_action(cmd: &SafeActionCommand) -> Result<String, String> {
    match cmd {
        SafeActionCommand::OpenCompanion => Ok("action:open_companion".into()),
        SafeActionCommand::ToggleStudio => Ok("action:toggle_studio".into()),
        SafeActionCommand::SwitchEmotion { emotion } => {
            let allowed = [
                "idle", "happy", "angry", "glitch", "speaking", "sleep", "smile", "surprised",
                "sleepy", "neutral",
            ];
            if allowed.contains(&emotion.as_str()) {
                Ok(format!("emotion:{}", emotion))
            } else {
                Err(format!("Disallowed emotion identifier: {}", emotion))
            }
        }
        SafeActionCommand::SwitchPet { pet_id } => {
            let allowed_pets = [
                "aether_mecha_core",
                "demo_sprite_pet",
                "nyx_abyssal_familiar",
                "pulse_glitch_phantom",
            ];
            if allowed_pets.contains(&pet_id.as_str()) {
                Ok(format!("pet:{}", pet_id))
            } else {
                Err(format!("Unknown pet_id: {}", pet_id))
            }
        }
        SafeActionCommand::OpenOfficialDocs => {
            open_target_in_os("https://v2.tauri.app")?;
            Ok("action:docs_opened".into())
        }
        SafeActionCommand::TriggerGreeting => Ok("action:greeting".into()),
        SafeActionCommand::StartPomodoro { minutes } => {
            Ok(format!("action:pomodoro:{}", minutes.unwrap_or(25)))
        }
        SafeActionCommand::TriggerScan => Ok("action:scan".into()),
    }
}

pub fn open_target_in_os(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    Command::new("cmd")
        .args(["/C", "start", "", target])
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(target)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn execute_general_pet_action(
    action: &PetActionPayload,
    extra_args: Option<Vec<String>>,
) -> Result<String, String> {
    match action.action_type.as_str() {
        "open" | "url" => {
            let target = action
                .target
                .as_deref()
                .or(action.url.as_deref())
                .unwrap_or(".");
            open_target_in_os(target)?;
            Ok(format!("已打开目标：{}", target))
        }
        "exec" => {
            let raw_cmd = action.command.as_deref().unwrap_or("python");
            let mut full_args = action.args.clone().unwrap_or_default();
            if let Some(extras) = extra_args {
                full_args.extend(extras);
            }

            let mut cmd_builder = build_command_with_python_fallback(raw_cmd, &full_args);
            if let Some(ref dir) = action.cwd {
                if !dir.is_empty() {
                    cmd_builder.current_dir(dir);
                }
            }

            let output = cmd_builder
                .output()
                .map_err(|e| format!("Failed to execute '{}': {}", raw_cmd, e))?;

            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

            if !stdout.is_empty() {
                Ok(stdout)
            } else if !stderr.is_empty() {
                Ok(stderr)
            } else {
                Ok(format!("指令 [{}] 执行完毕", raw_cmd))
            }
        }
        other => Ok(format!("动作 [{}] 已派发", other)),
    }
}

fn build_command_with_python_fallback(program: &str, args: &[String]) -> Command {
    if program == "python" {
        if Command::new("python").arg("--version").output().is_ok() {
            let mut c = Command::new("python");
            c.args(args);
            return c;
        } else if Command::new("python3").arg("--version").output().is_ok() {
            let mut c = Command::new("python3");
            c.args(args);
            return c;
        }
    }
    let mut c = Command::new(program);
    c.args(args);
    c
}
