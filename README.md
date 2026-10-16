# DesktopPetHost

基于 Tauri v2、Vue 3、TypeScript、PixiJS 与 Three.js 的桌面宠物宿主，支持 2D 矢量/序列帧、Live2D、Spine 与 VRM 模型渲染及本地 WebSocket 热插拔通信。

## 目录结构

```text
DesktopPetHost/
├── config/
│   ├── settings.yaml             # 宿主全局配置
│   └── global_menu.yaml          # 全局扇形菜单配置（支持保存热重载）
├── pets/                         # 内置机体配置与 SVG 资产
├── src/
│   ├── adapters/                 # 渲染适配器 (IPetAdapter / Sprite / Live2D / Spine / VRM)
│   ├── components/               # 主舞台、语音气泡、星盘菜单、状态坞、蓝图微调舱
│   ├── companion/                # 伴生控制台窗口（突触舱、专注待办、羁绊矩阵、网页与LLM脑桥）
│   ├── hud/                      # 全屏物理鼠标穿透标注层窗口
│   ├── store/                    # 舞台状态 (petStore)、养成专注状态 (careStore) 与主题色板 (themes)
│   ├── utils/                    # YAML 解析、指令算式引擎、舞台运行时、Web Audio 口型与音效
│   └── types/                    # TypeScript 类型声明
├── src-tauri/
│   └── src/
│       ├── main.rs               # Tauri 入口、IPC 指令集、系统托盘与配置监听
│       ├── win32_window.rs       # Win32 无焦点拦截、30Hz 穿透轮询、窗口吸附与贴边探头
│       ├── ws_server.rs          # 本地 WebSocket 总线（令牌鉴权、Ping/Pong 心跳、热插拔卸载）
│       └── action_executor.rs    # 白名单动作与外部命令执行器
└── test_external_app.py          # Python 标准库 WebSocket 联调脚本
```

## 启动与构建

```bash
npm install
npm run build
npm run tauri dev
```

外部热插拔联调测试（需宿主运行中）：

```bash
python3 test_external_app.py
```
