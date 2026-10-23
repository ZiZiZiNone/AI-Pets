//! Where plugin packages come from.
//!
//! A plugin package is a folder holding a `plugin.yaml`. The host ships with one root —
//! the `plugins/` beside its own files — and may be told to read others, declared as
//! `host.plugins_dirs`. Those extra roots are empty by default, exactly like
//! `host.pets_dirs`, so a fresh install finds only the plugins it was built with.
//!
//! Nothing here decides which permissions a plugin gets. The manifest says what a
//! plugin wants, the user says what is allowed, and the bus is handed the result; this
//! module only finds the manifests.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::pet_packages::{parse_extra_dirs, pet_package_roots};

/// One `plugin.yaml`, as the interface consumes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginPackageEntry {
    /// The folder name, used as the plugin id when the manifest declares none.
    pub dir_name: String,
    /// The manifest text, parsed by the interface.
    pub yaml: String,
}

const PLUGIN_DIRS_KEY: &str = "plugins_dirs:";
const PLUGIN_MANIFEST_FILE: &str = "plugin.yaml";

/// The plugin roots: the bundled `plugins/` first, then whatever `host.plugins_dirs` adds.
///
/// The bundled root leads for the same reason the pet roots do: a plugin that arrives
/// twice resolves to the copy the host knows about, rather than forking into two
/// plugins with one id.
pub fn plugin_package_roots(bundled: &Path, settings_yaml: &str) -> Vec<PathBuf> {
    pet_package_roots(bundled, parse_extra_dirs(settings_yaml, PLUGIN_DIRS_KEY))
}

/// Reads every root in order and returns the plugin packages they contribute.
///
/// A folder without a `plugin.yaml` is not a plugin and is skipped without comment:
/// the directory may hold anything. A `plugin.yaml` that exists but cannot be read is
/// reported on stderr and skipped, because one unreadable file must not hide the
/// plugins that did load.
///
/// The first root to claim a folder name keeps it. A plugin that arrives later under
/// the same name is reported and skipped, because two plugins sharing one id would
/// have one permission table between them.
pub fn collect_plugin_packages(roots: &[PathBuf]) -> Vec<PluginPackageEntry> {
    let mut packages: Vec<PluginPackageEntry> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::new();

    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        dirs.sort();

        for dir in dirs {
            let Some(dir_name) = dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let manifest_path = dir.join(PLUGIN_MANIFEST_FILE);

            match fs::read_to_string(&manifest_path) {
                Ok(yaml) => {
                    if !claimed.insert(dir_name.to_string()) {
                        eprintln!(
                            "[plugins] 跳过 {}：同名插件已在前面的目录中采用",
                            manifest_path.display()
                        );
                        continue;
                    }
                    packages.push(PluginPackageEntry {
                        dir_name: dir_name.to_string(),
                        yaml,
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(err) => {
                    eprintln!("[plugins] 无法读取 {}：{}", manifest_path.display(), err);
                }
            }
        }
    }

    packages
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai-pets-plugins-{name}-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_folder_with_a_manifest_is_a_plugin() {
        let dir = tempdir("basic");
        let plugins = dir.join("plugins");
        fs::create_dir_all(plugins.join("demo")).unwrap();
        fs::write(plugins.join("demo").join("plugin.yaml"), "id: demo").unwrap();

        let found = collect_plugin_packages(&[plugins]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].dir_name, "demo");
        assert!(found[0].yaml.contains("id: demo"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_without_a_manifest_is_not_a_plugin() {
        let dir = tempdir("no-manifest");
        let plugins = dir.join("plugins");
        fs::create_dir_all(plugins.join("notes")).unwrap();
        assert!(collect_plugin_packages(&[plugins]).is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_root_is_skipped_rather_than_fatal() {
        let dir = tempdir("missing-root");
        assert!(collect_plugin_packages(&[dir.join("not-there")]).is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_first_root_to_claim_a_name_keeps_it() {
        let dir = tempdir("first-wins");
        let bundled = dir.join("plugins");
        let extra = dir.join("packs");
        fs::create_dir_all(bundled.join("demo")).unwrap();
        fs::create_dir_all(extra.join("demo")).unwrap();
        fs::write(bundled.join("demo").join("plugin.yaml"), "id: bundled").unwrap();
        fs::write(extra.join("demo").join("plugin.yaml"), "id: extra").unwrap();

        let found = collect_plugin_packages(&[bundled, extra]);
        assert_eq!(found.len(), 1);
        assert!(found[0].yaml.contains("bundled"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_configured_plugin_directories_are_read() {
        let settings = "host:\n  plugins_dirs:\n    - \"E:/packs/one\"\n    - E:/packs/two\n";
        assert_eq!(
            parse_extra_dirs(settings, PLUGIN_DIRS_KEY),
            vec![PathBuf::from("E:/packs/one"), PathBuf::from("E:/packs/two")]
        );
    }

    #[test]
    fn an_absent_plugin_directory_key_yields_nothing() {
        assert!(parse_extra_dirs("host:\n  default_pet: demo\n", PLUGIN_DIRS_KEY).is_empty());
    }

    #[test]
    fn the_bundled_root_leads_and_repeats_are_collapsed() {
        let dir = tempdir("roots");
        let bundled = dir.join("plugins");
        fs::create_dir_all(&bundled).unwrap();
        let extra = dir.join("packs");

        let roots = plugin_package_roots(
            &bundled,
            &format!(
                "host:\n  plugins_dirs:\n    - {}\n    - {}\n",
                extra.display(),
                bundled.display()
            ),
        );
        assert_eq!(roots, vec![bundled, extra]);

        fs::remove_dir_all(&dir).ok();
    }
}
