#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌宠宿主与插件自检。

它回答一个问题：现在这台机器上的桌宠宿主健不健康、插件装得对不对、哪些权限真正生效。

自检分五段，每段都给出通过／警告／失败三者之一的结论，而且每条失败都带一句能照着做的
修复建议——「令牌不对」本身没有用，「令牌前缀不是 pet_tk_，删掉残留文件再重启宿主」才有用：

  1. 总线令牌：宿主签发的令牌能不能读到，前缀对不对。
  2. 总线端口：9527~9537 里有没有真的在监听。
  3. 配置：config/settings.yaml 能不能解析，关键字段齐不齐。
  4. 插件清单：plugins/ 下每个目录的 plugin.yaml 是否合法。
  5. 权限批准：每个插件「声明了什么 / 用户批准了什么 / 实际生效什么」。

脚本只读文件，不下载依赖，也不改任何东西。YAML 优先用 PyYAML；没装就退回内置的最小解析
器，输出里会写明用的是哪一种。设 PET_FORCE_MINIMAL_YAML=1 可以强制走内置解析器，用来验证
那条退路本身没坏。

用法：
    python scripts/doctor.py
    python scripts/doctor.py --approvals plugins/approvals.json
"""

import argparse
import json
import os
import re
import socket
import sys
from pathlib import Path

try:  # the Windows console is a legacy code page; page text is not.
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

REPO = Path(__file__).resolve().parent.parent
PLUGINS_DIR = REPO / "plugins"
SETTINGS_PATH = REPO / "config" / "settings.yaml"
APP_IDENTIFIER = "com.aipets.microkernel"
TOKEN_FILE_NAME = ".pet_ws_token"
TOKEN_PREFIX = "pet_tk_"
TOKEN_BODY_RE = re.compile(r"^[0-9a-f]{32}$")
APPROVAL_FILE_NAME = "plugin-approvals.json"

# 权限白名单就是全部契约：插件只能申请这几项，而且只有用户批准过的才会真正生效。
PERMISSION_WHITELIST = (
    "pet:act",
    "pet:speak",
    "pet:driver",
    "menu:register",
    "panel:open",
    "hud:draw",
)

# 总线方法 → 需要的权限。清理类方法（unregister / clear / update）跟着它清理的那个权限走，
# 所以一次授权同时覆盖登记和注销。
BUS_METHODS = (
    ("pet.act", "pet:act", "让宠物演一段动作并说话"),
    ("pet.say", "pet:speak", "弹语音气泡（speak 是同一个方法）"),
    ("pet.driver", "pet:driver", "取得／归还角色决定权"),
    ("menu.register", "menu:register", "注册外部菜单项"),
    ("menu.unregister", "menu:register", "注销外部菜单"),
    ("panel.open", "panel:open", "打开伴生面板"),
    ("panel.update", "panel:open", "向伴生面板推送状态"),
    ("hud.draw", "hud:draw", "画屏幕标注"),
    ("hud.clear", "hud:draw", "清除屏幕标注"),
)

# settings.yaml 里必须有的字段。缺一个，宿主启动时就会走默认值或者直接报错。
REQUIRED_SETTINGS = (
    ("host.ws_port_range", "总线端口扫描区间"),
    ("host.heartbeat_timeout_sec", "心跳超时秒数"),
    ("host.default_pet", "默认宠物 id"),
    ("render.idle_fps", "静止帧率"),
    ("audio.enable_tts", "语音朗读总开关"),
    ("audio.tts.provider", "语音合成方案"),
    ("audio.stt.provider", "语音识别方案"),
)

# 插件清单里认识的字段。出现别的字段多半是拼错了，提示但不拦下（与宿主同一口径）。
KNOWN_MANIFEST_KEYS = (
    "id",
    "name",
    "version",
    "description",
    "permissions",
)

# 清单规则与宿主一致（src/utils/pluginManifest.ts）：id 2~64 位，version 三段数字。
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
NAME_MAX_LENGTH = 64


class YamlError(Exception):
    """两种解析器都没能把这段 YAML 读成数据。"""


# --------------------------------------------------------------------------------------
# YAML：PyYAML 优先，没有就自己读
# --------------------------------------------------------------------------------------


def _pyyaml_module():
    """返回 PyYAML 模块；没装（或被环境变量强制退回）时返回 None。"""
    if os.environ.get("PET_FORCE_MINIMAL_YAML") == "1":
        return None
    try:
        import yaml  # noqa: PLC0415 - 故意放在函数里：没装 PyYAML 不该让整个脚本挂掉
    except ImportError:
        return None
    return yaml


def _yaml_label():
    module = _pyyaml_module()
    if module is None:
        return "内置最小解析器（本机没装 PyYAML）"
    return f"PyYAML {getattr(module, '__version__', '未知版本')}"


def _strip_comment(text):
    """去掉行尾注释。引号里的 # 不算注释，# 前必须有空格才算（与 YAML 规范一致）。"""
    out = []
    quote = None
    index = 0
    while index < len(text):
        char = text[index]
        if quote:
            out.append(char)
            if char == "\\" and quote == '"' and index + 1 < len(text):
                out.append(text[index + 1])
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
            out.append(char)
        elif char == "#" and (index == 0 or text[index - 1] in " \t"):
            break
        else:
            out.append(char)
        index += 1
    return "".join(out).rstrip()


