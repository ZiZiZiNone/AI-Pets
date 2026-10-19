use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

use crate::pet_packages;

/// Longest identifier accepted for a pet folder name.
pub const MAX_PET_ID_LEN: usize = 64;

/// Accept a pet id only if it is shaped like a folder name.
///
/// The shipped pets used to be a hardcoded list, which meant a pet added by dropping a
/// folder into `pets/` could be loaded and rendered but never selected from a menu: the
/// four ids in the list were the only ones that could be switched to without editing Rust.
/// A shape check keeps the security property that list was actually providing — no
/// separators, no `..`, no whitespace or control characters, bounded length — while
/// letting any pet that exists also be addressed.
///
/// Letters are accepted in any script, because a pet folder is named by its author and
/// `银羽` is as valid a name as `silverfeather`. The id is only ever used as a lookup key
/// and matched against a directory listing; it never reaches a shell or a path join, which
/// is why the check is about shape rather than about a character allowlist.
///
/// Shape alone is not enough to accept a switch request, though: it says the id *could*
/// name a folder, not that one is installed. [`ensure_pet_installed`] is the second half.
pub fn validate_pet_id(pet_id: &str) -> Result<(), String> {
    if pet_id.is_empty() {
        return Err("Invalid pet_id: empty".into());
    }
    if pet_id.chars().count() > MAX_PET_ID_LEN {
        return Err(format!(
            "Invalid pet_id: longer than {} characters",
            MAX_PET_ID_LEN
        ));
    }
    if !pet_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "Invalid pet_id '{}': only letters, digits, '_' and '-' are allowed",
            pet_id.escape_debug()
        ));
    }
    Ok(())
}

/// Refuse a switch to a pet that is not installed, naming the id and every directory searched.
///
/// The id has already passed [`validate_pet_id`], so joining it cannot escape any root:
/// no separators, no `..`, no leading or trailing space. What is left to decide is whether
/// a pet of that name is actually there, and the answer has to reach the caller as an error.
/// Returning success for an unknown id moved the failure to the interface, where a missing
/// pet was reported as nothing at all — the menu item looked inert rather than wrong.
///
/// "There" means `<root>/<id>/pet.yaml` exists under one of `roots`, which is the same
/// predicate `load_host_configs` uses to build the list the interface can switch between.
/// A bare directory is not enough: it would pass a weaker check here and still be
/// unswitchable, which is the same false success in a smaller costume. The roots are
/// plural because a package may live outside the folder the host ships with; the error
/// lists all of them, since "unknown pet" without the paths it looked in is the version
/// that costs an hour.
pub fn ensure_pet_installed(roots: &[PathBuf], pet_id: &str) -> Result<(), String> {
    if pet_packages::find_package_dir(roots, pet_id).is_some() {
        return Ok(());
    }
    let searched: Vec<String> = roots
        .iter()
        .map(|root| root.display().to_string())
        .collect();
    Err(format!(
        "Unknown pet_id '{}': no pet folder named that under {} \
         (a pet folder is <id>/pet.yaml)",
        pet_id.escape_debug(),
        searched.join(", ")
    ))
}

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
    /// `panel` only: which of the two panel sources to use.
    pub mode: Option<String>,
    /// `panel` only: heading shown above the panel.
    pub title: Option<String>,
    /// `panel` only: the SDUI description itself.
    ///
    /// Kept as an opaque JSON value on purpose. The host renders whatever the schema says
    /// and never interprets it, so mirroring the widget union here would mean every new
    /// widget type also had to be declared in Rust — and a payload that cannot carry its
    /// schema is a panel that opens empty at the far end of a process boundary.
    pub schema: Option<serde_json::Value>,
}

/// A panel the host has been asked to show, with its configuration already resolved.
///
/// Built from [`PetActionPayload`] so the two panel modes are decided here, once: an
/// unrecognised `mode` becomes `schema` rather than travelling onward as a value nobody
/// validates.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct PanelRequest {
    pub mode: String,
    pub title: Option<String>,
    pub url: Option<String>,
    pub schema: Option<serde_json::Value>,
}

/// What showing a panel needs from the environment around the executor.
///
/// A trait rather than a direct `AppHandle` so the executor can be tested without a window:
/// a test records the request and asserts on it, which is the only way to show that a schema
/// survived the trip intact.
pub trait PanelHost {
    fn open_panel(&self, request: PanelRequest) -> Result<(), String>;
}

