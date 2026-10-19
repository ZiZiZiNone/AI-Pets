# Verification report

Generated 2026-10-19 17:46:02 by `npm run verify`. Every number below is captured from a real run of
the command shown beside it — regenerate with `npm run verify` to reproduce.

## 1. PE forensics — release binary

Headers, section table and import directory are parsed directly from the file bytes;
no external PE tool is involved. Asset embedding is checked by locating each `dist/`
path as a literal byte sequence inside the image.

| field | value |
| --- | --- |
| size on disk | 34,012,655 bytes (32.44 MiB) |
| DOS signature | `MZ` |
| PE signature | `50 45 00 00` |
| machine | `0x8664` (x86-64) |
| optional header magic | `0x20B` (PE32+) |
| subsystem | 2 (WINDOWS_GUI) |
| dllCharacteristics | `0x160` |
| ASLR (DYNAMIC_BASE) | yes |
| DEP (NX_COMPAT) | yes |
| HIGH_ENTROPY_VA | yes |
| sections | `.text` `.data` `.rdata` `.pdata` `.xdata` `.bss` `.idata` `.tls` `.rsrc` `.reloc` |
| import directory | RVA `0x1722000`, 39 DLL entries |

Import table detail:

| DLL | imported symbols |
| --- | --- |
| `advapi32.dll` | 1 |
| `bcrypt.dll` | 1 |
| `kernel32.dll` | 91 |
| `ntdll.dll` | 4 |
| `userenv.dll` | 1 |
| `ws2_32.dll` | 5 |
| `WebView2Loader.dll` | 2 |
| `bcryptprimitives.dll` | 1 |
| `kernel32.dll` | 5 |
| `advapi32.dll` | 1 |
| `api-ms-win-core-synch-l1-2-0.dll` | 1 |
| `api-ms-win-core-winrt-error-l1-1-0.dll` | 1 |
| `combase.dll` | 2 |
| `comctl32.dll` | 4 |
| `dwmapi.dll` | 3 |
| `gdi32.dll` | 13 |
| `imm32.dll` | 4 |
| `kernel32.dll` | 20 |
| `ntdll.dll` | 1 |
| `ole32.dll` | 8 |
| `oleaut32.dll` | 6 |
| `propsys.dll` | 20 |
| `shell32.dll` | 8 |
| `shlwapi.dll` | 1 |
| `user32.dll` | 126 |
| `combase.dll` | 1 |
| `kernel32.dll` | 1 |
| `rpcrt4.dll` | 1 |
| `kernel32.dll` | 1 |
| `oleaut32.dll` | 1 |
| `kernel32.dll` | 22 |
| `ntdll.dll` | 3 |
| `ws2_32.dll` | 25 |
| `advapi32.dll` | 1 |
| `ntdll.dll` | 1 |
| `KERNEL32.dll` | 9 |
| `msvcrt.dll` | 34 |
| `ntdll.dll` | 1 |
| `api-ms-win-core-synch-l1-2-0.dll` | 2 |

total imported symbols: **433**

Embedded assets:

dist files: **58** · present in binary as literal asset path: **58** · missing: **0**

- every dist asset path is embedded in the executable

binary freshness: the executable is newer than all 58 `dist/` files (linked 2026-10-19 17:42:18), so the path table describes this bundle.

gzip streams in image: **109** — asset bodies are stored compressed, so file contents are not greppable as plaintext; the path table above is the reliable indicator.

## 2. Working tree vs HEAD

tracked files modified: **0** · untracked paths: **0** · **0** insertions / **0** deletions

Untracked additions:



Per-file diffstat:

| file | + | - |
| --- | --- | --- |


HEAD-vs-working line counts:

| file | HEAD lines | working lines | |
| --- | --- | --- | --- |
| `package.json` | 47 | 47 | identical |
| `src-tauri/Cargo.toml` | 35 | 35 | identical |
| `src-tauri/tauri.conf.json` | 87 | 87 | identical |
| `.gitignore` | 10 | 10 | identical |

## 3. Typecheck and artifact residue

tsconfig emit-related options:

- `noEmit`: `true`

| measurement | value |
| --- | --- |
| files under src/tests/scripts before | 71 |
| files under src/tests/scripts after | 71 |
| delta | 0 |
| `*.tsbuildinfo` anywhere in repo | 0 |
| exit code | 0 |

```
> ai-pets@2.0.1 typecheck
> vue-tsc --noEmit --noUnusedLocals --noUnusedParameters
```

## 4. Static dead-export scan

files scanned: **50 `.ts` + 14 `.vue` = 64**

> `src/**` alone is 32 `.ts` + 14 `.vue` = 46 files;
> `tests/**` adds 18 spec files, so the scan covers 64
> — a superset of either count.

```
files scanned : 64  (src/** + tests/**)
exported names: 253
dead exports  : 0
internal-only : 0

DEAD:  (none)

EXPORTED BUT ONLY USED IN ITS OWN FILE:  (none)
```

exit code: **0** (0 = no dead exports, 1 = findings present)

## 5. Import-cycle scan

