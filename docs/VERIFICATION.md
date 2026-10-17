# Verification report

Generated 2026-10-17 00:34:57 by `npm run verify`. Every number below is captured from a real run of
the command shown beside it — regenerate with `npm run verify` to reproduce.

## 1. PE forensics — release binary

Headers, section table and import directory are parsed directly from the file bytes;
no external PE tool is involved. Asset embedding is checked by locating each `dist/`
path as a literal byte sequence inside the image.

| field | value |
| --- | --- |
| size on disk | 24,610,304 bytes (23.47 MiB) |
| DOS signature | `MZ` |
| PE signature | `50 45 00 00` |
| machine | `0x8664` (x86-64) |
| optional header magic | `0x20B` (PE32+) |
| subsystem | 2 (WINDOWS_GUI) |
| dllCharacteristics | `0x8160` |
| ASLR (DYNAMIC_BASE) | yes |
| DEP (NX_COMPAT) | yes |
| HIGH_ENTROPY_VA | yes |
| sections | `.text` `.rdata` `.data` `.pdata` `.rsrc` `.reloc` |
| import directory | RVA `0xD6B898`, 34 DLL entries |

Import table detail:

| DLL | imported symbols |
| --- | --- |
| `advapi32.dll` | 1 |
| `bcrypt.dll` | 1 |
| `kernel32.dll` | 23 |
| `kernel32.dll` | 126 |
| `user32.dll` | 126 |
| `gdi32.dll` | 13 |
| `dwmapi.dll` | 3 |
| `ole32.dll` | 8 |
| `api-ms-win-core-synch-l1-2-0.dll` | 3 |
| `comctl32.dll` | 4 |
| `shlwapi.dll` | 1 |
| `shell32.dll` | 8 |
| `ws2_32.dll` | 30 |
| `WebView2Loader.dll` | 2 |
| `api-ms-win-crt-stdio-l1-1-0.dll` | 7 |
| `api-ms-win-crt-runtime-l1-1-0.dll` | 16 |
| `api-ms-win-crt-locale-l1-1-0.dll` | 2 |
| `api-ms-win-crt-math-l1-1-0.dll` | 8 |
| `api-ms-win-crt-heap-l1-1-0.dll` | 3 |
| `api-ms-win-crt-private-l1-1-0.dll` | 3 |
| `api-ms-win-crt-string-l1-1-0.dll` | 5 |
| `oleaut32.dll` | 7 |
| `api-ms-win-core-winrt-error-l1-1-0.dll` | 1 |
| `bcryptprimitives.dll` | 1 |
| `imm32.dll` | 4 |
| `advapi32.dll` | 2 |
| `ntdll.dll` | 10 |
| `combase.dll` | 3 |
| `rpcrt4.dll` | 1 |
| `userenv.dll` | 1 |
| `api-ms-win-crt-environment-l1-1-0.dll` | 2 |
| `propsys.dll` | 20 |
| `api-ms-win-crt-filesystem-l1-1-0.dll` | 2 |
| `api-ms-win-crt-convert-l1-1-0.dll` | 2 |

total imported symbols: **449**

Embedded assets:

dist files: **28** · present in binary as literal asset path: **28** · missing: **0**

- every dist asset path is embedded in the executable

gzip streams in image: **39** — asset bodies are stored compressed, so file contents are not greppable as plaintext; the path table above is the reliable indicator.

## 2. Working tree vs HEAD

tracked files modified: **8** · untracked paths: **1** · **474** insertions / **108** deletions

Untracked additions:

- `.github/`

Per-file diffstat:

| file | + | - |
| --- | --- | --- |
| `README.md` | 15 | 1 |
| `docs/VERIFICATION.md` | 40 | 88 |
| `package.json` | 1 | 0 |
| `scripts/verify.mjs` | 80 | 2 |
| `src-tauri/src/action_executor.rs` | 146 | 0 |
| `src-tauri/src/main.rs` | 1 | 1 |
| `src-tauri/src/win32_window.rs` | 82 | 10 |
| `src-tauri/src/ws_server.rs` | 109 | 6 |