def _split_flow(text):
    """把 [a, b, c] 的内容按逗号切开，逗号在引号或括号里不算分隔符。"""
    parts = []
    current = []
    depth = 0
    quote = None
    for char in text:
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            current.append(char)
            continue
        if char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append("".join(current))
            current = []
            continue
        current.append(char)
    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return [part.strip() for part in parts]


def _scalar(text):
    """把一个标量读成 Python 值：引号串、true/false、数字、空值。"""
    text = text.strip()
    if not text:
        return None
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        return [_scalar(part) for part in _split_flow(inner)]
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        body = text[1:-1]
        if text[0] == '"':
            body = body.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
        return body
    lowered = text.lower()
    if lowered in ("null", "~"):
        return None
    if lowered in ("true", "yes", "on"):
        return True
    if lowered in ("false", "no", "off"):
        return False
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return text


def _split_key(text):
    """拆出 key 与 value。返回 (key, value, 是否真的是 key: value)。"""
    quote = None
    for index, char in enumerate(text):
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            continue
        if char == ":" and (index + 1 == len(text) or text[index + 1] in " \t"):
            return _scalar(text[:index]), text[index + 1:].strip(), True
    return None, text, False


def _mini_parse_mapping(lines, position, indent):
    mapping = {}
    while position < len(lines):
        line_indent, content, number = lines[position]
        if line_indent < indent:
            break
        if line_indent > indent:
            raise YamlError(f"第 {number} 行缩进不对")
        if content == "-" or content.startswith("- "):
            break
        key, rest, found = _split_key(content)
        if not found:
            raise YamlError(f"第 {number} 行不是 key: value —— {content}")
        position += 1
        if rest:
            mapping[key] = _scalar(rest)
            continue
        if position < len(lines) and lines[position][0] > line_indent:
            value, position = _mini_parse(lines, position, lines[position][0])
            mapping[key] = value
        elif (
            position < len(lines)
            and lines[position][0] == line_indent
            and (lines[position][1] == "-" or lines[position][1].startswith("- "))
        ):
            value, position = _mini_parse_sequence(lines, position, line_indent)
            mapping[key] = value
        else:
            mapping[key] = None
    return mapping, position


def _mini_parse_sequence(lines, position, indent):
    items = []
    while position < len(lines):
        line_indent, content, number = lines[position]
        if line_indent < indent:
            break
        if line_indent > indent:
            raise YamlError(f"第 {number} 行缩进不对")
        if not (content == "-" or content.startswith("- ")):
            break
        rest = content[1:].strip()
        position += 1
        if not rest:
            if position < len(lines) and lines[position][0] > line_indent:
                value, position = _mini_parse(lines, position, lines[position][0])
                items.append(value)
            else:
                items.append(None)
            continue
        if _split_key(rest)[2]:
            # "- key: value" 起一张表，后面的键与 value 对齐
            column = line_indent + (len(content) - len(rest))
            block = [(column, rest, number)]
            while position < len(lines) and lines[position][0] > line_indent:
                if lines[position][0] != column:
                    raise YamlError(f"第 {lines[position][2]} 行缩进不对")
                block.append(lines[position])
                position += 1
            value, _ = _mini_parse(block, 0, column)
            items.append(value)
            continue
        items.append(_scalar(rest))
    return items, position


