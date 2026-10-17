# DesktopPetHost

基于 Tauri v2、Vue 3、TypeScript、PixiJS 与 Three.js 的桌面宠物宿主，支持 2D 矢量/序列帧、Live2D、Spine 与 VRM 渲染，并提供带令牌鉴权的本地 WebSocket 热插拔总线。

## 目录结构

```text
DesktopPetHost/
├── config/                       # 宿主全局配置（YAML，支持热重载）
│   ├── settings.yaml
│   └── global_menu.yaml
├── pets/                         # 内置机体 manifest 与资产
├── src/
│   ├── constants/
│   │   ├── messages.ts           # 全部面向用户的文案（单一来源）
│   │   └── timing.ts             # 全部时长/间隔/几何常量（单一来源）
│   ├── store/
│   │   ├── carePresenter.ts      # 养成域回报舞台的窄接口（依赖倒置）
│   │   ├── careStore.ts          # 养成与番茄钟领域状态
│   │   ├── petStore.ts           # 舞台状态、动作队列与跨窗口同步
│   │   └── themes.ts             # 主题色板
│   ├── adapters/                 # 渲染适配器 (IPetAdapter / Sprite / Live2D / Spine / VRM)
│   ├── components/               # 主舞台、语音气泡、星盘菜单、状态坞、蓝图微调舱
│   ├── companion/                # 伴生控制台窗口（突触舱、专注待办、网页与 LLM 脑桥）
│   ├── hud/                      # 全屏物理鼠标穿透标注层窗口
│   ├── utils/                    # YAML、指令引擎、舞台运行时、Web Audio 口型、存储
│   └── types/                    # TypeScript 类型声明
├── src-tauri/
│   ├── capabilities/
│   └── src/
│       ├── main.rs               # Tauri 入口、IPC 指令集、系统托盘与配置监听
│       ├── win32_window.rs       # 无焦点拦截、30Hz 穿透轮询、窗口吸附与贴边探头
│       ├── ws_server.rs          # 本地 WebSocket 总线（令牌鉴权、心跳、热插拔）
│       └── action_executor.rs    # 白名单动作与外部命令执行器
├── tests/                        # Vitest 单元测试
├── scripts/
│   ├── dead-code-scan.mjs        # 死导出扫描（已接入 npm run build）
│   └── verify.mjs                # 发布前取证（生成 docs/VERIFICATION.md）
├── docs/
│   ├── VERIFICATION.md           # 验证报告（npm run verify 生成）
│   └── standalone-release.png    # 脱离 dev server 的运行效果
└── test_external_app.py          # Python 标准库 WebSocket 联调脚本
```

## 开发命令

```bash
npm install         # 安装依赖
npm run dev         # 仅前端预览（浏览器）
npm run typecheck   # vue-tsc 静态检查
npm test            # Vitest 单元测试
npm run scan:dead   # 死导出扫描（src/** + tests/**，发现冗余即退出码 1）
npm run verify      # 发布前取证：PE 二进制 / git 比对 / 残留检查 / 死导出 / 逐文件 diff
npm run build       # 类型检查 + 死导出扫描 + 生产构建
npm run tauri dev   # 启动桌面宿主（开发，连接 Vite dev server）
npm run tauri build # 打包安装程序（需要 Rust 与 MSVC 工具链）
```

`scan:dead` 统计每个导出符号在 `src/**` 与 `tests/**` 中的真实引用（剥离 import/export
说明语句与注释后按词边界计数），报告两类冗余：**完全没有引用的死导出**，以及
**只在自身文件内被使用、本不该 export 的符号**。它已接入 `npm run build`，
因此新增冗余导出会让构建直接失败。

`verify` 会重新采集五项发布前证据并覆写 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)：
直接解析 release 二进制的 PE 头/节表/导入表并逐个核对内嵌资源路径、对照 `HEAD` 的
工作树差异、`vue-tsc` 前后的产物残留、死导出统计、以及逐文件 diff 清单。
报告中每个数字都来自当次真实运行，可用同一条命令复现。

若直接用 `cargo build --release`，必须带上 `custom-protocol` 特性，否则窗口会指向
Vite dev server，脱离开发环境后白屏：

```bash
cargo build --release --features custom-protocol
```

`npm run tauri build` 按 `bundle.targets: "all"` 同时产出 MSI 与 NSIS 两个安装包：

```text
src-tauri/target/release/bundle/
├── msi/DesktopPetHost_2.0.0_x64_en-US.msi
└── nsis/DesktopPetHost_2.0.0_x64-setup.exe
```

首次运行会由 Tauri 自动下载 WiX 与 NSIS 工具链（约 45 MB，缓存在
`%LOCALAPPDATA%\tauri`）；网络中断会导致打包失败，重跑即可续用已缓存的部分。

带 `custom-protocol` 构建出的二进制自带前端资源，可在关闭 Vite dev server 的情况下独立运行：

![宿主在无 dev server 环境下的独立运行效果](docs/standalone-release.png)

## 架构约定

- **常量与文案单一来源**：所有时长、几何与用户可见字符串分别位于 `src/constants/timing.ts` 与 `src/constants/messages.ts`，避免同一含义在多处漂移。
- **领域层不依赖展示层**：`careStore` 通过 `CarePresenter` 窄接口回报舞台，而不感知 `petStore`。
- **无模块级可变状态**：定时器、总线绑定等状态都归属具体 store 实例，不会跨窗口串扰。
- **适配器单一契约**：所有渲染后端实现 `IPetAdapter`，由 `AdapterFactory` 按需动态加载。
- **WebSocket 总线全量鉴权**：每条入站消息（含热插拔方法）都必须携带进程令牌，令牌由操作系统随机源派生。

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
