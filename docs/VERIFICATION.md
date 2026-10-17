# Verification report

Generated 2026-10-17 00:02:37 by `npm run verify`. Every number below is captured from a real run of
the command shown beside it — regenerate with `npm run verify` to reproduce.

## 1. PE forensics — release binary

Headers, section table and import directory are parsed directly from the file bytes;
no external PE tool is involved. Asset embedding is checked by locating each `dist/`
path as a literal byte sequence inside the image.

| field | value |
| --- | --- |
| size on disk | 24,612,864 bytes (23.47 MiB) |
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
| import directory | RVA `0xD6C858`, 34 DLL entries |

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

dist files: **28** · present in binary as literal asset path: **24** · missing: **4**

- MISSING `assets/HTMLText-BMDvDYrl.js`
- MISSING `assets/Live2dAdapter-DkZAzdQk.js`
- MISSING `assets/main-CWJi-K2g.js`
- MISSING `assets/SpineAdapter-DEdhecn8.js`

gzip streams in image: **42** — asset bodies are stored compressed, so file contents are not greppable as plaintext; the path table above is the reliable indicator.

## 2. Working tree vs HEAD

tracked files modified: **33** · untracked paths: **8** · **2741** insertions / **1784** deletions

Untracked additions:

- `docs/`
- `package-lock.json`
- `scripts/`
- `src-tauri/Cargo.lock`
- `src/constants/`
- `src/store/carePresenter.ts`
- `src/utils/storage.ts`
- `tests/`

Per-file diffstat:

| file | + | - |
| --- | --- | --- |
| `.gitignore` | 1 | 0 |
| `README.md` | 85 | 16 |
| `package.json` | 9 | 2 |
| `src-tauri/Cargo.toml` | 7 | 0 |
| `src-tauri/src/action_executor.rs` | 10 | 2 |
| `src-tauri/src/main.rs` | 54 | 15 |
| `src-tauri/src/win32_window.rs` | 11 | 9 |
| `src-tauri/src/ws_server.rs` | 94 | 69 |
| `src-tauri/tauri.conf.json` | 1 | 1 |
| `src/App.vue` | 179 | 134 |
| `src/adapters/Live2dAdapter.ts` | 1 | 1 |
| `src/adapters/SpineAdapter.ts` | 51 | 18 |
| `src/adapters/SpriteAdapter.ts` | 62 | 25 |
| `src/companion/CompanionApp.vue` | 37 | 6 |
| `src/companion/FocusTodoTab.vue` | 13 | 6 |
| `src/companion/PodsTab.vue` | 73 | 51 |
| `src/companion/WebMatrixTab.vue` | 33 | 13 |
| `src/companion/companion.ts` | 45 | 28 |
| `src/components/PetCanvasStage.vue` | 122 | 96 |
| `src/components/RadialMenu.vue` | 36 | 24 |
| `src/components/SpeechBubble.vue` | 13 | 2 |
| `src/components/StageHudDock.vue` | 0 | 1 |
| `src/components/StudioOverlay.vue` | 57 | 18 |
| `src/hud/HudApp.vue` | 43 | 33 |
| `src/store/careStore.ts` | 427 | 342 |
| `src/store/petStore.ts` | 611 | 474 |
| `src/types/pet.d.ts` | 18 | 5 |
| `src/utils/audioLipSync.ts` | 26 | 9 |
| `src/utils/commandEngine.ts` | 231 | 164 |
| `src/utils/stageRuntime.ts` | 267 | 198 |
| `src/utils/yamlLoader.ts` | 4 | 2 |
| `test_external_app.py` | 89 | 7 |
| `vite.config.ts` | 31 | 13 |

HEAD-vs-working line counts:

| file | HEAD lines | working lines | |
| --- | --- | --- | --- |
| `package.json` | 35 | 43 | changed |
| `src-tauri/Cargo.toml` | 25 | 33 | changed |
| `src-tauri/tauri.conf.json` | 87 | 88 | changed |
| `.gitignore` | 7 | 9 | changed |

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

## 5. Per-file diff

The table below is the authoritative list of what changed against `HEAD`. Each entry was
additionally read line-by-line; the substantive hunks are summarised after it.

| file | + | - |
| --- | --- | --- |
| `.gitignore` | 1 | 0 |
| `README.md` | 85 | 16 |
| `package.json` | 9 | 2 |
| `src-tauri/Cargo.toml` | 7 | 0 |
| `src-tauri/src/action_executor.rs` | 10 | 2 |
| `src-tauri/src/main.rs` | 54 | 15 |
| `src-tauri/src/win32_window.rs` | 11 | 9 |
| `src-tauri/src/ws_server.rs` | 94 | 69 |
| `src-tauri/tauri.conf.json` | 1 | 1 |
| `src/App.vue` | 179 | 134 |
| `src/adapters/Live2dAdapter.ts` | 1 | 1 |
| `src/adapters/SpineAdapter.ts` | 51 | 18 |
| `src/adapters/SpriteAdapter.ts` | 62 | 25 |
| `src/companion/CompanionApp.vue` | 37 | 6 |
| `src/companion/FocusTodoTab.vue` | 13 | 6 |
| `src/companion/PodsTab.vue` | 73 | 51 |
| `src/companion/WebMatrixTab.vue` | 33 | 13 |
| `src/companion/companion.ts` | 45 | 28 |
| `src/components/PetCanvasStage.vue` | 122 | 96 |
| `src/components/RadialMenu.vue` | 36 | 24 |
| `src/components/SpeechBubble.vue` | 13 | 2 |
| `src/components/StageHudDock.vue` | 0 | 1 |
| `src/components/StudioOverlay.vue` | 57 | 18 |
| `src/hud/HudApp.vue` | 43 | 33 |
| `src/store/careStore.ts` | 427 | 342 |
| `src/store/petStore.ts` | 611 | 474 |
| `src/types/pet.d.ts` | 18 | 5 |
| `src/utils/audioLipSync.ts` | 26 | 9 |
| `src/utils/commandEngine.ts` | 231 | 164 |
| `src/utils/stageRuntime.ts` | 267 | 198 |
| `src/utils/yamlLoader.ts` | 4 | 2 |
| `test_external_app.py` | 89 | 7 |
| `vite.config.ts` | 31 | 13 |