def _mini_parse(lines, position, indent):
    if lines[position][1] == "-" or lines[position][1].startswith("- "):
        return _mini_parse_sequence(lines, position, indent)
    return _mini_parse_mapping(lines, position, indent)


def _mini_yaml_load(text):
    """最小 YAML 读取：嵌套 map、块状 list（标量或表）、行内 [a, b]、标量。够本仓库用。"""
    lines = []
    for number, raw in enumerate(text.splitlines(), start=1):
        leading = raw[: len(raw) - len(raw.lstrip())]
        if "\t" in leading:
            raise YamlError(f"第 {number} 行用制表符缩进")
        stripped = _strip_comment(raw)
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        lines.append((indent, stripped.strip(), number))
    if not lines:
        return None
    value, position = _mini_parse(lines, 0, lines[0][0])
    if position != len(lines):
        raise YamlError(f"第 {lines[position][2]} 行缩进不对")
    return value


def load_yaml(text):
    """读一段 YAML，返回 (数据, 解析器名字)。两种解析器都失败时抛 YamlError。"""
    module = _pyyaml_module()
    if module is None:
        return _mini_yaml_load(text), "内置最小解析器"
    try:
        return module.safe_load(text), "PyYAML"
    except Exception as exc:  # PyYAML 抛的是 YAMLError，但不想把它引进依赖里
        problem = getattr(exc, "problem", None)
        mark = getattr(exc, "problem_mark", None)
        if problem and mark is not None:
            raise YamlError(f"第 {mark.line + 1} 行第 {mark.column + 1} 列：{problem}") from exc
        raise YamlError(str(exc).splitlines()[0]) from exc


def read_yaml_file(path):
    """读一个 YAML 文件，返回 (数据, 解析器名字, 错误信息)。"""
    try:
        # utf-8-sig：Windows 上的编辑器爱写 BOM，带 BOM 的文件也得读得进去。
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return None, None, f"读不了文件：{exc}"
    try:
        data, label = load_yaml(text)
    except YamlError as exc:
        return None, None, f"解析失败：{exc}"
    return data, label, None


# --------------------------------------------------------------------------------------
# 插件清单
# --------------------------------------------------------------------------------------


class PluginManifest:
    """一个插件目录读出来的结果：身份、权限、以及毛病。"""

    def __init__(self, directory):
        self.directory = directory
        self.path = directory / "plugin.yaml"
        self.plugin_id = ""
        self.name = ""
        self.version = ""
        self.description = ""
        self.permissions = []  # 声明的权限名
        self.reasons = {}  # 权限 → 申请理由（写在清单里的注释上）
        self.errors = []
        self.warnings = []

    @property
    def declared_permissions(self):
        return list(self.permissions)


