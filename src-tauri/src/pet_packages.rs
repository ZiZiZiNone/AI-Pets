//! Where pet packages come from.
//!
//! A package is a folder holding a `pet.yaml`. The host ships with one root — the `pets/`
//! beside its own files — and may be told to read others. Those extra roots are declared
//! in `host.pets_dirs` and are empty by default, so a fresh install finds exactly the pets
//! it was built with and never depends on a directory it did not ship.
//!
//! An extra root is only ever a place to *read* from. Nothing here knows which project
//! writes into one, and a root may be produced by this project's own tooling or by any
//! other pet host: the coupling is a directory path, not a dependency between codebases.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One `pet.yaml` and the folder it came from, as the interface consumes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetManifestEntry {
    pub id: String,
    pub yaml: String,
    pub base_path: String,
}

/// A package folder left out because an earlier root already claims that id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedPackage {
    pub id: String,
    pub path: PathBuf,
    pub shadowed_by: PathBuf,
}

/// Everything one scan of the configured roots found.
#[derive(Debug, Default)]
pub struct PetPackageScan {
    /// Loadable packages, in root order and alphabetically within a root.
    pub packages: Vec<PetManifestEntry>,
    /// Package folder per id, so a later write can go back where the package was read.
    pub sources: HashMap<String, PathBuf>,
    /// Packages a later root could not contribute because an earlier one had the id.
    pub skipped: Vec<SkippedPackage>,
}

/// Reads `pets_dirs` out of `settings.yaml`.
///
/// Hand-parsed for the same reason `ws_port_range` is: this runs while the host is still
/// deciding what it is, before any settings type exists, and the key is a flat list of
/// strings. Accepted shapes are a block sequence and an inline `[a, b]`; anything else
/// yields an empty list instead of an error, because one malformed line must not stop the
/// host from finding the pets it already ships with.
///
/// Relative entries resolve against the working directory, matching how the bundled roots
/// are resolved elsewhere in the host.
pub fn parse_extra_pet_dirs(settings_yaml: &str) -> Vec<PathBuf> {
    parse_extra_dirs(settings_yaml, PET_DIRS_KEY)
}

/// Reads a list of directories declared under `key` in `settings.yaml`.
///
/// The pet roots and the plugin roots are both a flat list of paths typed by hand, so
/// they share one parser and one set of tolerated shapes. A key this host does not
/// know yields an empty list rather than an error: one malformed line must not stop
/// the host from finding the packages it already ships with.
pub fn parse_extra_dirs(settings_yaml: &str, key: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut lines = settings_yaml.lines();

    while let Some(line) = lines.next() {
        let trimmed = line.trim_end();
        let Some(rest) = trimmed.trim_start().strip_prefix(key) else {
            continue;
        };

        let inline = rest.trim();
        if !inline.is_empty() {
            dirs.extend(parse_inline_list(inline));
            continue;
        }

        let key_indent = indent_of(trimmed);
        for item in lines.by_ref() {
            if is_blank_or_comment(item) {
                continue;
            }
            if indent_of(item) <= key_indent && !item.trim_start().starts_with('-') {
                break;
            }
            if let Some(dir) = parse_list_item(item) {
                dirs.push(dir);
            }
        }
    }

    dirs
}

const PET_DIRS_KEY: &str = "pets_dirs:";

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn is_blank_or_comment(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with('#')
}

