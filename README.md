# AI-Pets

基于 Tauri v2、Vue 3、TypeScript、PixiJS 与 Three.js 的桌面宠物宿主，支持 2D 矢量/序列帧、Live2D、Spine 与 VRM 渲染，并提供带令牌鉴权的本地 WebSocket 热插拔总线。

面向使用者的说明（安装、界面、托盘菜单、伴生面板、常见问题）见
[`docs/使用说明书.md`](docs/使用说明书.md)；下面这份是给开发者看的。

**想加一只自己的宠物？** 见 [`docs/宠物接入指南.md`](docs/宠物接入指南.md)。
一只宠物就是 `pets/` 下的一个文件夹（`pet.yaml` + 资源），配色、感应区、台词、菜单、拖拽响应全部写在清单里，
**不需要改任何源码**，保存即热重载。

仓库自带 **273 只**宠物，每只一个文件夹，删掉哪个文件夹就少哪只，同样不用改配置。
名录见 [`docs/宠物名录.md`](docs/宠物名录.md)。

**想换语音方案或大模型？** 语音三档（系统 Web Speech / OpenAI 兼容接口 / 本地命令行引擎）
与三种 LLM 协议（OpenAI 兼容 / Anthropic / Ollama）全部由 `config/settings.yaml` 驱动，
每只宠物还能用自己的 `voice:` 与 `persona:` 覆盖宿主默认值——同样**不需要改源码**。
想完全离线，仓库带了一个把引擎与中文模型一次装好的脚本：

```bash
python scripts/fetch_local_voice_engine.py --dest E:/AI/sherpa-onnx
```

它会顺带跑一次「合成 → 识别」闭环自检，并把填好绝对路径的配置片段打印出来。

## 直接下载安装包（推荐）

不想在本机安装 Rust 与 MSVC 工具链，就用 GitHub Actions 构建好的安装包：

