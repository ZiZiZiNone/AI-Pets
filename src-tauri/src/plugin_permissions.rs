//! The capability boundary of the external bus.
//!
//! The bus token says "some program on this machine"; it cannot say what that
//! program is allowed to do. The host decides that, and it does so before the
//! bus ever sees a client: it reads each plugin's manifest, asks the user, and
//! hands Rust the resulting table. Everything the bus enforces is derived from
//! that table, which is why the manifest is never parsed here.
//!
//! Two rules shape the module. It is fail-closed — a method that is not in the
//! map is refused rather than ignored, because an unmapped method is one whose
//! side effects nobody looked at. And an app the host never mentioned still
//! gets the smallest useful permission, so a bus that has not been handed a
//! table yet is quiet instead of wide open.

use std::collections::{HashMap, HashSet};

/// Every permission name the bus understands.
///
/// A name outside this list is a typo or an invented capability, so it is
/// dropped instead of stored: a permission nobody recognises cannot be checked
/// against anything, and keeping it would make the table look fuller than it is.
pub const KNOWN_PERMISSIONS: [&str; 6] = [
    "pet:act",
    "pet:speak",
    "pet:driver",
    "menu:register",
    "panel:open",
    "hud:draw",
];

/// What an app may do when the host has said nothing about it.
///
/// Speech is the one capability that touches nothing but the screen, and it is
/// what an external assistant needs to be useful at all. Everything else —
/// moving the character, taking over its voice, mounting menus, opening panels,
/// drawing on the HUD — has to be granted.
pub const DEFAULT_PERMISSION: &str = "pet:speak";

/// The action types a menu registered over the bus may carry.
///
/// `exec` is deliberately missing. A menu item is something the *user* clicks,
/// so an external program could register one and wait for the click to run any
/// command it liked: that would hand command execution to every local process
/// that knows the token, with the user as the trigger. The pet packages the
/// user installed themselves are unaffected — those never come through the bus.
pub const ALLOWED_MENU_ACTION_TYPES: [&str; 4] = ["emit", "panel", "url", "open"];

/// Whether `name` is a permission the bus knows.
pub fn is_known_permission(name: &str) -> bool {
    KNOWN_PERMISSIONS.contains(&name)
}

/// The permission a bus method needs.
///
/// `None` means the method is not part of the bus at all, and the caller has to
/// refuse it: a method nobody mapped is a method nobody reviewed.
pub fn required_permission(method: &str) -> Option<&'static str> {
    match method {
        "pet.act" => Some("pet:act"),
        "pet.say" | "speak" => Some("pet:speak"),
        "pet.driver" => Some("pet:driver"),
        "menu.register" | "menu.unregister" => Some("menu:register"),
        "panel.open" | "panel.update" => Some("panel:open"),
        "hud.draw" | "hud.clear" => Some("hud:draw"),
        _ => None,
    }
}

/// The permissions the host approved for each app.
///
/// The table is the whole of what the bus enforces. The frontend has already
/// intersected each manifest with the user's decisions, so what is absent here
/// was not approved — there is nothing left to check.
#[derive(Debug, Default)]
pub struct PermissionTable {
    approved: HashMap<String, HashSet<String>>,
}

impl PermissionTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the whole table and reports the permission names that were dropped.
    ///
    /// Replacing rather than merging is what makes the table a statement about
    /// what is approved *now*: an app the host revoked disappears instead of
    /// keeping what it used to have.
    pub fn replace(&mut self, granted: HashMap<String, Vec<String>>) -> Vec<String> {
        let mut approved: HashMap<String, HashSet<String>> = HashMap::new();
        let mut unknown: Vec<String> = Vec::new();
        for (app_id, names) in granted {
            let mut set = HashSet::new();
            for name in names {
                if is_known_permission(&name) {
                    set.insert(name);
                } else {
                    unknown.push(name);
                }
            }
            approved.insert(app_id, set);
        }
        self.approved = approved;
        unknown
    }

    /// Whether `app_id` holds `permission`.
    pub fn allows(&self, app_id: &str, permission: &str) -> bool {
        match self.approved.get(app_id) {
            Some(set) => set.contains(permission),
            None => permission == DEFAULT_PERMISSION,
        }
    }

    /// What `app_id` may actually do, sorted so a report of it stays stable.
    pub fn effective_permissions(&self, app_id: &str) -> Vec<String> {
        match self.approved.get(app_id) {
            Some(set) => {
                let mut names: Vec<String> = set.iter().cloned().collect();
                names.sort();
                names
            }
            None => vec![DEFAULT_PERMISSION.to_string()],
        }
    }
}

