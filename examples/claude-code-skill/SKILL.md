---
name: pet-companion
description: 让用户的桌宠（AI-Pets）在当前任务的关键节点做出反应——开始思考、写代码、跑测试、跑完成功或失败。当任务耗时较长、涉及编译/测试、或刚得出一个结论时使用；只在必要时调用，不要连续打扰。
---

# 桌宠陪伴

通过 AI-Pets 的本地总线，让用户的桌宠反映当前工作状态。用户没要求这件事时，
**一次都不要调用**——桌宠是氛围，不是进度条。

## 什么时候调用

| 节点 | 调用 | 说明 |
| --- | --- | --- |
| 接到一个耗时的任务 | `act think "让我想想…"` | 只在任务明显要跑几分钟以上时 |
| 开始改代码 | `act typing "开工了"` | 一段任务里最多一次 |
| 开始跑测试/构建 | `act wait "跑测试中…"` | 紧接着的多个命令合并成一条 |
| 任务成功 | `act happy "搞定"` | 一次任务的最后一条 |
| 任务失败 | `act angry "炸了…"` | 一次任务的最后一条 |
| 只是回答了一个问题 | 不调用 | 桌面宠物不该为闲聊跳动 |

## 怎么调用

用 `examples/agent_bridge/pet_bridge.py`（零依赖，标准库）。
把它复制到 `~/.claude/pet_bridge.py` 后：

```bash
python ~/.claude/pet_bridge.py act happy "测试全绿"
python ~/.claude/pet_bridge.py say "编译通过"
python ~/.claude/pet_bridge.py status        # 先确认总线在不在
```

参数：

- 第一个位置参数是**动作名**（`think` / `typing` / `wait` / `happy` / `angry`），
  动作名要宠物包自己声明过；拿不准就用 `happy` 或 `think`。
- 后面的词是**台词**，会出现在气泡里。
- `--priority P1` 可选，`P0` 最高。
- 失败时的退出码：`1` 表示总线没连上／令牌被拒／权限被拒，`2` 表示参数写错了。

**权限**：默认的 `app_id` 只能弹气泡（`pet:speak`），`act` 会被拒：

```json
{"status": "error", "reason": "权限不足：app「agent_bridge」调用方法「pet.act」，需要权限「pet:act」，该 app 当前被批准：pet:speak"}
```

被拒时按 `docs/插件接入指南.md` 把桥注册成插件（`plugins/<id>/plugin.yaml`），
并在伴生舱里批准 `pet:act`。

## 不要做的事

- **不要刷屏**：一次任务最多说三句（开始 / 进行中 / 结束）。
  连续改十个文件不要发十条气泡——合并成「在改第 3 个文件」这种一条。
- **不要打断用户专注**：用户让你「安静点」或者正在全屏编辑时，一条都不要发。
- **不要把敏感内容进气泡**：源码片段、密钥、路径、报错堆栈、环境变量值——
  气泡是公开的，台词只写「测试失败了」这种状态，不写「因为 X=Y 导致的」。
- **不要留驱动权**：只有需要连续接管桌宠行为时才用
  `python ~/.claude/pet_bridge.py driver attach`，用完立刻
  `driver detach`。连接断了宿主也会自动归还，但别赌。

## Hook：让状态同步变得自动

不想每次都手动调用，就挂 Hook。在 `.claude/settings.json` 里加：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "python ~/.claude/pet_bridge.py act typing \"写代码中\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python ~/.claude/pet_bridge.py act happy \"收工\""
          }
        ]
      }
    ]
  }
}
```

这样：每次改完文件就播一次「写代码中」，本轮任务结束时播一次「收工」。

注意：

- Hook 里**不要**发带具体内容的台词——Hook 拿不到你正在做的事，
  写死一句状态词就行。
- Hook 每分钟可能触发十几次，这就是上面「不要刷屏」那条的现实来源：
  真的要用 Hook，就把 `PostToolUse` 换成 `Bash`（只拦跑命令的动作），
  或者自己在脚本里做去重。
- 不同版本的 Claude Code 的 Hook 事件名可能变，写之前先看一眼
  你本机版本的 `~/.claude/settings.json` 已有结构。

## 排查

| 现象 | 原因 |
| --- | --- |
| `连不上 AI-Pets 总线（127.0.0.1:9527-9537）` | 桌面端没启动，或端口被占 |
| `Unauthorized: Token mismatch` | 令牌是上一次的，重启桌面端让它重新生成 |
| `权限不足：app「…」调用方法「…」` | `app_id` 没被批准这项权限，去伴生舱批准 |
| `该方法不在总线允许清单内` | 方法名拼错了，总线只放行十个方法 |
| 桌宠没反应但回复是 `status: "ok"` | 动作名宠物不支持——换通用动作名 |