1. 打开 [Releases 页面](https://github.com/ZiZiZiNone/AI-Pets/releases)，下载最新版本的
   `AI-Pets_*_x64-setup.exe`
2. 双击安装
3. 启动后托盘出现图标，桌宠出现在当前显示器右下角

两个安装包的区别：

| 文件 | 安装范围 | 管理员权限 |
| --- | --- | --- |
| `AI-Pets_*_x64-setup.exe`（NSIS） | 当前用户，装到 `%LOCALAPPDATA%` | **不需要，普通用户选这个** |
| `AI-Pets_*_x64_en-US.msi`（MSI） | 全机（per-machine） | 需要提权；`msiexec /qn` 返回 `1603` / `Error 1925` 属预期 |

这些安装包由 [Release 工作流](.github/workflows/release.yml) 在 GitHub 的 windows runner 上构建。
该 runner 预装 MSVC Build Tools，因此这里产出的就是「标准构建」，也是别人最省事的获取途径。
想自己复现或改代码，见下面「从零启动」。

## 从零启动（Windows）

### 前置条件

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 22 或更高 | `.nvmrc` 与 `package.json` 的 `engines` 都锁定在 22，与 CI 一致 |
| [Rust](https://rustup.rs/) | `stable` | 由仓库根目录的 `rust-toolchain.toml` 固定，`clippy` 与 `rustfmt` 会随工具链自动装好 |
| [MSVC Build Tools](https://visualstudio.microsoft.com/downloads/) | 含「使用 C++ 的桌面开发」 | **走 MSVC 路线时链接 Rust 程序必需**（Visual Studio 社区版即可，不必装完整 IDE） |

也可以选 GNU 路线——**没有 MSVC Build Tools 的机器必须走这条**。仓库根的
`rust-toolchain.toml` 钉的是 `stable`，在 Windows 上会解析成 `-msvc`，所以要么显式指定
工具链、要么把目标定成 gnu；两者都能覆盖它。

```bash
rustup toolchain install stable-x86_64-pc-windows-gnu   # 若还没装
cargo +stable-x86_64-pc-windows-gnu test --manifest-path src-tauri/Cargo.toml
cargo +stable-x86_64-pc-windows-gnu build --release --features custom-protocol --manifest-path src-tauri/Cargo.toml
```

`npm run verify` 内部调的是 `cargo`，**不带 `+工具链`**，所以走 GNU 路线时要用环境变量
把它一起切过去，否则它会按 `rust-toolchain.toml` 解析出 `-msvc` 然后卡在链接上：

```powershell
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = '<MinGW>\bin\gcc.exe'
$env:PATH = '<MinGW>\bin;' + $env:PATH
npm.cmd run verify
```

需要一份 MinGW-w64 的 `gcc` / `dlltool` / `ar` 在 `PATH` 上。两条都验证过的最小做法：

- **便携 MSYS2**：解压一份 MSYS2 到任意盘，用 `pacman` 装 `mingw-w64-x86_64-gcc`，
  再把 `mingw64/bin` 加进 `PATH`（本机实测版本 `gcc 16.2.0`）。
- **`skeeto/w64devkit`**：单 zip、解压即用，`gcc`/`dlltool`/`ar`/`ld` 都在里面。

把 `CARGO_HOME` / `RUSTUP_HOME` / `CARGO_TARGET_DIR` 指到数据盘可以避免吃系统盘，
例如：`$env:CARGO_TARGET_DIR = 'E:\AI\AI-Pets-target'`。

CI 走的是 MSVC 路线（`dtolnay/rust-toolchain@stable`），也是最省事的默认选择。
若你的机器上 `cargo` 报 ``linker `link.exe` not found``，那就是缺 MSVC Build Tools：
装上即可，或按上面切到 GNU 路线。

### 四步跑起来

```bash
npm ci            # package-lock.json 已提交，npm ci 可复现，且会在锁文件漂移时报错
npm run build     # 类型检查 + 死导出扫描 + 导入环检测 + 生产构建
npm run tauri dev # 启动桌面宿主
```

只想跑前端的话，`npm ci` 之后 `npm run dev`（浏览器预览）、`npm test`、
`npm run typecheck` 都能用——这三项**只需要 Node，不需要 Rust**。

### 验证环境是否就绪

```bash
npm run scan:dead && npm run scan:cycles   # 两个门禁，发现冗余即非零退出
npm test                                    # 前端单测
npm run test:rust                           # Rust 单测
cargo fmt --manifest-path src-tauri/Cargo.toml --check
python test_external_app.py --selftest      # 总线协议离线自检，无需启动宿主
python scripts/runtime-smoke.py             # 启动已构建的二进制探测真实 WebView2（会自行关闭）
```

`runtime-smoke.py` 是唯一会真正运行程序的检查：它带 `--remote-debugging-port` 启动
`src-tauri/target/release/ai-pets.exe`，用 DevTools 协议问每个页面「你的环境里有哪些 API」、
「识别入口现在显示什么」，从页面内部点开径向菜单并读回它自己的控制台日志，
再连上进程内的 WebSocket 总线做一次 `switch_pet` 往返，最后按进程树关掉它自己启动的宿主。

能力与文案部分只如实报告；**有三处是判定**，不满足则退出码 1：未安装的宠物 id 必须回
`status: error` 并点出那个 id（旧的假成功会回 `ok`），已安装的必须回 `status: ok`；
页面内的控制台钩子必须先收到它自己打的那一行——否则「一条日志都没有」会被误读成
「应用什么都没说」；以及**按住超过 `long_press_ms` 再松手必须仍然生效**：判定用同一条目的
普通点击做对照（那条动作不说话就跳过而不是判失败），因为出厂默认下 `long_press` 什么都没绑，
长按本身不做任何事，把松手那次 click 也吃掉就会让「按得稍微久一点」变成彻底没反应。
它不接入 `npm run verify`，因为取证工具应当是只读的，而它会启动一个 GUI 进程。

### 打包成安装包

```bash
npm run tauri build
```

首次运行会联网下载 WiX 与 NSIS 工具链（约 45 MB，缓存到 `%LOCALAPPDATA%\tauri`），
网络中断后重跑即可续用已缓存部分。产物是 MSI 与 NSIS 两个包，两者的安装范围差异见
[`docs/使用说明书.md`](docs/使用说明书.md) 第 2 节。打包出的程序在目标机器上需要
**WebView2 Runtime**（Windows 11 与较新的 Windows 10 已预装）。

### 新克隆机器上容易踩的坑

- `cargo fmt` / `cargo clippy` 报 component not installed —— `rust-toolchain.toml`
  通常会自动装好；仍报错就手动执行 `rustup component add clippy rustfmt`。
- 打包后打开是白屏 —— 二进制没带 `custom-protocol` 特性，见下文 `cargo build --release` 的说明。
- `msiexec` 返回 `1603` / `Error 1925` —— MSI 是 per-machine 包需要提权，属预期；
  给普通用户分发请指向 NSIS 包。
- 端口被占用导致外部程序连不上 —— 改 `config/settings.yaml` 的 `host.ws_port_range` 后重启宿主。

## 目录结构

```text
AI-Pets/
├── config/                       # 宿主全局配置（YAML，支持热重载）
│   ├── settings.yaml
│   └── global_menu.yaml
├── pets/                         # 宠物包：每只一个文件夹，pet.yaml + 资源（热重载，无需改代码）
├── src/
│   ├── constants/
│   │   ├── messages.ts           # 全部面向用户的文案（单一来源）
│   │   └── timing.ts             # 全部时长/间隔/几何常量（单一来源）
│   ├── store/
│   │   ├── carePresenter.ts      # 养成域回报舞台的窄接口（依赖倒置）
│   │   ├── careStore.ts          # 养成与番茄钟领域状态
│   │   ├── petStore.ts           # 舞台状态、动作队列与跨窗口同步
│   │   └── themes.ts             # 内置默认配色 + pet.yaml theme 的解析与合并（无按 id 的注册表）
│   ├── adapters/                 # 渲染适配器 (IPetAdapter / Sprite / Live2D / Spine / VRM)
│   ├── components/               # 主舞台、语音气泡、星盘菜单、状态坞、蓝图微调舱
│   ├── companion/                # 伴生控制台窗口（突触舱、专注待办、网页与 LLM 脑桥）
│   ├── hud/                      # 全屏物理鼠标穿透标注层窗口
│   ├── utils/                    # YAML、指令引擎、舞台运行时、Web Audio 口型、存储
│   │   ├── engineBridge.ts       # 调 Rust 的通用外部引擎执行器（argv 模板、base64 编解码）
│   │   ├── voiceEngine.ts        # 合成/识别三条通路的统一出口
│   │   ├── voiceProviders.ts     # 语音方式的元数据与「未就绪」原因
│   │   ├── audioCapture.ts       # 麦克风录音成 16kHz 单声道 wav、失败原因中文化
│   │   ├── llmProviders.ts       # 三种 LLM 协议的请求体与响应解析
│   │   ├── proceduralMotion.ts   # 静图上的呼吸与重心摆动（纯函数，可单测）
│   │   └── petPersona.ts         # 由 pet.yaml 的 persona 组装系统提示词
│   └── types/                    # TypeScript 类型声明
├── src-tauri/
│   ├── capabilities/
│   └── src/
│       ├── main.rs               # Tauri 入口、IPC 指令集、系统托盘与配置监听
│       ├── win32_window.rs       # 无焦点拦截、30Hz 穿透轮询、窗口吸附与贴边探头
│       ├── ws_server.rs          # 本地 WebSocket 总线（令牌鉴权、心跳、热插拔）
│       ├── engine_runner.rs      # 通用外部引擎执行器（argv 模板、超时、有界排空）
│       ├── action_executor.rs    # 白名单动作与外部命令执行器
│       └── pet_packages.rs       # 宠物包扫描：自带目录优先，外部目录由配置追加
├── tests/                        # Vitest 单元测试
├── scripts/
│   ├── dead-code-scan.mjs        # 死导出扫描（已接入 npm run build）
│   ├── cycle-scan.mjs            # 导入环检测（已接入 npm run build）
│   ├── verify.mjs                # 发布前取证（生成 docs/VERIFICATION.md）
│   ├── runtime-smoke.py          # 运行真实宿主并探测 WebView2 与页面文案
│   └── fetch_local_voice_engine.py  # 下载本地 TTS/STT 引擎与模型并跑闭环自检
├── docs/
│   ├── 宠物接入指南.md            # 如何新增/替换自己的宠物（不需要改源码）
│   ├── 宠物名录.md                # 内置 273 只宠物的名录（短名、简介、人设）
│   ├── 使用说明书.md              # 面向使用者的完整说明
│   ├── VERIFICATION.md           # 验证报告（npm run verify 生成）
│   └── standalone-release.png    # 脱离 dev server 的运行效果
└── test_external_app.py          # Python 标准库 WebSocket 联调脚本
```

## 开发命令

```bash
npm install         # 安装依赖
npm run dev         # 仅前端预览（浏览器）
npm run typecheck   # vue-tsc 静态检查
npm test            # Vitest 单元测试（前端）
npm run test:rust   # cargo test（令牌、鉴权闸门、动作白名单、Win32 标志位）
npm run scan:dead   # 死导出扫描（src/** + tests/**，发现冗余即退出码 1）
npm run scan:cycles # 导入环检测（值环退出码 1，类型环仅报告）
npm run verify      # 发布前取证（七项）：PE 取证 / git 比对 / 残留 / 死导出 / 导入环 / Rust 门禁 / diff
python scripts/runtime-smoke.py  # 启动真实宿主，探测 WebView2 能力与识别入口文案（会自行关闭）
npm run build       # 类型检查 + 死导出扫描 + 导入环检测 + 生产构建
npm run tauri dev   # 启动桌面宿主（开发，连接 Vite dev server）
npm run tauri build # 打包安装程序（需要 Rust 与 MSVC 工具链）
```

Rust 侧另有两个门禁，与 CI 使用同一条命令：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features custom-protocol -- -D warnings
```

`scan:dead` 统计每个导出符号在 `src/**` 与 `tests/**` 中的真实引用（剥离 import/export
说明语句与注释后按词边界计数），报告两类冗余：**完全没有引用的死导出**，以及
**只在自身文件内被使用、本不该 export 的符号**。它已接入 `npm run build`，
因此新增冗余导出会让构建直接失败。

`scan:cycles` 解析每个模块的 import/export-from 说明符（含多行形式与 Vue `<script>` 块），
经 `@/` 别名与相对路径落到文件后跑 Tarjan 求强连通分量，并按**回边是否活到产物 JS** 分类：

- **值环**——有真实绑定闭合回路，运行时可能撞上半初始化的模块，退出码 1，阻断构建。
- **类型环**——回边全是 `import type`，被 TypeScript 擦除，仅列出供复核，不阻断。

`verify` 会重新采集七项发布前证据并覆写 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)：
直接解析 release 二进制的 PE 头/节表/导入表并逐个核对内嵌资源路径、对照 `HEAD` 的
工作树差异、`vue-tsc` 前后的产物残留、死导出统计、导入环分类、`cargo fmt`/`clippy`/单测
三项 Rust 门禁、以及逐文件 diff 清单。报告中每个数字都来自当次真实运行，可用同一条命令复现。

若直接用 `cargo build --release`，必须带上 `custom-protocol` 特性，否则窗口会指向
Vite dev server，脱离开发环境后白屏：

```bash
cargo build --release --features custom-protocol
```

`npm run tauri build` 按 `bundle.targets: "all"` 同时产出 MSI 与 NSIS 两个安装包：

```text
src-tauri/target/release/bundle/
├── msi/AI-Pets_2.0.1_x64_en-US.msi
└── nsis/AI-Pets_2.0.1_x64-setup.exe
```

首次运行会由 Tauri 自动下载 WiX 与 NSIS 工具链（约 45 MB，缓存在
`%LOCALAPPDATA%\tauri`）；网络中断会导致打包失败，重跑即可续用已缓存的部分。

**两个安装包的安装范围不同**：NSIS 默认按当前用户安装到 `%LOCALAPPDATA%`，无需管理员
权限；MSI 由 Tauri 的 WiX 打包器固定生成 per-machine 包，安装时需要提权
（`msiexec /i ... /qn` 返回 1603 / Error 1925 属预期）。这不是可配置项——当前 Tauri
版本的 `WixConfig` 并未暴露 `installMode`，只有 `NsisConfig` 有。给不需要管理员权限的
用户分发时，请指向 NSIS 包。

带 `custom-protocol` 构建出的二进制自带前端资源，可在关闭 Vite dev server 的情况下独立运行：

![宿主在无 dev server 环境下的独立运行效果](docs/standalone-release.png)

## 架构约定

- **常量与文案单一来源**：所有时长、几何与用户可见字符串分别位于 `src/constants/timing.ts` 与 `src/constants/messages.ts`，避免同一含义在多处漂移。
- **领域层不依赖展示层**：`careStore` 通过 `CarePresenter` 窄接口回报舞台，而不感知 `petStore`。
- **无模块级可变状态**：定时器、总线绑定等状态都归属具体 store 实例，不会跨窗口串扰。
- **适配器单一契约**：所有渲染后端实现 `IPetAdapter`，由 `AdapterFactory` 按需动态加载。
- **WebSocket 总线全量鉴权**：每条入站消息（含热插拔方法）都必须携带进程令牌，令牌由操作系统随机源派生；握手另按解析后的主机名校验 `Origin`。
- **状态锁不跨越窗口层**：状态锁只在变更与取快照期间持有，`emit` 与 Win32 窗口调用一律在锁外，避免与运行托盘处理器的事件循环互相等待。
- **窗口只隐藏不销毁**：三个窗口都是可反复显隐的表面，关闭请求被转成隐藏。窗口按 label 查找，销毁后再也找不到，会让桌宠或面板在整个会话内不可恢复；退出由托盘菜单调用 `AppHandle::exit` 完成，不经过关闭事件。
- **外部引擎不经 shell**：`engine_runner` 按 argv 数组直接起进程，占位符由宿主填成自己管理的临时文件路径，`*` 只按名序取第一个匹配文件，命令行元字符不会被解释；超时走进程树终止，管道排空有上界，不会因为孙进程握着管道而挂住。
- **宠物 id 按「形状 + 是否装得上」两步校验**：`switch_pet` 从硬编码白名单改成先查形状（非空、≤64 字符、只含字母数字与 `_` `-`），再查宿主解析到的包目录下有没有同名目录。丢进 `pets/` 的新宠物不需要改 Rust 就能被外部程序切到；分隔符、`.`、`..` 与控制字符仍然被拒；形状合法但目录不存在时回复 `Unknown pet_id '<id>': no pet folder named that under <搜索到的全部路径>`，而不是回一个假的成功。
- **宠物包目录是配置，不是源码树**：`host.pets_dirs` 可以再声明若干任意外部目录，每个 `<id>/pet.yaml` 同样算一个包；自带 `pets/` 排在前面先到先得，从外部加载的宠物保存时写回原处，热重载的监听列表随配置增减。默认留空——全新安装不配置任何东西也照常工作，且这个字段只声明「从哪里读包」，不制造对任何其他项目的依赖。包与宿主之间的耦合是一条目录路径，不是一份代码依赖。
- **宠物的一切都属于包**：配色、台词池、口头禅、报 bug 的口气、命中区、菜单、角色动态规格都写在 `pets/<id>/pet.yaml` 里。源码里**没有按宠物 id 登记的表**——每一只宠物的差异全在数据里，宿主只保留一份中性的兜底；加第三只、第一百只宠物都不需要改源码。

## 外部热插拔联调

先启动宿主，再运行：

```bash
python test_external_app.py              # 5 步协议联调（需要运行中的宿主）
python test_external_app.py --authcheck  # 负向测试：未授权报文必须被拒绝
python test_external_app.py --selftest   # 离线 RFC 6455 协议自检（无需宿主）
```

脚本会从 `.pet_ws_token` 读取本次运行的令牌并建立连接。令牌由操作系统随机源派生，
进程重启即失效，且**每一条入站报文**（含 `pet.act` / `menu.register` / `hud.draw`
等热插拔方法）都必须携带，缺失或错误一律拒绝。

令牌会**同时写入每一个可写位置**：宿主进程的工作目录（开发与便携场景下脚本与宿主同目录
即用）与 per-user 应用数据目录 `%APPDATA%\com.aipets.microkernel\.pet_ws_token`。
写多份而不是只写第一份，是为了让**从另一个目录启动的客户端**也能找到这条总线——两个共享
同一套宠物包的项目按定义就不在同一个目录里，只认工作目录等于要求使用者手工配置一个路径。
两处内容相同、随进程一起失效、随退出一起删除，因此不会出现"两个读者对当前令牌意见不一"。
若某处不可写（例如 per-machine 的 MSI 安装在 `C:\Program Files`）会被跳过；全都写不进去时
宿主会在 stderr 说明原因，而不是留下"总线在线但无法鉴权"的假象。

读取旧令牌会得到明确的拒绝，而不是一个沉默的失败：回绝里会写出令牌来自哪个文件
（`the pet host rejected the token from <path>: Unauthorized: Token mismatch`），
因为令牌是按进程生成的，"宿主重启了"与"读到了残留文件"是两种不同的处境。客户端在这种情况下
重读一次即可——把令牌读在宿主启动之前本来就是常态，而不是配置错误。

### 驱动权租约（`pet.driver`）

多个客户端可以连同一条总线，但**角色的决定权只有一个**：宿主自己有一套自主行为
（走神台词、喝水与久坐提醒、困倦入睡），而一个外部驱动者也在决定它做什么。两者单独看都
合理，合在一起就是一只自相矛盾的宠物——驱动刚说完一句，宿主紧接着冒出一句不相干的提醒。

`pet.driver` 就是这个归属声明：

```json
{"token": "<令牌>", "app_id": "omnicore", "method": "pet.driver",
 "params": {"action": "attach"}}
```

- `attach`（默认）取得租约，`detach` / `release` 归还；后到的声明会取代先前的持有者。
- **持有期间宿主完全停掉自己那套行为**，不是降低优先级——交接期间宿主不出声，才说得清
  此刻是谁在决定。客户端微动作（呼吸、眨眼这类由渲染层自己做的）不受影响。
- **只有持有者能归还**，其他连接调用会被忽略：否则任意客户端都能误让宿主闭麦或开麦。
- **连接的寿命就是租约的寿命**。驱动进程崩了、卡住了、不再回应心跳（宿主每半个心跳周期
  发一次 Ping，读循环有超时），都会在连接断开时自动归还；不需要另设一个会和连接不同步的
  过期时间。
- 租约**不拦截 `pet.act`**：任何客户端仍可照旧发动作，租约改变的只是宿主是否自己生成动作。
- 状态可从两处读到：前端收到 `pet-driver-changed` 事件，`get_system_telemetry` 的
  `driver_app_id` 也会报告当前持有者。


握手阶段还会校验 `Origin`，只放行宿主自身的来源——`http://localhost`、`http://127.0.0.1`、
`tauri://localhost`、`https://tauri.localhost`，端口任意；其余来源一律 403。不带 `Origin`
头的非浏览器客户端（如上述 Python 脚本）不受这条限制，仍只受令牌约束。校验按解析后的
主机名比对，因此 `http://localhost.attacker.test` 这类仅前缀相同的来源会被拒绝。