A cycle is the only coupling defect no type checker reports: every module resolves and
every signature matches. The scan classifies each cycle by whether a back-edge survives
to the emitted JS. A value cycle fails the build; a cycle whose back-edges are all
`import type` is erased by TypeScript and is reported for review only.

```
modules scanned   : 64  (src/** + tests/**)
edges resolved    : 194
value cycles      : 0
type-only cycles  : 1
unresolved imports: 0

VALUE CYCLES (runtime-breaking):
  (none)

TYPE-ONLY CYCLES (erased at compile time, reported only):
  src/store/petStore.ts -> src/utils/commandEngine.ts -> src/utils/stageRuntime.ts
```

exit code: **0** (0 = no value cycles) — 1 type-only cycle(s) recorded and accepted.

## 6. Rust gates

| gate | command | exit code |
| --- | --- | --- |
| formatting | `cargo fmt --check` | 0 |
| clippy | `cargo clippy --all-targets --features custom-protocol -- -D warnings` | 0 |
| unit tests | `cargo test --features custom-protocol` | 0 |

Rust unit tests: **106 passed, 0 failed**.

```
test action_executor::tests::a_panel_missing_the_source_its_mode_needs_is_refused_before_anything_opens ... ok
test action_executor::tests::a_panel_action_without_a_mode_defaults_to_schema ... ok
test action_executor::tests::a_panel_action_carries_its_schema_across_the_boundary ... ok
test action_executor::tests::a_panel_host_failure_is_reported_rather_than_swallowed ... ok
test action_executor::tests::a_url_panel_carries_its_url ... ok
test action_executor::tests::an_over_long_pet_id_is_refused_by_shape_not_by_length_of_a_list ... ok
test action_executor::tests::an_unrecognised_panel_mode_is_not_forwarded_as_written ... ok
test action_executor::tests::a_missing_pets_root_refuses_every_switch_instead_of_succeeding_blindly ... ok
test action_executor::tests::emotion_outside_the_whitelist_is_rejected ... ok
test action_executor::tests::pomodoro_falls_back_to_twenty_five_minutes ... ok
test action_executor::tests::allowed_emotions_are_accepted ... ok
test action_executor::tests::a_file_masquerading_as_a_pet_folder_does_not_satisfy_the_switch ... ok
test action_executor::tests::unknown_action_type_is_dispatched_not_executed ... ok
test action_executor::tests::unknown_action_id_does_not_deserialize ... ok
test action_executor::tests::a_folder_without_a_manifest_is_not_a_switchable_pet ... ok
test action_executor::tests::the_rejection_message_escapes_control_characters ... ok
test action_executor::tests::the_unknown_pet_message_names_the_directory_that_was_searched ... ok
test action_executor::tests::unit_variants_execute ... ok
test engine_runner::tests::a_non_base64_payload_is_rejected ... ok
test action_executor::tests::a_well_shaped_id_with_no_folder_is_refused_with_its_name ... ok
test engine_runner::tests::a_glob_matching_nothing_names_the_directory_it_looked_in ... ok
test action_executor::tests::unknown_pet_is_rejected ... ok
test engine_runner::tests::an_empty_executable_path_is_rejected_before_spawning ... ok
test action_executor::tests::a_traversal_attempt_cannot_reach_a_sibling_of_the_pets_root ... ok
test engine_runner::tests::an_illegal_capture_extension_is_rejected ... ok
test engine_runner::tests::a_missing_executable_is_a_readable_error ... ok
test engine_runner::tests::a_flag_prefixed_glob_resolves_against_the_value_not_the_whole_argument ... ok
test action_executor::tests::a_pet_added_as_a_folder_is_switched_to_without_a_code_change ... ok
test engine_runner::tests::a_model_glob_resolves_to_the_first_file_in_name_order ... ok
test engine_runner::tests::a_model_glob_never_matches_a_directory ... ok
test engine_runner::tests::capturing_output_without_a_placeholder_is_rejected ... ok
test action_executor::tests::installed_pets_are_accepted ... ok
test engine_runner::tests::extension_sanitising_accepts_the_forms_configs_actually_use ... ok
test engine_runner::tests::mime_types_cover_the_formats_speech_endpoints_return ... ok
test engine_runner::tests::captures_stderr_separately ... ok
test engine_runner::tests::an_engine_that_writes_nothing_is_a_failure_not_silent_success ... ok
test engine_runner::tests::an_input_placeholder_written_on_disk_is_deleted_after_the_run ... ok
test engine_runner::tests::oversized_stdin_is_rejected ... ok
test engine_runner::tests::placeholder_substitution_touches_only_the_placeholder ... ok
test engine_runner::tests::captures_stdout_and_reports_success ... ok
test engine_runner::tests::text_containing_a_star_is_not_treated_as_a_path_pattern ... ok
test engine_runner::tests::an_input_payload_becomes_a_readable_file_at_the_placeholder ... ok
test engine_runner::tests::oversized_audio_payload_is_rejected ... ok
test pet_packages::tests::a_bare_dash_is_not_a_path ... ok
test pet_packages::tests::a_bare_directory_is_not_an_installed_package ... ok
test pet_packages::tests::a_block_sequence_is_read_in_order ... ok
test pet_packages::tests::a_folder_without_a_manifest_is_not_a_package ... ok
test pet_packages::tests::a_malformed_list_is_tolerated_rather_than_fatal ... ok
test pet_packages::tests::a_missing_root_is_skipped_rather_than_fatal ... ok
test engine_runner::tests::empty_output_still_returns_a_result ... ok
test pet_packages::tests::a_quoted_entry_keeps_a_hash_inside_it ... ok
test pet_packages::tests::an_absent_key_yields_nothing ... ok
test pet_packages::tests::an_empty_inline_list_yields_nothing ... ok
test pet_packages::tests::an_inline_list_is_read ... ok
test pet_packages::tests::comments_and_blank_lines_inside_the_list_are_ignored ... ok
test engine_runner::tests::no_shell_means_metacharacters_are_not_interpreted ... ok
test pet_packages::tests::a_package_is_found_under_any_root ... ok
test pet_packages::tests::the_list_stops_at_the_next_key ... ok
test pet_packages::tests::the_bundled_root_leads_and_repeats_are_collapsed ... ok
test tests::a_bundled_resource_is_looked_for_under_the_up_prefix ... ok
test tests::a_very_large_reading_is_not_truncated ... ok
test tests::candidate_locations_are_tried_in_the_documented_order ... ok
test tests::escaped_quotes_are_treated_as_one ... ok
test tests::memory_handles_values_without_a_thousands_separator ... ok
test tests::memory_is_read_from_the_real_tasklist_format ... ok
test tests::missing_field_returns_none ... ok
test tests::quoted_field_containing_a_comma_stays_intact ... ok
test tests::sub_megabyte_readings_round_up_to_one ... ok
test tests::unparsable_output_yields_none_rather_than_a_placeholder ... ok
test tests::without_an_executable_directory_only_relative_locations_remain ... ok
test win32_window::tests::disabling_clears_the_whole_mask_in_one_step ... ok
test win32_window::tests::disabling_leaves_unrelated_style_bits_intact ... ok
test win32_window::tests::disabling_removes_mask_bits_the_original_had ... ok
test win32_window::tests::enabling_is_idempotent ... ok
test win32_window::tests::enabling_sets_every_bit_in_the_mask ... ok
test win32_window::tests::round_trip_returns_the_original_style ... ok
test ws_server::tests::a_disconnect_releases_only_the_connection_that_held_the_lease ... ok
test ws_server::tests::a_claim_installs_the_holder_and_reports_the_change_once ... ok
test ws_server::tests::a_header_that_is_not_visible_ascii_is_not_trusted ... ok
test ws_server::tests::a_host_that_merely_starts_with_an_allowed_one_is_rejected ... ok
test ws_server::tests::a_later_claim_displaces_the_earlier_driver ... ok
test engine_runner::tests::non_zero_exit_is_reported_not_swallowed ... ok
test ws_server::tests::a_token_that_cannot_be_written_beside_the_working_directory_moves_on ... ok
test engine_runner::tests::stdin_is_delivered_and_closed ... ok
test ws_server::tests::consecutive_tokens_differ ... ok
test engine_runner::tests::timeout_is_clamped_to_the_ceiling ... ok
test engine_runner::tests::a_large_stdout_does_not_deadlock ... ok
test ws_server::tests::origins_outside_the_declared_set_are_rejected ... ok
test ws_server::tests::the_declared_origins_are_allowed ... ok
test ws_server::tests::an_unwritable_candidate_is_absent_from_the_owned_list ... ok
test ws_server::tests::token_does_not_leak_the_process_id ... ok
test ws_server::tests::token_has_the_documented_shape ... ok
test ws_server::tests::authorize_accepts_only_the_exact_token ... ok
test ws_server::tests::only_the_holder_can_release_the_lease ... ok
test ws_server::tests::authorize_rejects_missing_wrong_and_near_miss_tokens ... ok
test ws_server::tests::no_writable_candidate_leaves_the_token_unplaced ... ok
test ws_server::tests::userinfo_cannot_masquerade_as_a_local_host ... ok
test ws_server::tests::tokens_from_two_brokers_are_not_interchangeable ... ok
test pet_packages::tests::the_first_root_to_claim_an_id_keeps_it ... ok
test ws_server::tests::token_is_written_to_the_supplied_path ... ok
test engine_runner::tests::a_shared_temp_path_is_not_reused_between_calls ... ok
test ws_server::tests::the_token_is_written_to_every_writable_candidate_not_just_the_first ... ok
test engine_runner::tests::the_captured_output_file_is_returned_as_base64 ... ok
test engine_runner::tests::a_timed_out_engine_leaves_nothing_holding_its_pipes ... ok
test engine_runner::tests::an_overrunning_engine_is_killed_not_waited_on ... ok
test engine_runner::tests::output_collection_does_not_outlive_a_pipe_held_by_a_grandchild ... ok
test result: ok. 106 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.83s
```

## 7. Per-file diff

The table below is the authoritative list of what changed against `HEAD`. Each entry was
additionally read line-by-line; the substantive hunks are summarised after it.

| file | + | - |
| --- | --- | --- |

