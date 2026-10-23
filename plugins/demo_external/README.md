# 外部示例插件 · demo_external

一个能真跑的第三方插件示例：它把一句外部提示交给桌宠的气泡，再在 HUD 上标注一条说明。

它只做两件事，两件都是「描述」：

| 总线方法 | 权限 | 插件给的 | 宿主画的 |
| --- | --- | --- | --- |
| `pet.say` | `pet:speak` | 一句话 | 桌宠的气泡 |
| `hud.draw` | `hud:draw` | 位置、尺寸、文字 | HUD 的矩形与标签 |

插件自己不开窗口、不画图、不贴图、不注册菜单、不接管角色——**用不到就不申请**。想要自己的
界面，宿主那边有 `panel.open`（那需要另外的权限，也另外算）。

## 文件

```
plugins/demo_external/
├── plugin.yaml   清单：身份、版本、申请的权限
├── plugin.py     插件本体：连总线、发两条消息
└── README.md     本文件
```

## 清单怎么写

宿主的清单只认 5 个字段：`id`（必须等于目录名）、`name`、`version`、`description`、
`permissions`。`permissions` 是**权限名的数组**，每项一个字符串；申请理由写在那一项上面
的注释里——注释宿主会忽略，但人看得见，自检脚本与夹具也会读出来给你看。

```yaml
id: demo_external
name: 外部示例插件 · 提示气泡
version: 1.0.0
description: 往桌宠气泡和 HUD 上放一条外部说明，用来验证插件体系是否打通。
permissions:
  # 把一句外部提示交给桌宠的气泡显示——只给文字，界面由宿主画。
  - pet:speak
  # 给出一条 HUD 标注的位置与文字，由宿主画成矩形和标签。
  - hud:draw
```

能申请的权限只有这六项：`pet:act`、`pet:speak`、`pet:driver`、`menu:register`、
`panel:open`、`hud:draw`。写了别的名字，整份清单会被宿主判为无效。

## 怎么改

改文字、换标注位置都在 `plugin.py` 里：

```bash
python plugins/demo_external/plugin.py --text "今天也辛苦啦"
```

* 气泡里那句话：`plugin.py` 的 `DEFAULT_TEXT`，或命令行 `--text`。
* HUD 标注的位置和大小：`plugin.py` 里 `hud.draw` 的 `annotations`（`x` / `y` / `w` / `h`）。
* 气泡停留时长：`pet.say` 的 `duration_ms`。
* 要加权限：在 `plugin.yaml` 的 `permissions` 里加一项（字符串），并在 `plugin.py` 里真的
  用到它。没用的权限不要申请——用户要逐条看理由。

## 怎么在不开桌宠的情况下验证

仓库里有两个脚本，都只读文件、不连总线：

```bash
python scripts/plugin-harness.py plugins/demo_external   # 这个插件合不合法、会申请什么
python scripts/doctor.py                                 # 宿主与全部插件的整体状态
```

`plugin-harness.py` 会打出三样东西：清单是否合法、这个插件会向宿主申请什么、当前批准表下
每个总线方法会被放行还是拒绝。清单非法时退出码是 1。

## 怎么批准它

宿主的规矩是**声明 ∩ 批准**才生效：插件在 `plugin.yaml` 里声明权限，用户在伴生舱里逐项
批准，没批准的权限宿主不会放行。

* 伴生舱的插件页会列出插件申请到的每一项权限，同意之后批准结果写回
  `config/settings.yaml` 的 `host.plugin_approvals`：

```yaml
host:
  plugin_approvals:
    demo_external:
      - pet:speak
      - hud:draw
```

* 这份配置就是事实来源：宿主从那里读，自己查的也是那里。
* 想看「没批准会怎样」，另写一张空的批准表再传给夹具（这张表不必进仓库）：

```json
{ "demo_external": [] }
```

```bash
python scripts/plugin-harness.py plugins/demo_external --approvals %TEMP%\approvals-empty.json
```

`pet.say` / `hud.draw` 会从「允许」变成「拒绝（已声明，但用户还没批准）」，其余方法一律拒绝。

## 怎么真跑一遍

先启动桌宠宿主（它会签发总线令牌并监听 9527 起的端口），然后：

```bash
python plugins/demo_external/plugin.py
```

它会打印连上的端口和宿主对两条消息的回复。宿主没开时，它会明确告诉你「找不到令牌 /
端口没在监听」，而不是静默失败。

没批准的权限宿主会当场拒掉：`pet.say` 对没在批准表里出现过的 app 默认放行（宿主的兜底
权限就是 `pet:speak`），`hud.draw` 则要用户点头才会画出来。
