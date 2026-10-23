# agent_bridge：让 AI 编程助手驱动桌宠

一个零依赖的最小客户端，只用 Python 标准库。把它丢进任何一个 AI 编程助手
（Claude Code / Codex CLI / Cursor / 自己的脚本），助手就能在干活时让用户的桌宠
做出反应：思考中、写代码、跑测试、成功、失败。

协议以仓库源码 `src-tauri/src/ws_server.rs` 为准。

## 跑起来

```bash
# 1. 先启动 AI-Pets 桌面端（没启动会连不上）
# 2. 看看总线在不在、令牌认不认
python examples/agent_bridge/pet_bridge.py status

# 3. 弹一条气泡
python examples/agent_bridge/pet_bridge.py say "编译通过"

# 4. 让桌宠演个动作并说话
python examples/agent_bridge/pet_bridge.py act happy "测试全绿"

# 5. 接管／归还「驱动权」
python examples/agent_bridge/pet_bridge.py driver attach
python examples/agent_bridge/pet_bridge.py driver detach
```

## 命令

| 命令 | 作用 | 落到总线的方法 |
| --- | --- | --- |
| `status` | 查总线连通性与令牌是否被接受 | `pet.say`（1 毫秒空气泡，当探针用） |
| `say <文本>` | 弹一条语音气泡 | `pet.say` |
| `act <动作> [台词]` | 让桌宠演一段动作 | `pet.act` |
| `driver attach\|detach` | 接管／归还角色决定权 | `pet.driver` |
| `raw <JSON>` | 发送任意方法报文 | 报文里写的什么就是什么 |

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--token-file PATH` | 自动找 | 令牌文件路径 |
| `--app-id ID` | `agent_bridge` | 调用方标识，权限按它查 |
| `--port N` | 扫描 9527-9537 | 只连这一个端口 |
| `--timeout SEC` | 5 | 等待宿主回复的超时 |
| `--connect-timeout SEC` | 1 | 扫描端口时每个端口的连接超时 |

`act` 另带 `--expression`、`--duration`、`--priority`（`P0`/`P1`/`P2`/`P3`，方法路径传字符串）。

公共参数放在子命令前后都行：`pet_bridge.py --app-id foo act happy "好"` 和
`pet_bridge.py act happy "好" --app-id foo` 等价。

## 令牌从哪来

按顺序找，找到第一个就用：

1. 当前工作目录下的 `.pet_ws_token`（开发／便携运行时宿主写在这）
2. `%APPDATA%\com.aipets.microkernel\.pet_ws_token`（Windows 安装版）
3. `~/.local/share/com.aipets.microkernel/.pet_ws_token`（Linux 安装版）

令牌**每次宿主启动都会重新生成**，所以别缓存：每次用都重读。宿主被强杀时
会留下过期令牌文件，这时会收到 `Unauthorized: Token mismatch`。

## 一次实际调用长什么样

```
$ python examples/agent_bridge/pet_bridge.py act happy "测试全绿" --priority P1
[总线] ws://127.0.0.1:9527  app_id=agent_bridge  令牌来源=E:\AI\AI-Pets\.pet_ws_token
[回复] {"jsonrpc": "2.0", "id": 1, "status": "ok", "method": "pet.act"}
[结论] 已受理：pet.act
```

发出去的报文长这样（就是宿主 `IncomingWsPacket` 的那几个字段）：

```json
{
  "token": "pet_tk_…",
  "jsonrpc": "2.0",
  "id": 1,
  "app_id": "agent_bridge",
  "method": "pet.act",
  "params": { "motion": "happy", "text": "测试全绿", "priority": "P1" }
}
```

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 宿主收下了这条报文 |
| 1 | 连不上／令牌被拒／权限被拒／超时 |
| 2 | 参数用错了（命令行用法或 JSON 非法） |

宿主回 `status: "error"` 时脚本会把 `reason` 原样打出来，并附一句下一步该做什么。

## 权限

默认的 `app_id`（`agent_bridge`）**没有登记过**，所以只被允许 `pet:speak`
——也就是只能弹气泡，`act` / `driver` 会被拒：

```json
{"status": "error", "reason": "权限不足：app「agent_bridge」调用方法「pet.act」，需要权限「pet:act」，该 app 当前被批准：pet:speak"}
```

要拿到完整权限，把本目录的 `plugin.yaml` 装成插件：

```
plugins/agent_bridge/plugin.yaml
```

目录名必须和清单里的 `id` 一致（都是 `agent_bridge`），然后在伴生舱里逐项批准。
批准一次就一直有效，不绑定连接、不绑定进程，宿主重启也不丢。
详见 `docs/插件接入指南.md`。

> 登记过的 `app_id` 一项都不默认给：批准表里有什么就有什么。
> `pet:speak` 也要自己列进去，否则连气泡都发不出来。

## 长时间挂着用

宿主每 22 秒发一次心跳，不回 Pong 的话连接会被掐掉。这个脚本会自己回，
所以单次命令用完就退最省事；如果要常驻（比如监听文件变化），保持连接即可，
心跳由脚本内部处理。

## `raw` 的引号坑

Windows 的 PowerShell 5.1 在给原生命令传参时会吃掉内嵌的双引号，
`raw '{"method":"panel.update"}'` 会被传成 `{method:panel.update}`。
两个绕法：

```bash
# 办法一：写成文件，用 @ 前缀读
python examples/agent_bridge/pet_bridge.py raw @payload.json

# 办法二：换 bash / cmd
python examples/agent_bridge/pet_bridge.py raw "{\"method\":\"panel.update\"}"
```