/// The message reported when a call is refused.
///
/// It answers three questions at once, because the person reading it is usually
/// working out which side to fix: what was called, what it would have needed,
/// and what the app does hold.
pub fn denial_reason(
    app_id: &str,
    method: &str,
    needed: Option<&str>,
    approved: &[String],
) -> String {
    let need = match needed {
        Some(permission) => format!("需要权限「{permission}」"),
        None => "该方法不在总线允许清单内、没有对应权限".to_string(),
    };
    let held = if approved.is_empty() {
        "未批准任何权限".to_string()
    } else {
        approved.join("、")
    };
    format!("权限不足：app「{app_id}」调用方法「{method}」，{need}，该 app 当前被批准：{held}")
}

/// A menu item the bus will not accept.
#[derive(Debug, Clone)]
pub struct RejectedMenuAction {
    /// The id of the offending item, so the caller can be told which one.
    pub item_id: String,
    /// The action type that was refused.
    pub action_type: String,
}

/// The first menu item whose action the bus will not accept.
///
/// The payload carries either one `item` or a list of `menus`, and either may
/// nest children, so the whole tree is walked: a parent with a harmless action
/// must not launder a command through a child.
pub fn rejected_menu_action(params: &serde_json::Value) -> Option<RejectedMenuAction> {
    if let Some(items) = params.get("menus").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(rejected) = rejected_item_action(item) {
                return Some(rejected);
            }
        }
    }
    rejected_item_action(params.get("item")?)
}