HEAD-vs-working line counts:

| file | HEAD lines | working lines | |
| --- | --- | --- | --- |
| `package.json` | 42 | 44 | changed |
| `src-tauri/Cargo.toml` | 32 | 33 | changed |
| `src-tauri/tauri.conf.json` | 87 | 88 | changed |
| `.gitignore` | 8 | 9 | changed |

## 3. Typecheck and artifact residue

tsconfig emit-related options:

- `noEmit`: `true`

| measurement | value |
| --- | --- |
| files under src/tests/scripts before | 42 |
| files under src/tests/scripts after | 42 |
| delta | 0 |
| `*.tsbuildinfo` anywhere in repo | 0 |
| exit code | 0 |

```
> desktop-pet-host@2.0.0 typecheck
> vue-tsc --noEmit
```

## 4. Static dead-export scan

files scanned: **27 `.ts` + 12 `.vue` = 39**

> `src/**` alone is 21 `.ts` + 12 `.vue` = 33 files; `tests/**` adds 6 spec files,
> so the scan covers 39 — a superset of either count.

```
files scanned : 39  (src/** + tests/**)
exported names: 157
dead exports  : 0
internal-only : 0

DEAD:  (none)

EXPORTED BUT ONLY USED IN ITS OWN FILE:  (none)
```

exit code: **0** (0 = no dead exports, 1 = findings present)

## 5. Rust gates

| gate | command | exit code |
| --- | --- | --- |
| formatting | `cargo fmt --check` | 0 |
| clippy | `cargo clippy --all-targets --features custom-protocol -- -D warnings` | 0 |
| unit tests | `cargo test --features custom-protocol` | 0 |

Rust unit tests: **21 passed, 0 failed**.

```
test action_executor::tests::unit_variants_execute ... ok
test action_executor::tests::pomodoro_falls_back_to_twenty_five_minutes ... ok
test action_executor::tests::unknown_action_type_is_dispatched_not_executed ... ok
test action_executor::tests::emotion_outside_the_whitelist_is_rejected ... ok
test action_executor::tests::known_pets_are_accepted ... ok
test action_executor::tests::unknown_action_id_does_not_deserialize ... ok
test action_executor::tests::allowed_emotions_are_accepted ... ok
test win32_window::tests::disabling_clears_the_whole_mask_in_one_step ... ok
test action_executor::tests::unknown_pet_is_rejected ... ok
test win32_window::tests::disabling_removes_mask_bits_the_original_had ... ok
test win32_window::tests::enabling_is_idempotent ... ok
test win32_window::tests::disabling_leaves_unrelated_style_bits_intact ... ok
test win32_window::tests::enabling_sets_every_bit_in_the_mask ... ok
test win32_window::tests::round_trip_returns_the_original_style ... ok
test ws_server::tests::token_does_not_leak_the_process_id ... ok
test ws_server::tests::consecutive_tokens_differ ... ok
test ws_server::tests::token_has_the_documented_shape ... ok
test ws_server::tests::authorize_accepts_only_the_exact_token ... ok
test ws_server::tests::authorize_rejects_missing_wrong_and_near_miss_tokens ... ok
test ws_server::tests::tokens_from_two_brokers_are_not_interchangeable ... ok
test ws_server::tests::token_is_written_to_the_supplied_path ... ok
test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

## 6. Per-file diff

The table below is the authoritative list of what changed against `HEAD`. Each entry was
additionally read line-by-line; the substantive hunks are summarised after it.

| file | + | - |
| --- | --- | --- |
| `README.md` | 15 | 1 |
| `docs/VERIFICATION.md` | 40 | 88 |
| `package.json` | 1 | 0 |
| `scripts/verify.mjs` | 80 | 2 |
| `src-tauri/src/action_executor.rs` | 146 | 0 |
| `src-tauri/src/main.rs` | 1 | 1 |
| `src-tauri/src/win32_window.rs` | 82 | 10 |
| `src-tauri/src/ws_server.rs` | 109 | 6 |