def _normalize_permissions(raw, errors, warnings):
    """permissions 只能是权限名的字符串数组——与宿主同一口径。

    宿主那边把非字符串项判成整份清单作废（src/utils/pluginManifest.ts），这里也判成错误：
    一份「夹具说合法、宿主说不合法」的清单比一份直接被判非法的清单更坏。
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        errors.append("permissions 必须是一个数组")
        return []
    result = []
    for item in raw:
        if not isinstance(item, str):
            errors.append(f"permissions 里出现了非字符串项：{item!r}")
            continue
        permission = item.strip()
        if not permission:
            errors.append("permissions 里有一条是空的")
            continue
        if permission not in PERMISSION_WHITELIST:
            errors.append(
                f"权限 {permission} 不在白名单内（可用：{'、'.join(PERMISSION_WHITELIST)}）"
            )
            continue
        if permission in result:
            warnings.append(f"权限 {permission} 声明了两次，宿主只会算一次")
            continue
        result.append(permission)
    return result


def _permission_reasons(text):
    """从清单原文里取每个权限的申请理由。

    宿主的清单格式里没有「理由」这个字段——权限只是一串名字。理由写在权限上面那行注释里，
    这里把它读出来，好让自检和夹具能告诉用户「这个插件为什么想要这项权限」。
    """
    reasons = {}
    lines = text.splitlines()
    inside = False
    indent = 0
    for index, raw in enumerate(lines):
        stripped = raw.strip()
        if not stripped:
            continue
        current_indent = len(raw) - len(raw.lstrip(" "))
        if not inside:
            if stripped.endswith(":") and stripped[:-1].strip() == "permissions":
                inside = True
                indent = current_indent
            continue
        if current_indent <= indent and not stripped.startswith("-"):
            break  # permissions 这一段到头了
        if not stripped.startswith("-"):
            continue
        permission = stripped.lstrip("- ").strip().strip("\"'")
        for back in range(index - 1, -1, -1):
            candidate = lines[back].strip()
            if not candidate:
                continue
            if candidate.startswith("#"):
                reasons[permission] = candidate.lstrip("#").strip()
            break
    return reasons


def read_manifest(directory):
    """读一个插件目录的 plugin.yaml 并校验它。"""
    manifest = PluginManifest(directory)
    if not manifest.path.is_file():
        # 宿主把没有 plugin.yaml 的目录直接跳过（它不是插件），这里也只提示不判失败。
        manifest.warnings.append("没有 plugin.yaml，这个目录不是插件（宿主会跳过它）")
        return manifest
    try:
        text = manifest.path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        manifest.errors.append(f"读不了 plugin.yaml：{exc}")
        return manifest
    try:
        data, _label = load_yaml(text)
    except YamlError as exc:
        manifest.errors.append(f"解析失败：{exc}")
        return manifest
    if not isinstance(data, dict):
        manifest.errors.append("plugin.yaml 顶层不是一张表")
        return manifest

    raw_id = data.get("id")
    if raw_id is None:
        manifest.errors.append("缺少 id")
    elif not isinstance(raw_id, str) or not raw_id.strip():
        manifest.errors.append("id 必须是非空字符串")
    else:
        manifest.plugin_id = raw_id.strip()
        if not ID_RE.match(manifest.plugin_id):
            manifest.errors.append(
                f"id {manifest.plugin_id} 不合法（只能是小写字母、数字、- 和 _）"
            )
        elif manifest.plugin_id != directory.name:
            manifest.errors.append(
                f"id {manifest.plugin_id} 与目录名 {directory.name} 不一致"
            )

    raw_name = data.get("name")
    if not isinstance(raw_name, str) or not raw_name.strip():
        manifest.errors.append("缺少 name（插件在界面上显示的名字）")
    else:
        manifest.name = raw_name.strip()
        if len(manifest.name) > NAME_MAX_LENGTH:
            manifest.errors.append(f"name 超过 {NAME_MAX_LENGTH} 个字符")

    raw_version = data.get("version")
    if raw_version is None:
        manifest.errors.append("缺少 version")
    elif not isinstance(raw_version, str) or not VERSION_RE.match(raw_version.strip()):
        manifest.errors.append(
            f"version {raw_version!r} 格式不对（用 1.0.0 这样的版本号）"
        )
    else:
        manifest.version = raw_version.strip()

    raw_description = data.get("description")
    if not isinstance(raw_description, str) or not raw_description.strip():
        manifest.warnings.append("缺少 description（宿主要靠它向用户解释这个插件要什么）")
    else:
        manifest.description = raw_description.strip()

    manifest.permissions = _normalize_permissions(
        data.get("permissions"), manifest.errors, manifest.warnings
    )
    manifest.reasons = _permission_reasons(text)
    for permission in manifest.permissions:
        if not manifest.reasons.get(permission):
            manifest.warnings.append(f"权限 {permission} 没有写申请理由")

    unknown = [key for key in data if key not in KNOWN_MANIFEST_KEYS]
    if unknown:
        manifest.warnings.append(f"这些字段宿主不认：{'、'.join(sorted(unknown))}")
    return manifest


def plugin_directories(root=PLUGINS_DIR):
    """插件目录：plugins/ 下每个子目录（跳过隐藏目录和 __pycache__）。"""
    if not root.is_dir():
        return []
    return sorted(
        path
        for path in root.iterdir()
        if path.is_dir() and not path.name.startswith(".") and path.name != "__pycache__"
    )


# --------------------------------------------------------------------------------------
# 批准表
# --------------------------------------------------------------------------------------


class Approvals:
    """用户的批准。

    `host` 是宿主真正执行的那份——伴生舱写在 config/settings.yaml 的 host.plugin_approvals，
    宿主也从那里读。`mirror` 是另一处可能存在的记录（手写或脚本生成的 JSON 批准表）：
    宿主不读它，两边不一样时必须说出来，否则「批准了」和「生效了」会各说各话。
    """

    def __init__(self):
        self.host = {}
        self.host_source = "config/settings.yaml 的 host.plugin_approvals"
        self.mirror = {}
        self.mirror_source = ""
        self.errors = []


def mirror_candidates():
    """另一处可能存在的批准记录在哪（宿主不读，只有自检脚本看得到）。"""
    candidates = []
    for env_var in ("APPDATA", "XDG_DATA_HOME"):
        base = os.environ.get(env_var)
        if base:
            candidates.append(Path(base) / APP_IDENTIFIER / APPROVAL_FILE_NAME)
    candidates.append(Path.home() / ".local" / "share" / APP_IDENTIFIER / APPROVAL_FILE_NAME)
    candidates.append(PLUGINS_DIR / "approvals.json")
    return candidates


def _approval_list(value, errors, plugin_id):
    """一份批准就是权限名的数组。写法不对就丢掉这一条——宁可少给，不可多给。"""
    if not isinstance(value, list):
        errors.append(f"批准表里 {plugin_id} 的批准不是权限名数组，已忽略")
        return []
    result = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            errors.append(f"批准表里 {plugin_id} 有一条批准不是权限名，已忽略")
            continue
        result.append(item.strip())
    return result


def _approval_table(data, errors):
    if isinstance(data, dict) and "plugins" in data:
        data = data["plugins"]
    if not isinstance(data, dict):
        errors.append("批准表顶层不是一张表，已忽略")
        return {}
    return {pid: _approval_list(value, errors, pid) for pid, value in data.items()}


def load_approvals(settings, explicit=None):
    """读批准表。

    默认读 config/settings.yaml 里的 host.plugin_approvals——那是伴生舱写下的地方，也是
    宿主执行的那份。--approvals 指向别的 JSON 文件时用那份代替，方便试各种批准组合。
    """
    approvals = Approvals()
    if explicit:
        path = Path(explicit)
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            approvals.errors.append(f"批准表读不了：{exc}")
            return approvals
        approvals.host = _approval_table(data, approvals.errors)
        approvals.host_source = str(path)
        return approvals

    raw = settings_value(settings, "host.plugin_approvals") if settings else None
    if raw is None:
        approvals.host = {}
    elif isinstance(raw, dict):
        approvals.host = _approval_table(raw, approvals.errors)
    else:
        approvals.errors.append("host.plugin_approvals 不是一张表，已按「什么都没批准」处理")

    for candidate in mirror_candidates():
        if not candidate.is_file():
            continue
        try:
            data = json.loads(candidate.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            approvals.errors.append(f"{candidate} 读不了：{exc}")
            continue
        approvals.mirror = _approval_table(data, approvals.errors)
        approvals.mirror_source = str(candidate)
        break
    return approvals


def plugin_roots(settings, bundled=PLUGINS_DIR):
    """插件根目录：仓库自带的 plugins/ 在前，再加 host.plugins_dirs 指的那些。

    顺序与宿主一致：先到先得，同名插件只认前面那个。
    """
    roots = [bundled]
    extra = settings_value(settings, "host.plugins_dirs") if settings else None
    if isinstance(extra, list):
        for item in extra:
            if isinstance(item, str) and item.strip():
                roots.append(Path(item.strip()))
    return roots


def effective_permissions(declared, approved):
    """宿主真正放行的权限 = 声明 ∩ 批准。"""
    return [permission for permission in declared if permission in approved]


# --------------------------------------------------------------------------------------
# 各项检查
# --------------------------------------------------------------------------------------


def token_candidates():
    """令牌文件可能在哪，顺序与宿主写入的顺序一致。"""
    candidates = [REPO / TOKEN_FILE_NAME]
    for env_var in ("APPDATA", "XDG_DATA_HOME"):
        base = os.environ.get(env_var)
        if base:
            candidates.append(Path(base) / APP_IDENTIFIER / TOKEN_FILE_NAME)
    candidates.append(Path.home() / ".local" / "share" / APP_IDENTIFIER / TOKEN_FILE_NAME)
    return candidates


def port_is_listening(port, host="127.0.0.1", timeout=0.25):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def settings_value(data, dotted_path):
    """按 host.ws_port_range 这种写法取值，取不到返回 None。"""
    current = data
    for part in dotted_path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


class Report:
    """把检查结果打出来，同时记住失败和警告，好决定退出码。"""

    def __init__(self):
        self.failures = []
        self.warnings = []

    def section(self, title):
        print()
        print(f"[{title}]")

    def ok(self, message):
        print(f"  [OK]   {message}")

    def note(self, message):
        print(f"         {message}")

    def warn(self, message, fix=None):
        print(f"  [WARN] {message}")
        if fix:
            print(f"         修复：{fix}")
        self.warnings.append(message)

    def fail(self, message, fix=None):
        print(f"  [FAIL] {message}")
        if fix:
            print(f"         修复：{fix}")
        self.failures.append(message)


def check_token(report):
    """总线令牌：能不能读到，前缀对不对。"""
    report.section("1/5 总线令牌")
    candidates = token_candidates()
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            token = candidate.read_text(encoding="utf-8").strip()
        except OSError as exc:
            report.fail(
                f"令牌文件读不了：{candidate}（{exc}）",
                "确认文件没有被别的程序独占，关掉占用它的程序再试",
            )
            return None, candidate
        if not token:
            report.fail(
                f"令牌文件是空的：{candidate}",
                "删掉这个残留文件并重启桌宠宿主，宿主会重新签发令牌",
            )
            return None, candidate
        if not token.startswith(TOKEN_PREFIX):
            report.fail(
                f"令牌前缀不对：{candidate}（应该是 {TOKEN_PREFIX} 开头）",
                "这多半是上一次运行留下的旧文件：删掉它并重启桌宠宿主",
            )
            return None, candidate
        if not TOKEN_BODY_RE.match(token[len(TOKEN_PREFIX) :]):
            report.warn(
                f"令牌长度不像宿主签发的：{candidate}（{TOKEN_PREFIX} 后面应有 32 位十六进制）",
                "确认这个文件确实是桌宠宿主写出来的",
            )
        else:
            report.ok(f"令牌文件：{candidate}")
            report.note(f"令牌：{token[:12]}…{token[-4:]}（前缀与长度都对）")
        return token, candidate
    report.warn(
        "没有找到总线令牌文件",
        "宿主启动时才会签发令牌：先启动桌宠宿主（dist 里的 ai-pets.exe），再跑一次本脚本",
    )
    return None, None


def check_ports(report, settings, token_path):
    """总线端口：配置区间里有没有在监听的。"""
    report.section("2/5 总线端口")
    port_range = settings_value(settings, "host.ws_port_range") if settings else None
    if not isinstance(port_range, (list, tuple)) or len(port_range) != 2:
        report.fail(
            "读不出 host.ws_port_range，总线端口区间未知",
            "在 config/settings.yaml 里写上 host: ws_port_range: [9527, 9537]",
        )
        return
    low, high = int(port_range[0]), int(port_range[1])
    if not (1 <= low <= high <= 65535):
        report.fail(
            f"host.ws_port_range 区间不合法：{port_range}",
            "改成两个从小到大的合法端口，例如 [9527, 9537]",
        )
        return
    report.note(f"配置区间：{low}~{high}")
    listening = [port for port in range(low, high + 1) if port_is_listening(port)]
    if not listening:
        if token_path is not None:
            report.fail(
                f"{low}~{high} 都没有在监听，但令牌文件在（{token_path}）——宿主已经退出，或令牌是残留的",
                f"删掉 {token_path} 并重启桌宠宿主，宿主会重新签发令牌",
            )
        else:
            report.warn(
                f"{low}~{high} 都没有在监听（宿主多半没在跑）",
                "启动桌宠宿主后再跑一次本脚本",
            )
        return
    report.ok(f"正在监听：{'、'.join(str(port) for port in listening)}")
    if len(listening) > 1:
        report.note("同一区间里有多个端口在监听，宿主只会用其中一个")


def read_settings():
    """静默读配置，返回 (数据或 None, 错误信息或 None)。端口区间要先知道才查得了端口。"""
    if not SETTINGS_PATH.is_file():
        return None, f"找不到 {SETTINGS_PATH}"
    data, _label, error = read_yaml_file(SETTINGS_PATH)
    if error:
        return None, error
    if not isinstance(data, dict):
        return None, f"{SETTINGS_PATH.name} 顶层不是一张表"
    return data, None


def check_settings(report, data, error):
    """配置：能不能解析，关键字段齐不齐。"""
    report.section("3/5 配置 config/settings.yaml")
    if error:
        report.fail(
            f"{SETTINGS_PATH.name} {error}",
            "对照 docs/使用说明书.md 里的配置表把配置改回来（缺失的文件从仓库恢复）",
        )
        return
    missing = []
    for dotted_path, label_text in REQUIRED_SETTINGS:
        if settings_value(data, dotted_path) is None:
            missing.append(f"{dotted_path}（{label_text}）")
    if missing:
        report.fail(
            f"{SETTINGS_PATH.name} 缺字段：{'、'.join(missing)}",
            "把这些字段补回 config/settings.yaml，宿主启动时按默认值兜底不等于配置就对了",
        )
        return
    report.ok(f"{SETTINGS_PATH.name} 解析通过，关键字段齐")
    report.note(
        "端口区间 {0}、默认宠物 {1}、TTS {2}、STT {3}".format(
            settings_value(data, "host.ws_port_range"),
            settings_value(data, "host.default_pet"),
            settings_value(data, "audio.tts.provider"),
            settings_value(data, "audio.stt.provider"),
        )
    )


def check_manifests(report, roots):
    """插件清单：插件根目录下的每个目录。

    多个根目录按顺序来，同名插件只认前面那个——与宿主一致（src-tauri/src/plugin_packages.rs）。
    """
    report.section("4/5 插件清单")
    report.note("插件根目录：" + "、".join(str(root) for root in roots))
    manifests = []
    claimed = set()
    for root in roots:
        if not root.is_dir():
            if root != roots[0]:
                report.warn(
                    f"{root} 不存在（配置里的插件目录）",
                    "检查 config/settings.yaml 的 host.plugins_dirs，或者把插件放到那个目录下",
                )
            continue
        for directory in plugin_directories(root):
            if directory.name in claimed:
                report.warn(
                    f"{directory.name}：{root} 下又有一份同名插件，宿主只认前面那个，已跳过",
                    "删掉重复的那一份，或者给它们不同的 id",
                )
                continue
            claimed.add(directory.name)
            manifest = read_manifest(directory)
            manifests.append(manifest)
            if manifest.errors:
                for error in manifest.errors:
                    report.fail(f"{directory.name}：{error}", manifest_fix(manifest, error))
                continue
            report.ok(f"{manifest.plugin_id}  v{manifest.version}  —— {manifest.name}")
            permissions = "、".join(manifest.declared_permissions) or "（没有申请任何权限）"
            report.note(f"声明权限 {len(manifest.permissions)} 项：{permissions}")
            for warning in manifest.warnings:
                report.warn(f"{manifest.plugin_id}：{warning}")
    if not manifests:
        report.warn(
            "一个插件都没装",
            "新建 plugins/<插件 id>/plugin.yaml 放一个插件进来",
        )
    return manifests


def manifest_fix(manifest, error):
    """给一条清单错误配一句能照着做的修复。"""
    if "解析失败" in error:
        return "plugin.yaml 不是合法 YAML：按 key: value 的写法检查缩进和引号"
    if "id" in error and "目录名" in error:
        directory = manifest.directory.name
        return f"把 plugin.yaml 里的 id 改成 {directory}，或者把目录改名成 id"
    if "id" in error:
        return "id 只能是小写字母、数字、- 和 _，长度 2~64"
    if "version" in error:
        return "version 用 1.0.0 这样的版本号"
    if "name" in error:
        return "补上 name：插件在界面上显示的名字"
    if "白名单" in error:
        return "删掉这条权限，或者换成白名单里的那几项之一"
    if "permissions" in error:
        return "permissions 写成权限名的数组，每项一个字符串"
    return "对照 plugins/demo_external/plugin.yaml 改一遍"


def check_approvals(report, manifests, approvals):
    """权限批准：声明了什么、批准了什么、实际生效什么。

    「批准」取宿主执行的那份（config/settings.yaml 的 host.plugin_approvals）。另一处记录
    （plugins/approvals.json 之类）宿主不读，所以它跟宿主那份不一致时要说出来——两处各说
    各话，「批准了」和「生效了」就都不是同一件事。
    """
    report.section("5/5 权限批准")
    for error in approvals.errors:
        report.fail(f"批准表：{error}", "把批准写成「插件 id → 权限名数组」这种写法")
    report.note(f"批准表（宿主执行的）：{approvals.host_source}")
    if approvals.mirror_source:
        report.note(f"另一处记录（宿主不读）：{approvals.mirror_source}")

    for plugin_id in sorted(set(approvals.mirror) - set(approvals.host)):
        report.warn(
            f"{plugin_id} 只在 {approvals.mirror_source} 里被批准，宿主不读那份文件——权限不会生效",
            f"把批准写进 {approvals.host_source}",
        )
    for plugin_id in sorted(set(approvals.mirror) & set(approvals.host)):
        if set(approvals.mirror[plugin_id]) != set(approvals.host[plugin_id]):
            report.warn(
                f"{plugin_id} 的两处批准不一样 —— 宿主按 {approvals.host_source} 执行",
                f"把 {approvals.mirror_source} 改成一样，或者删掉它",
            )

    for manifest in manifests:
        if manifest.errors:
            continue
        declared = manifest.declared_permissions
        approved = approvals.host.get(manifest.plugin_id, [])
        effective = effective_permissions(declared, approved)
        print(f"  {manifest.plugin_id}")
        print(f"    声明：{'、'.join(declared) or '（无）'}")
        print(f"    批准：{'、'.join(approved) or '（无）'}")
        print(f"    生效：{'、'.join(effective) or '（无）'}")
        for permission in declared:
            if permission not in approved:
                report.warn(
                    f"{manifest.plugin_id} 声明了 {permission}，但用户没有批准——宿主不会放行",
                    f"在伴生舱的插件页批准 {manifest.plugin_id} 的 {permission}，或从清单里删掉它",
                )
        for permission in approved:
            if permission not in declared:
                report.warn(
                    f"{manifest.plugin_id} 批准了 {permission}，但插件没有声明它——批准也不能越过清单",
                    f"把 {permission} 从批准表里去掉，或者在 plugin.yaml 里声明它",
                )


def main(argv=None):
    parser = argparse.ArgumentParser(description="桌宠宿主与插件自检")
    parser.add_argument(
        "--approvals",
        help="用别的 JSON 文件当批准表（默认读 config/settings.yaml 的 host.plugin_approvals）",
    )
    parser.add_argument(
        "--plugins-dir",
        help="指定插件根目录（默认是仓库里的 plugins/，再加 host.plugins_dirs）",
    )
    args = parser.parse_args(argv)

    print("桌宠自检 · 宿主与插件")
    print(f"仓库：{REPO}")
    print(f"YAML 解析：{_yaml_label()}")

    report = Report()
    settings, settings_error = read_settings()
    if args.plugins_dir:
        roots = [Path(args.plugins_dir)]
    else:
        roots = plugin_roots(settings)
    _token, token_path = check_token(report)
    check_ports(report, settings, token_path)
    check_settings(report, settings, settings_error)
    manifests = check_manifests(report, roots)
    check_approvals(report, manifests, load_approvals(settings, args.approvals))

    print()
    print("== 结论")
    if report.failures:
        print(f"   {len(report.failures)} 项失败、{len(report.warnings)} 项警告 —— 先修掉失败项")
        return 1
    if report.warnings:
        print(f"   没有失败项，但有 {len(report.warnings)} 项警告 —— 可以用，注意上面的修复建议")
        return 0
    print("   全部通过 —— 宿主与插件都就绪")
    return 0


if __name__ == "__main__":
    sys.exit(main())