fn rejected_item_action(item: &serde_json::Value) -> Option<RejectedMenuAction> {
    if let Some(action) = item.get("action") {
        // An action without a type cannot be shown to be harmless, so it is
        // refused along with the ones that name a type nobody allows.
        let action_type = action
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("(未指定)");
        if !ALLOWED_MENU_ACTION_TYPES.contains(&action_type) {
            let item_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("(未命名)")
                .to_string();
            return Some(RejectedMenuAction {
                item_id,
                action_type: action_type.to_string(),
            });
        }
    }
    if let Some(children) = item.get("children").and_then(|v| v.as_array()) {
        for child in children {
            if let Some(rejected) = rejected_item_action(child) {
                return Some(rejected);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(entries: &[(&str, &[&str])]) -> PermissionTable {
        let mut table = PermissionTable::new();
        table.replace(
            entries
                .iter()
                .map(|(app, names)| {
                    (
                        (*app).to_string(),
                        names.iter().map(|n| (*n).to_string()).collect(),
                    )
                })
                .collect(),
        );
        table
    }

    #[test]
    fn an_app_the_host_never_mentioned_may_only_speak() {
        let table = PermissionTable::new();
        assert!(table.allows("ghost", "pet:speak"));
        for permission in [
            "pet:act",
            "pet:driver",
            "menu:register",
            "panel:open",
            "hud:draw",
        ] {
            assert!(
                !table.allows("ghost", permission),
                "{permission} must not be granted by default"
            );
        }
    }

    #[test]
    fn an_approved_app_holds_exactly_what_was_approved() {
        let table = table(&[("helper", &["pet:act", "hud:draw"])]);
        assert!(table.allows("helper", "pet:act"));
        assert!(table.allows("helper", "hud:draw"));
        // The approval is exact — it does not quietly add the default back.
        assert!(!table.allows("helper", "pet:speak"));
        assert!(!table.allows("helper", "panel:open"));
    }

    #[test]
    fn an_app_listed_with_nothing_holds_nothing() {
        let table = table(&[("helper", &[])]);
        assert!(!table.allows("helper", "pet:speak"));
        assert!(table.effective_permissions("helper").is_empty());
    }

    #[test]
    fn a_permission_name_the_bus_does_not_know_is_dropped_and_reported() {
        let mut table = PermissionTable::new();
        let unknown = table.replace(HashMap::from([(
            "helper".to_string(),
            vec!["pet:act".to_string(), "pet:elevate".to_string()],
        )]));
        assert_eq!(unknown, vec!["pet:elevate".to_string()]);
        // The name was never stored, so it grants nothing.
        assert!(table.allows("helper", "pet:act"));
        assert!(!table.allows("helper", "pet:speak"));
    }

    #[test]
    fn replacing_the_table_takes_the_old_approvals_away() {
        let mut table = table(&[("helper", &["pet:act"])]);
        table.replace(HashMap::from([(
            "other".to_string(),
            vec!["hud:draw".to_string()],
        )]));
        assert!(!table.allows("helper", "pet:act"));
        assert!(table.allows("other", "hud:draw"));
    }

    #[test]
    fn the_reported_permissions_are_sorted() {
        let table = table(&[("helper", &["hud:draw", "pet:act", "panel:open"])]);
        assert_eq!(
            table.effective_permissions("helper"),
            vec![
                "hud:draw".to_string(),
                "panel:open".to_string(),
                "pet:act".to_string()
            ]
        );
    }

    #[test]
    fn every_bus_method_maps_to_a_known_permission() {
        for method in [
            "pet.act",
            "pet.say",
            "speak",
            "pet.driver",
            "menu.register",
            "menu.unregister",
            "panel.open",
            "panel.update",
            "hud.draw",
            "hud.clear",
        ] {
            let permission = required_permission(method).expect("a mapped method");
            assert!(
                is_known_permission(permission),
                "{method} maps to an unknown permission {permission}"
            );
        }
    }

    #[test]
    fn a_method_outside_the_map_has_no_permission() {
        assert_eq!(required_permission("pet.shutdown"), None);
        assert_eq!(required_permission(""), None);
    }

    #[test]
    fn a_menu_that_would_run_a_command_is_refused() {
        let params = serde_json::json!({
            "app_id": "helper",
            "menus": [{
                "id": "evil",
                "label": "点我",
                "action": {"type": "exec", "command": "calc.exe"}
            }]
        });
        let rejected = rejected_menu_action(&params).expect("must be refused");
        assert_eq!(rejected.item_id, "evil");
        assert_eq!(rejected.action_type, "exec");
    }

    #[test]
    fn a_command_hidden_in_a_child_menu_is_refused() {
        // A harmless parent must not launder a command through a child.
        let params = serde_json::json!({
            "item": {
                "id": "root",
                "action": {"type": "emit", "event": "pet.quick_action"},
                "children": [{
                    "id": "nested",
                    "action": {"type": "exec", "command": "calc.exe"}
                }]
            }
        });
        let rejected = rejected_menu_action(&params).expect("must be refused");
        assert_eq!(rejected.item_id, "nested");
    }

    #[test]
    fn a_menu_of_allowed_actions_is_accepted() {
        let params = serde_json::json!({
            "menus": [
                {
                    "id": "a",
                    "action": {"type": "emit", "event": "pet.quick_action"},
                    "children": [{"id": "b", "action": {"type": "panel"}}]
                },
                {"id": "c", "action": {"type": "url", "url": "https://example.test"}},
                {"id": "d", "action": {"type": "open", "target": "https://example.test"}},
                {"id": "e"}
            ]
        });
        assert!(rejected_menu_action(&params).is_none());
    }

    #[test]
    fn an_action_without_a_type_is_refused() {
        // Nothing can be shown to be harmless about an action nobody typed.
        let params = serde_json::json!({"item": {"id": "x", "action": {"command": "calc.exe"}}});
        let rejected = rejected_menu_action(&params).expect("must be refused");
        assert_eq!(rejected.action_type, "(未指定)");
    }
}
