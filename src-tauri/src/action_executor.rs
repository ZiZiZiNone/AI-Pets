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
                "idle",
                "happy",
                "angry",
                "glitch",
                "speaking",
                "sleep",
                "smile",
                "surprised",
                "sleepy",
                "neutral",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(name: &str) -> SafeActionCommand {
        serde_json::from_value(serde_json::json!({ "action_id": name })).expect("unit variant")
    }

    fn cmd_with(name: &str, params: serde_json::Value) -> SafeActionCommand {
        serde_json::from_value(serde_json::json!({ "action_id": name, "params": params }))
            .expect("variant with params")
    }

    #[test]
    fn unit_variants_execute() {
        let cases = [
            ("open_companion", "action:open_companion"),
            ("toggle_studio", "action:toggle_studio"),
            ("open_official_docs_skip", ""),
            ("trigger_greeting", "action:greeting"),
            ("trigger_scan", "action:scan"),
        ];
        for (name, expected) in cases {
            if expected.is_empty() {
                continue; // opens a browser; covered by its own side-effecting path
            }
            assert_eq!(execute_whitelisted_action(&cmd(name)).unwrap(), expected);
        }
    }

    #[test]
    fn allowed_emotions_are_accepted() {
        for emotion in [
            "idle",
            "happy",
            "angry",
            "glitch",
            "speaking",
            "sleep",
            "smile",
            "surprised",
            "sleepy",
            "neutral",
        ] {
            let action = cmd_with("switch_emotion", serde_json::json!({ "emotion": emotion }));
            assert_eq!(
                execute_whitelisted_action(&action).unwrap(),
                format!("emotion:{emotion}")
            );
        }
    }

    #[test]
    fn emotion_outside_the_whitelist_is_rejected() {
        // The whitelist is the security boundary for externally supplied identifiers,
        // so an unknown value must fail loudly rather than fall through.
        for emotion in ["", "HAPPY", "neutral; rm -rf /", "happy\nhappy"] {
            let action = cmd_with("switch_emotion", serde_json::json!({ "emotion": emotion }));
            let err = execute_whitelisted_action(&action).unwrap_err();
            assert!(
                err.starts_with("Disallowed emotion identifier"),
                "unexpected error for {emotion:?}: {err}"
            );
        }
    }

    #[test]
    fn known_pets_are_accepted() {
        for pet in [
            "aether_mecha_core",
            "demo_sprite_pet",
            "nyx_abyssal_familiar",
            "pulse_glitch_phantom",
        ] {
            let action = cmd_with("switch_pet", serde_json::json!({ "pet_id": pet }));
            assert_eq!(
                execute_whitelisted_action(&action).unwrap(),
                format!("pet:{pet}")
            );
        }
    }

    #[test]
    fn unknown_pet_is_rejected() {
        for pet in ["", "../secrets", "AETHER_MECHA_CORE", "demo_sprite_pet "] {
            let action = cmd_with("switch_pet", serde_json::json!({ "pet_id": pet }));
            assert!(execute_whitelisted_action(&action)
                .unwrap_err()
                .starts_with("Unknown pet_id"));
        }
    }

    #[test]
    fn pomodoro_falls_back_to_twenty_five_minutes() {
        assert_eq!(
            execute_whitelisted_action(&cmd_with(
                "start_pomodoro",
                serde_json::json!({ "minutes": null })
            ))
            .unwrap(),
            "action:pomodoro:25"
        );
        assert_eq!(
            execute_whitelisted_action(&cmd_with(
                "start_pomodoro",
                serde_json::json!({ "minutes": 45 })
            ))
            .unwrap(),
            "action:pomodoro:45"
        );
    }

    #[test]
    fn unknown_action_id_does_not_deserialize() {
        // An unrecognised id must never become an executable variant.
        assert!(
            serde_json::from_value::<SafeActionCommand>(serde_json::json!({
                "action_id": "run_shell"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<SafeActionCommand>(serde_json::json!({
                "action_id": "open_companion",
                "params": {}
            }))
            .is_err()
        );
    }

    #[test]
    fn unknown_action_type_is_dispatched_not_executed() {
        let payload = PetActionPayload {
            action_type: "definitely_not_a_known_type".into(),
            command: None,
            args: None,
            cwd: None,
            target: None,
            url: None,
        };
        assert!(execute_general_pet_action(&payload, None)
            .unwrap()
            .starts_with("动作 ["));
    }
}