/// `- "E:/packs/one" # a note` becomes `E:/packs/one`.
///
/// A quoted entry is taken verbatim, because a `#` or a `\` inside quotes belongs to the
/// path. An unquoted one loses a trailing comment, which is the one case where the two
/// spellings would otherwise disagree about the value.
fn parse_list_item(line: &str) -> Option<PathBuf> {
    let value = unquote(line.trim_start().strip_prefix('-')?.trim_start());
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

fn parse_inline_list(raw: &str) -> Vec<PathBuf> {
    raw.trim()
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .map(|body| {
            body.split(',')
                .map(unquote)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

fn unquote(raw: &str) -> String {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    if let Some(&quote) = bytes.first() {
        if quote == b'"' || quote == b'\'' {
            // Take up to the closing quote rather than to the end of the line: a quoted
            // path may be followed by a comment, and the last character of that line is
            // then the comment's, not the path's.
            let body = &trimmed[1..];
            if let Some(end) = body.find(quote as char) {
                return body[..end].to_string();
            }
        }
    }
    trimmed
        .split_once(" #")
        .map_or(trimmed, |(value, _)| value)
        .trim()
        .to_string()
}

/// The search path: what the host ships with first, then whatever was configured.
///
/// The bundled root leads so a package that arrives twice — a copy still sitting in
/// `pets/` after the real one moved to an external directory — resolves to the copy the
/// host knows how to write back to, instead of silently forking into two pets. Repeated
/// roots are collapsed, because listing the bundled directory again is the one mistake
/// that would otherwise report the host's own pets as "shadowed" by themselves.
pub fn pet_package_roots(bundled: &Path, extra: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for candidate in std::iter::once(bundled.to_path_buf()).chain(extra) {
        let key = fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
        if seen.insert(key) {
            roots.push(candidate);
        }
    }
    roots
}

/// Reads every root in order and returns the packages they contribute.
///
/// A root that does not exist is skipped rather than reported: `pets_dirs` is a list a
/// user types by hand, and a path that has not been created yet is a normal state to be in
/// rather than an error worth surfacing on every load.
///
/// The first root to claim an id keeps it. A package that arrives later is reported in
/// `skipped` instead of silently dropped, because "my pet did not change" is the symptom
/// this situation produces and the reason has to be visible somewhere.
pub fn collect_pet_packages(roots: &[PathBuf]) -> PetPackageScan {
    let mut scan = PetPackageScan::default();

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
            let Ok(yaml) = fs::read_to_string(dir.join("pet.yaml")) else {
                continue;
            };
            let Some(id) = dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let id = id.to_string();

            if let Some(shadowed_by) = scan.sources.get(&id).and_then(|dir| dir.parent()) {
                scan.skipped.push(SkippedPackage {
                    id,
                    path: dir,
                    shadowed_by: shadowed_by.to_path_buf(),
                });
                continue;
            }

            scan.sources.insert(id.clone(), dir.clone());
            scan.packages.push(PetManifestEntry {
                base_path: fs::canonicalize(&dir)
                    .unwrap_or(dir)
                    .to_string_lossy()
                    .to_string(),
                id,
                yaml,
            });
        }
    }

    scan
}

/// Whether `pet_id` resolves to an installed package under any of `roots`.
///
/// `roots` is the whole search path rather than one directory, because a package may live
/// outside the folder the host ships with. The error names every directory searched: an id
/// that is not installed is reported back to whoever asked for the switch, and "unknown
/// pet" without the path it looked in is the version that costs an hour.
pub fn find_package_dir(roots: &[PathBuf], pet_id: &str) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join(pet_id))
        .find(|candidate| candidate.join("pet.yaml").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS: &str = "\
host:
  ws_port_range: [9527, 9537]
  pets_dirs:
    - \"E:/packs/one\"
    - 'E:/packs/two'   # a note
  heartbeat_timeout_sec: 45
render:
  idle_fps: 24
";

    #[test]
    fn a_block_sequence_is_read_in_order() {
        assert_eq!(
            parse_extra_pet_dirs(SETTINGS),
            vec![PathBuf::from("E:/packs/one"), PathBuf::from("E:/packs/two")]
        );
    }

    #[test]
    fn the_list_stops_at_the_next_key() {
        // `render:` below the list is not swallowed as a path.
        assert_eq!(parse_extra_pet_dirs(SETTINGS).len(), 2);
    }

    #[test]
    fn an_absent_key_yields_nothing() {
        assert!(parse_extra_pet_dirs("host:\n  default_pet: demo\n").is_empty());
    }

    #[test]
    fn an_empty_inline_list_yields_nothing() {
        assert!(parse_extra_pet_dirs("host:\n  pets_dirs: []\n").is_empty());
    }

    #[test]
    fn an_inline_list_is_read() {
        assert_eq!(
            parse_extra_pet_dirs("host:\n  pets_dirs: [\"E:/a\", E:/b]\n"),
            vec![PathBuf::from("E:/a"), PathBuf::from("E:/b")]
        );
    }

    #[test]
    fn a_malformed_list_is_tolerated_rather_than_fatal() {
        // The host still has to find the pets it ships with, so a bad line is skipped.
        assert!(parse_extra_pet_dirs("host:\n  pets_dirs: not-a-list\n").is_empty());
    }

    #[test]
    fn comments_and_blank_lines_inside_the_list_are_ignored() {
        let raw = "host:\n  pets_dirs:\n    # where packs live\n\n    - E:/a\n";
        assert_eq!(parse_extra_pet_dirs(raw), vec![PathBuf::from("E:/a")]);
    }

    #[test]
    fn a_quoted_entry_keeps_a_hash_inside_it() {
        assert_eq!(
            parse_list_item("    - \"E:/a#b\" # trailing note"),
            Some(PathBuf::from("E:/a#b"))
        );
    }

    #[test]
    fn a_bare_dash_is_not_a_path() {
        assert_eq!(parse_list_item("    -"), None);
    }

    #[test]
    fn a_package_is_found_under_any_root() {
        let dir = tempdir("find-any");
        let first = dir.join("empty");
        let second = dir.join("pets");
        fs::create_dir_all(first.join("demo")).unwrap();
        fs::create_dir_all(second.join("demo")).unwrap();
        fs::write(second.join("demo").join("pet.yaml"), "id: demo").unwrap();

        let roots = vec![first, second.clone()];
        assert_eq!(find_package_dir(&roots, "demo"), Some(second.join("demo")));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bare_directory_is_not_an_installed_package() {
        // Matches the rule the switch action enforces: `<id>/pet.yaml`, not `<id>/`.
        let dir = tempdir("bare");
        let pets = dir.join("pets");
        fs::create_dir_all(pets.join("demo")).unwrap();
        assert_eq!(find_package_dir(&[pets], "demo"), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_first_root_to_claim_an_id_keeps_it() {
        let dir = tempdir("first-wins");
        let bundled = dir.join("pets");
        let extra = dir.join("packs");
        fs::create_dir_all(bundled.join("demo")).unwrap();
        fs::create_dir_all(extra.join("demo")).unwrap();
        fs::write(bundled.join("demo").join("pet.yaml"), "id: bundled").unwrap();
        fs::write(extra.join("demo").join("pet.yaml"), "id: extra").unwrap();

        let scan = collect_pet_packages(&[bundled, extra]);
        assert_eq!(scan.packages.len(), 1);
        assert!(scan.packages[0].yaml.contains("bundled"));
        assert_eq!(scan.skipped.len(), 1);
        assert_eq!(scan.skipped[0].id, "demo");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_root_is_skipped_rather_than_fatal() {
        let dir = tempdir("missing-root");
        let real = dir.join("pets");
        fs::create_dir_all(real.join("demo")).unwrap();
        fs::write(real.join("demo").join("pet.yaml"), "id: demo").unwrap();

        let scan = collect_pet_packages(&[dir.join("not-there"), real.clone()]);
        assert_eq!(scan.packages.len(), 1);
        assert_eq!(scan.sources.get("demo"), Some(&real.join("demo")));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_without_a_manifest_is_not_a_package() {
        let dir = tempdir("no-manifest");
        let pets = dir.join("pets");
        fs::create_dir_all(pets.join("notes")).unwrap();
        assert!(collect_pet_packages(&[pets]).packages.is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_bundled_root_leads_and_repeats_are_collapsed() {
        let dir = tempdir("roots");
        let bundled = dir.join("pets");
        fs::create_dir_all(&bundled).unwrap();
        let extra = dir.join("packs");
        fs::create_dir_all(&extra).unwrap();

        let roots = pet_package_roots(&bundled, vec![extra.clone(), bundled.clone()]);
        assert_eq!(roots, vec![bundled.clone(), extra]);

        fs::remove_dir_all(&dir).ok();
    }

    fn tempdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-pets-{name}-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