impl PanelRequest {
    /// Resolve a payload into a request, refusing the combinations that would open a blank
    /// panel: the mode decides which of `url` and `schema` is the one that must be present.
    fn from_payload(action: &PetActionPayload) -> Result<Self, String> {
        let mode = match action.mode.as_deref() {
            Some("url") => "url",
            _ => "schema",
        };
        let request = Self {
            mode: mode.to_string(),
            title: action.title.clone(),
            url: action.url.clone(),
            schema: action.schema.clone(),
        };
        match mode {
            "url" if request.url.as_deref().unwrap_or("").is_empty() => {
                Err("Panel action with mode 'url' has no url".into())
            }
            "schema" if request.schema.is_none() => {
                Err("Panel action with mode 'schema' has no schema".into())
            }
            _ => Ok(request),
        }
    }
}

/// Run an action that a client may request over the bus.
///
/// `pet_roots` is the resolved search path — the directories the interface loads pet folders
/// from — so a switch can be judged against what is actually installed rather than against
/// a list compiled into the binary.
pub fn execute_whitelisted_action(
    cmd: &SafeActionCommand,
    pet_roots: &[PathBuf],
) -> Result<String, String> {
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
            validate_pet_id(pet_id)?;
            ensure_pet_installed(pet_roots, pet_id)?;
            Ok(format!("pet:{}", pet_id))
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

/// Run a general (non-whitelisted) pet action.
///
/// `panel_host` is the way back to the interface for actions that need one; it is a
/// parameter rather than a global so a test can supply a recorder.
pub fn execute_general_pet_action(
    action: &PetActionPayload,
    extra_args: Option<Vec<String>>,
    panel_host: &dyn PanelHost,
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
        "panel" => {
            let request = PanelRequest::from_payload(action)?;
            let label = request
                .title
                .clone()
                .unwrap_or_else(|| request.mode.clone());
            panel_host.open_panel(request)?;
            Ok(format!("面板已打开：{}", label))
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
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn cmd(name: &str) -> SafeActionCommand {
        serde_json::from_value(serde_json::json!({ "action_id": name })).expect("unit variant")
    }

    fn cmd_with(name: &str, params: serde_json::Value) -> SafeActionCommand {
        serde_json::from_value(serde_json::json!({ "action_id": name, "params": params }))
            .expect("variant with params")
    }

    /// A stand-in `pets/` root that removes itself, so tests leave no folders behind.
    ///
    /// Switch requests are judged against the real directory listing, so a test cannot use
    /// an in-memory list: it has to create the folders it expects to be found. Each folder
    /// gets a `pet.yaml`, because a folder without one is not a pet the interface can load.
    struct PetsRoot {
        path: PathBuf,
    }

    impl PetsRoot {
        fn with(ids: &[&str]) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "ai-pets-test-pets-{}-{}",
                std::process::id(),
                TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("pets root");
            for id in ids {
                Self::write_manifest(&path, id);
            }
            Self { path }
        }

        fn write_manifest(space: &Path, id: &str) {
            let dir = space.join(id);
            fs::create_dir_all(&dir).expect("pet folder");
            fs::write(dir.join("pet.yaml"), format!("id: {id}\n")).expect("pet manifest");
        }

        /// A folder with the pet id as its name but no `pet.yaml` inside it.
        fn with_empty_folder(&self, id: &str) {
            fs::create_dir_all(self.path.join(id)).expect("empty folder");
        }

        /// A file, not a folder, with the pet id as its name.
        fn with_file(&self, id: &str) {
            fs::write(self.path.join(id), b"not a pet").expect("decoy file");
        }
    }

    impl Drop for PetsRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// Single-root searches, which is what most of these cases are about.
    fn switch(pets_dir: &Path, pet_id: &str) -> Result<String, String> {
        execute_whitelisted_action(
            &cmd_with("switch_pet", serde_json::json!({ "pet_id": pet_id })),
            std::slice::from_ref(&pets_dir.to_path_buf()),
        )
    }

    #[test]
    fn unit_variants_execute() {
        let pets = PetsRoot::with(&[]);
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
            assert_eq!(
                execute_whitelisted_action(&cmd(name), std::slice::from_ref(&pets.path)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn allowed_emotions_are_accepted() {
        let pets = PetsRoot::with(&[]);
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
                execute_whitelisted_action(&action, std::slice::from_ref(&pets.path)).unwrap(),
                format!("emotion:{emotion}")
            );
        }
    }

    #[test]
    fn emotion_outside_the_whitelist_is_rejected() {
        // The whitelist is the security boundary for externally supplied identifiers,
        // so an unknown value must fail loudly rather than fall through.
        let pets = PetsRoot::with(&[]);
        for emotion in ["", "HAPPY", "neutral; rm -rf /", "happy\nhappy"] {
            let action = cmd_with("switch_emotion", serde_json::json!({ "emotion": emotion }));
            let err =
                execute_whitelisted_action(&action, std::slice::from_ref(&pets.path)).unwrap_err();
            assert!(
                err.starts_with("Disallowed emotion identifier"),
                "unexpected error for {emotion:?}: {err}"
            );
        }
    }

    #[test]
    fn installed_pets_are_accepted() {
        let pets = PetsRoot::with(&["silverfeather_chibi", "sakura_rin", "guanlan", "qilin_ling"]);
        for pet in ["silverfeather_chibi", "sakura_rin", "guanlan", "qilin_ling"] {
            assert_eq!(
                switch(&pets.path, pet).unwrap(),
                format!("pet:{pet}"),
                "{pet} exists under the pets root and must be switchable"
            );
        }
    }

    #[test]
    fn a_pet_added_as_a_folder_is_switched_to_without_a_code_change() {
        // The behaviour this replaces: only the four bundled ids resolved, so a pet added
        // as a folder could be selected from the interface but not from a menu action.
        // These ids are deliberately absent from any list in the source.
        let pets = PetsRoot::with(&["silverfeather_chibi", "My_Pet-2", "银羽"]);
        for pet in ["silverfeather_chibi", "My_Pet-2", "银羽"] {
            assert_eq!(
                switch(&pets.path, pet).unwrap(),
                format!("pet:{pet}"),
                "a pet folder named {pet} must be addressable"
            );
        }
    }

    #[test]
    fn a_well_shaped_id_with_no_folder_is_refused_with_its_name() {
        // A shape check alone would accept a plausible id, and `petStore.switchPetById`
        // would then drop the request silently, leaving the interface to report success
        // for nothing.
        let pets = PetsRoot::with(&["silverfeather_chibi"]);
        for pet in ["ghost_pet", "no_such_pet", "pet_from_another_machine"] {
            let error = switch(&pets.path, pet).unwrap_err();
            assert!(
                error.starts_with(&format!("Unknown pet_id '{pet}'")),
                "unexpected error for {pet:?}: {error}"
            );
        }
    }

    #[test]
    fn the_unknown_pet_message_names_the_directory_that_was_searched() {
        // "unknown pet" without a location sends the user looking through the source; the
        // resolved root is the one fact that turns the message into an instruction.
        let pets = PetsRoot::with(&[]);
        let error = switch(&pets.path, "ghost_pet").unwrap_err();
        assert!(
            error.contains(&pets.path.display().to_string()),
            "the searched directory must appear in {error:?}"
        );
    }

    #[test]
    fn a_file_masquerading_as_a_pet_folder_does_not_satisfy_the_switch() {
        let pets = PetsRoot::with(&[]);
        pets.with_file("ghost_pet");
        let error = switch(&pets.path, "ghost_pet").unwrap_err();
        assert!(
            error.starts_with("Unknown pet_id 'ghost_pet'"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn a_folder_without_a_manifest_is_not_a_switchable_pet() {
        // The loader builds the interface's pet list from `<id>/pet.yaml`, so a bare folder
        // is invisible to it. Accepting one here would acknowledge a switch the interface
        // then refuses — the same false success, one directory level down.
        let pets = PetsRoot::with(&[]);
        pets.with_empty_folder("half_added_pet");
        let error = switch(&pets.path, "half_added_pet").unwrap_err();
        assert!(
            error.starts_with("Unknown pet_id 'half_added_pet'"),
            "unexpected error: {error}"
        );

        // Adding the manifest is the whole difference, so the same id then resolves.
        PetsRoot::write_manifest(&pets.path, "half_added_pet");
        assert_eq!(
            switch(&pets.path, "half_added_pet").unwrap(),
            "pet:half_added_pet"
        );
    }

    #[test]
    fn a_missing_pets_root_refuses_every_switch_instead_of_succeeding_blindly() {
        // An installed build whose resources did not unpack has no `pets/` at all. Every
        // switch must fail there; a validator that only checked the id shape would report
        // success for all of them.
        let missing = std::env::temp_dir().join(format!(
            "ai-pets-test-absent-{}-{}",
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let error = switch(&missing, "silverfeather_chibi").unwrap_err();
        assert!(error.starts_with("Unknown pet_id"), "{error}");
    }

    #[test]
    fn unknown_pet_is_rejected() {
        // What must stay refused is anything that could escape the pets directory or
        // smuggle in a second path.
        let pets = PetsRoot::with(&[]);
        for pet in [
            "",
            "../secrets",
            "a/b",
            "a\\b",
            "sakura_rin ",
            " pet",
            "pet\nid",
            "pet\0id",
            "pet;rm -rf /",
            ".",
            "..",
        ] {
            let error = switch(&pets.path, pet).unwrap_err();
            assert!(
                error.starts_with("Invalid pet_id"),
                "unexpected error for {pet:?}: {error}"
            );
        }
    }

    #[test]
    fn a_traversal_attempt_cannot_reach_a_sibling_of_the_pets_root() {
        // The shape check is what keeps `..` out of the join. Prove the two halves are
        // ordered that way: a sibling directory that really exists must still be refused,
        // because the id naming it is rejected before any lookup happens.
        let pets = PetsRoot::with(&[]);
        let sibling = pets.path.parent().expect("temp dir").join(format!(
            "ai-pets-test-sibling-{}-{}",
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&sibling).expect("sibling dir");
        let as_id = sibling
            .file_name()
            .expect("sibling name")
            .to_string_lossy()
            .to_string();
        let error = switch(&pets.path, &format!("../{as_id}")).unwrap_err();
        assert!(error.starts_with("Invalid pet_id"), "{error}");
        let _ = fs::remove_dir_all(&sibling);
    }

    #[test]
    fn an_over_long_pet_id_is_refused_by_shape_not_by_length_of_a_list() {
        let long_id = "a".repeat(MAX_PET_ID_LEN + 1);
        assert!(validate_pet_id(&long_id).is_err());
        assert!(validate_pet_id(&"a".repeat(MAX_PET_ID_LEN)).is_ok());
    }

    #[test]
    fn the_rejection_message_escapes_control_characters() {
        // The id reaches a log and, in the failure case, a UI string; a raw newline in
        // there would let a client forge a second line of output.
        let error = validate_pet_id("pet\nid").unwrap_err();
        assert!(error.contains("\\n"), "{error}");
        assert!(!error.contains('\n'), "{error}");

        let pets = PetsRoot::with(&[]);
        let error = ensure_pet_installed(std::slice::from_ref(&pets.path), "pet\nid").unwrap_err();
        assert!(error.contains("\\n"), "{error}");
        assert!(!error.contains('\n'), "{error}");
    }

    #[test]
    fn pomodoro_falls_back_to_twenty_five_minutes() {
        let pets = PetsRoot::with(&[]);
        assert_eq!(
            execute_whitelisted_action(
                &cmd_with("start_pomodoro", serde_json::json!({ "minutes": null })),
                std::slice::from_ref(&pets.path)
            )
            .unwrap(),
            "action:pomodoro:25"
        );
        assert_eq!(
            execute_whitelisted_action(
                &cmd_with("start_pomodoro", serde_json::json!({ "minutes": 45 })),
                std::slice::from_ref(&pets.path)
            )
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

    /// Records what a panel request carried, so a test can prove nothing was dropped.
    #[derive(Default)]
    struct RecordingPanelHost {
        requests: std::cell::RefCell<Vec<PanelRequest>>,
        fail_with: Option<String>,
    }

    impl RecordingPanelHost {
        fn refusing(reason: &str) -> Self {
            Self {
                requests: std::cell::RefCell::new(Vec::new()),
                fail_with: Some(reason.to_string()),
            }
        }

        fn last(&self) -> PanelRequest {
            self.requests
                .borrow()
                .last()
                .cloned()
                .expect("a panel request was recorded")
        }

        fn count(&self) -> usize {
            self.requests.borrow().len()
        }
    }

    impl PanelHost for RecordingPanelHost {
        fn open_panel(&self, request: PanelRequest) -> Result<(), String> {
            self.requests.borrow_mut().push(request);
            match &self.fail_with {
                Some(reason) => Err(reason.clone()),
                None => Ok(()),
            }
        }
    }

    /// A payload with every optional field set to `None`, for the cases a test does not care
    /// about. Built through JSON so it stays in step with the serde field list.
    fn panel_payload(fields: serde_json::Value) -> PetActionPayload {
        let mut base = serde_json::json!({ "type": "panel" });
        let map = base.as_object_mut().expect("object");
        for (key, value) in fields.as_object().expect("object") {
            map.insert(key.clone(), value.clone());
        }
        serde_json::from_value(base).expect("panel payload")
    }

    #[test]
    fn a_panel_action_carries_its_schema_across_the_boundary() {
        // The defect this covers: `PetActionPayload` had no `schema` field, so a client that
        // sent one had it dropped by serde and the panel opened empty at the far end — with
        // no error to explain why.
        let schema = serde_json::json!({
            "title": "外部载荷控制台",
            "widgets": [
                { "id": "voice_gain", "type": "slider", "label": "语音增益", "value": 40 },
                { "id": "note", "type": "text_input", "label": "备注", "value": "" },
            ],
        });
        let payload = panel_payload(serde_json::json!({
            "mode": "schema",
            "title": "外部载荷控制台",
            "schema": schema,
        }));
        let host = RecordingPanelHost::default();

        assert_eq!(
            execute_general_pet_action(&payload, None, &host).unwrap(),
            "面板已打开：外部载荷控制台"
        );

        let request = host.last();
        assert_eq!(request.mode, "schema");
        assert_eq!(request.title.as_deref(), Some("外部载荷控制台"));
        assert_eq!(
            request.schema,
            Some(schema.clone()),
            "schema arrived changed"
        );
        assert_eq!(
            request.schema.unwrap()["widgets"][1]["type"],
            "text_input",
            "the widget union must cross unchanged, not be reinterpreted"
        );
    }

    #[test]
    fn a_panel_action_without_a_mode_defaults_to_schema() {
        let payload = panel_payload(serde_json::json!({
            "schema": { "widgets": [{ "id": "a", "type": "toggle" }] },
        }));
        let host = RecordingPanelHost::default();
        execute_general_pet_action(&payload, None, &host).unwrap();
        assert_eq!(host.last().mode, "schema");
    }

    #[test]
    fn an_unrecognised_panel_mode_is_not_forwarded_as_written() {
        let payload = panel_payload(serde_json::json!({
            "mode": "definitely_not_a_mode",
            "schema": { "widgets": [] },
        }));
        let host = RecordingPanelHost::default();
        execute_general_pet_action(&payload, None, &host).unwrap();
        assert_eq!(
            host.last().mode,
            "schema",
            "a mode nobody validates must not travel onward as written"
        );
    }

    #[test]
    fn a_url_panel_carries_its_url() {
        let payload = panel_payload(serde_json::json!({
            "mode": "url",
            "url": "https://example.invalid/panel",
        }));
        let host = RecordingPanelHost::default();
        execute_general_pet_action(&payload, None, &host).unwrap();
        let request = host.last();
        assert_eq!(request.mode, "url");
        assert_eq!(
            request.url.as_deref(),
            Some("https://example.invalid/panel")
        );
        assert_eq!(request.schema, None);
    }

    #[test]
    fn a_panel_missing_the_source_its_mode_needs_is_refused_before_anything_opens() {
        for (fields, expected) in [
            (
                serde_json::json!({ "mode": "schema" }),
                "mode 'schema' has no schema",
            ),
            (
                serde_json::json!({ "mode": "url" }),
                "mode 'url' has no url",
            ),
            (
                serde_json::json!({ "mode": "url", "url": "" }),
                "mode 'url' has no url",
            ),
            (
                // The generic `url` field is for the `open`/`url` action types; a panel in
                // url mode reads it too, so a bare `schema: null` must not pass as a source.
                serde_json::json!({ "schema": null }),
                "mode 'schema' has no schema",
            ),
        ] {
            let host = RecordingPanelHost::default();
            let error = execute_general_pet_action(&panel_payload(fields.clone()), None, &host)
                .unwrap_err();
            assert!(error.contains(expected), "for {fields}: {error}");
            assert_eq!(host.count(), 0, "a refused panel must not reach the host");
        }
    }

    #[test]
    fn a_panel_host_failure_is_reported_rather_than_swallowed() {
        // The window can be gone, or the frontend listener absent. The caller has to hear
        // that, otherwise an external client is told the panel opened when nothing did.
        let payload = panel_payload(serde_json::json!({
            "mode": "schema",
            "schema": { "widgets": [] },
        }));
        let host = RecordingPanelHost::refusing("no companion window");
        let error = execute_general_pet_action(&payload, None, &host).unwrap_err();
        assert!(error.contains("no companion window"), "{error}");
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
            mode: None,
            title: None,
            schema: None,
        };
        let host = RecordingPanelHost::default();
        assert!(execute_general_pet_action(&payload, None, &host)
            .unwrap()
            .starts_with("动作 ["));
        assert_eq!(host.count(), 0, "an unknown type must not touch the host");
    }
}
