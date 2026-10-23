#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI-Pets 总线桥：让本地 AI 编程助手（Claude Code / Codex / 任意脚本）驱动桌宠。

只依赖标准库。助手脚本经常被复制到别人的机器、别人的 CI 里跑，
「先 pip install websocket-client」会把「复制即用」变成「先装依赖」，
所以 RFC 6455 的握手与帧格式在这里手写——总共不到 100 行。

    python pet_bridge.py status
    python pet_bridge.py say "编译通过"
    python pet_bridge.py act happy "测试全绿"

协议以仓库源码为准：src-tauri/src/ws_server.rs
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import time
from pathlib import Path
from typing import Any, Optional

# 宿主应用标识，与 src-tauri/tauri.conf.json 的 identifier 一致。
# 应用数据目录名由它决定（Windows: %APPDATA%\<identifier>）。
APP_IDENTIFIER = "com.aipets.microkernel"
TOKEN_FILE_NAME = ".pet_ws_token"
# 宿主生成令牌的固定前缀（src-tauri/src/ws_server.rs::TOKEN_PREFIX）。
TOKEN_PREFIX = "pet_tk_"
# 宿主扫描端口的区间（config/settings.yaml 的 host.ws_port_range 默认值）。
DEFAULT_PORTS = tuple(range(9527, 9538))
DEFAULT_APP_ID = "agent_bridge"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class BridgeError(Exception):
    """给用户看的错误：直接打印，不带堆栈。"""


# --------------------------------------------------------------------------
# 令牌
# --------------------------------------------------------------------------
def token_file_candidates() -> list[Path]:
    """宿主可能写令牌的位置，按「离开发者最近」排。

    顺序与宿主 src-tauri/src/main.rs::token_path_candidates 对齐：
    工作目录优先（开发或便携运行），然后是 per-user 应用数据目录
    （Windows 是 %APPDATA%\\com.aipets.microkernel，
      Linux 是 ~/.local/share/com.aipets.microkernel）。
    """
    candidates = [Path.cwd() / TOKEN_FILE_NAME]
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / APP_IDENTIFIER / TOKEN_FILE_NAME)
    candidates.append(Path.home() / ".local" / "share" / APP_IDENTIFIER / TOKEN_FILE_NAME)
    return candidates


def read_token(explicit: Optional[Path]) -> tuple[str, Path]:
    """读取总线令牌，返回 (令牌, 实际来源文件)。

    令牌每次宿主启动都会重新生成，所以不能缓存——每次用都重读。
    """
    if explicit is not None:
        path = explicit.expanduser()
        if not path.is_file():
            raise BridgeError(f"指定的令牌文件不存在：{path}")
        token = path.read_text(encoding="utf-8").strip()
        if not token:
            raise BridgeError(f"令牌文件是空的：{path}")
        return token, path

    tried: list[Path] = []
    for candidate in token_file_candidates():
        tried.append(candidate)
        if not candidate.is_file():
            continue
        token = candidate.read_text(encoding="utf-8").strip()
        if token:
            return token, candidate

    listed = "\n  ".join(str(path) for path in tried)
    raise BridgeError(
        "找不到总线令牌。请先启动 AI-Pets 桌面端再重试。\n已查找：\n  " + listed
    )


# --------------------------------------------------------------------------
# 最小 WebSocket 客户端
# --------------------------------------------------------------------------
class BusClient:
    """连 127.0.0.1 上的本地总线。

    只做三件事：握手、发文本帧、收文本帧。控制帧（心跳）按 RFC 6455 应答，
    因为宿主靠心跳判断连接是否还活着——不回 Pong 的话连接会被掐掉。
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 9527, timeout: float = 5.0) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self._sock: Optional[socket.socket] = None

    # -- 连接 -------------------------------------------------------------
    def connect(self) -> None:
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as err:
            raise BridgeError(f"连不上 {self.host}:{self.port}（{err}）") from err
        sock.settimeout(self.timeout)
        self._sock = sock

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        # 故意不带 Origin 头：宿主只在「带了 Origin」时才做白名单比对，
        # 而 Origin 是浏览器的东西，脚本客户端没有它就不该硬凑一个。
        request = (
            f"GET / HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"\r\n"
        )
        try:
            sock.sendall(request.encode("ascii"))
            response = self._read_until(b"\r\n\r\n")
        except BridgeError:
            self.close()
            raise
        except OSError as err:
            self.close()
            raise BridgeError(f"握手失败：{err}") from err

        status_line = response.split(b"\r\n", 1)[0].decode("utf-8", errors="replace")
        if " 101" not in status_line:
            self.close()
            raise BridgeError(f"握手被拒：{status_line.strip()}")

        expected = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        if expected.lower() not in response.decode("utf-8", errors="replace").lower():
            self.close()
            raise BridgeError("握手被拒：Sec-WebSocket-Accept 校验不过。")

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    # -- 帧 ---------------------------------------------------------------
    def _read_until(self, marker: bytes) -> bytes:
        assert self._sock is not None
        buffer = b""
        deadline = time.monotonic() + self.timeout
        while marker not in buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BridgeError("握手超时：宿主没有回应。")
            self._sock.settimeout(remaining)
            try:
                chunk = self._sock.recv(1024)
            except socket.timeout as err:
                raise BridgeError("握手超时：宿主没有回应。") from err
            if not chunk:
                raise BridgeError("握手期间连接被关闭。")
            buffer += chunk
        return buffer

    def _recv_exact(self, size: int) -> bytes:
        assert self._sock is not None
        chunks: list[bytes] = []
        remaining = size
        while remaining > 0:
            chunk = self._sock.recv(remaining)
            if not chunk:
                raise BridgeError("连接被宿主关闭。")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _recv_frame(self) -> tuple[int, bytes]:
        first, second = self._recv_exact(2)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        return opcode, payload

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        assert self._sock is not None
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        header.extend(mask)
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    # -- 报文 -------------------------------------------------------------
    def send_json(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_frame(0x1, data)

    def recv_reply(self, timeout: Optional[float] = None) -> dict[str, Any]:
        """读到一条带 status 的回复为止。

        宿主还会往总线上推事件帧（没有 status 字段），那些不是回复，
        直接丢掉继续读——否则回复会被前面的事件挤掉。
        """
        limit = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + limit
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BridgeError(f"等待宿主回复超时（{limit:g} 秒）。")
            assert self._sock is not None
            self._sock.settimeout(remaining)
            try:
                opcode, payload = self._recv_frame()
            except socket.timeout as err:
                raise BridgeError(f"等待宿主回复超时（{limit:g} 秒）。") from err

            if opcode == 0x8:
                raise BridgeError("宿主关闭了连接。")
            if opcode == 0x9:
                # 宿主每 22 秒发一次心跳；不回 Pong 的话连接会被心跳超时掐掉。
                self._send_frame(0xA, payload)
                continue
            if opcode != 0x1:
                continue
            try:
                message = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if isinstance(message, dict) and "status" in message:
                return message


# --------------------------------------------------------------------------
# 总线会话
# --------------------------------------------------------------------------
def connect_bus(port: Optional[int], connect_timeout: float) -> tuple[BusClient, int]:
    """逐个尝试端口，返回连上的客户端。

    宿主不把端口写死：它从 9527 起顺延找可用端口，所以客户端也必须扫。
    扫端口用比等回复更短的超时：端口段有 11 个，宿主没开的时候每个都等满
    回复超时的话，一次失败要等半分钟，用户会以为程序卡死了。
    """
    ports = [port] if port is not None else list(DEFAULT_PORTS)
    failures: list[str] = []
    for candidate in ports:
        client = BusClient(port=candidate, timeout=connect_timeout)
        try:
            client.connect()
            return client, candidate
        except BridgeError as err:
            failures.append(f"{candidate}：{err}")
            client.close()
    listed = "\n  ".join(failures)
    raise BridgeError(
        "连不上 AI-Pets 总线（127.0.0.1:9527-9537）。\n"
        "宿主可能没启动，或者整段端口被占用。逐个尝试的结果：\n  " + listed
    )


def build_packet(
    token: str, app_id: str, method: str, params: dict[str, Any], request_id: int
) -> dict[str, Any]:
    """方法路径的报文。

    token 必带（鉴权在方法分发之前）；app_id 放在顶层，宿主按它路由事件、
    也按它查权限；params 整体透传给前端。
    """
    return {
        "token": token,
        "jsonrpc": "2.0",
        "id": request_id,
        "app_id": app_id,
        "method": method,
        "params": params,
    }


def describe_reply(reply: dict[str, Any]) -> str:
    if reply.get("status") == "error":
        return f"被拒绝：{reply.get('reason', '（宿主没有给原因）')}"
    return f"已受理：{reply.get('method', '（宿主没有回方法名）')}"


def hint_for(reply: dict[str, Any], app_id: str) -> str:
    """错误回复里给出下一步该做什么，而不是只把原因原样扔回去。"""
    reason = str(reply.get("reason", ""))
    if "Unauthorized" in reason:
        return (
            "[提示] 令牌每次宿主启动都会重新生成；删掉残留的 .pet_ws_token、"
            "重启宿主后再读一次。"
        )
    # 权限层的拒绝文案是中文：权限不足：app「x」调用方法「y」…
    if "权限不足" in reason or "不在总线允许清单内" in reason:
        return (
            f"[提示] app_id '{app_id}' 没有这项权限。"
            "把它注册成插件并在伴生舱里批准（见 docs/插件接入指南.md）。"
        )
    if "菜单动作被拒" in reason:
        return (
            "[提示] 总线注册的菜单项只允许 emit / panel / url / open 四种动作，"
            "不能挂会执行命令的 exec。"
        )
    return ""


def build_parser() -> argparse.ArgumentParser:
    # 公共选项用 SUPPRESS 当默认值：同一份选项同时挂在主解析器和子命令上时，
    # 子命令的默认值会把主解析器已经读到的值覆盖掉。
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--token-file",
        type=Path,
        default=argparse.SUPPRESS,
        help="令牌文件路径（默认按工作目录、%%APPDATA%%、~/.local/share 依次找）",
    )
    common.add_argument(
        "--app-id",
        default=argparse.SUPPRESS,
        help=f"调用方标识（默认 {DEFAULT_APP_ID}；权限按它查）",
    )
    common.add_argument(
        "--port",
        type=int,
        default=argparse.SUPPRESS,
        help="只连这一个端口（默认扫描 9527-9537）",
    )
    common.add_argument(
        "--timeout",
        type=float,
        default=argparse.SUPPRESS,
        help="等待宿主回复的超时秒数（默认 5）",
    )
    common.add_argument(
        "--connect-timeout",
        type=float,
        default=argparse.SUPPRESS,
        help="扫描端口时每个端口的连接超时秒数（默认 1；扫 11 个端口别太磨蹭）",
    )

    parser = argparse.ArgumentParser(
        prog="pet_bridge.py",
        parents=[common],
        description="让 AI 编程助手通过本地总线驱动 AI-Pets 桌宠。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python pet_bridge.py status\n"
            "  python pet_bridge.py say \"编译通过\"\n"
            "  python pet_bridge.py act happy \"测试全绿\"\n"
            "  python pet_bridge.py driver attach\n"
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True, metavar="命令")

    sub.add_parser("status", parents=[common], help="检查总线连通性与令牌是否被接受")

    say = sub.add_parser("say", parents=[common], help="弹一条语音气泡")
    say.add_argument("text", nargs="+", help="气泡文本")
    say.add_argument("--duration", type=int, default=None, help="气泡持续毫秒数（默认宿主决定）")

    act = sub.add_parser("act", parents=[common], help="让桌宠演一段动作并说话")
    act.add_argument("motion", help="动作名，例如 happy / think")
    act.add_argument("text", nargs="*", help="台词（可省略）")
    act.add_argument("--expression", default=None, help="表情名，例如 smile")
    act.add_argument("--duration", type=int, default=None, help="动作持续毫秒数")
    act.add_argument(
        "--priority",
        default=None,
        choices=["P0", "P1", "P2", "P3"],
        help="优先级（方法路径传字符串；P0 最高）",
    )

    driver = sub.add_parser("driver", parents=[common], help="接管或归还「驱动权」")
    driver.add_argument("action", choices=["attach", "detach"], help="attach 接管，detach 归还")

    raw = sub.add_parser("raw", parents=[common], help="发送任意方法报文（JSON）")
    raw.add_argument(
        "json",
        help=(
            '整条报文，例如 \'{"method":"panel.update","params":{}}\'；'
            "以 @ 开头则当作文件路径读取（Windows 的 PowerShell 会吃掉命令行里的双引号）"
        ),
    )

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    token_file = getattr(args, "token_file", None)
    app_id = getattr(args, "app_id", None) or DEFAULT_APP_ID
    port = getattr(args, "port", None)
    timeout = getattr(args, "timeout", None) or 5.0
    connect_timeout = getattr(args, "connect_timeout", None) or 1.0

    try:
        token, token_path = read_token(token_file)
        client, active_port = connect_bus(port, connect_timeout)
    except BridgeError as err:
        print(f"[失败] {err}", file=sys.stderr)
        return 1

    request_id = 1
    try:
        if args.command == "raw":
            raw_text = args.json
            if raw_text.startswith("@"):
                source = Path(raw_text[1:]).expanduser()
                if not source.is_file():
                    print(f"[失败] 报文文件不存在：{source}", file=sys.stderr)
                    return 2
                raw_text = source.read_text(encoding="utf-8")
            try:
                payload = json.loads(raw_text)
            except json.JSONDecodeError as err:
                print(f"[失败] raw 的参数不是合法 JSON：{err}", file=sys.stderr)
                return 2
            if not isinstance(payload, dict):
                print("[失败] raw 的参数必须是一个 JSON 对象。", file=sys.stderr)
                return 2
            payload.setdefault("token", token)
            payload.setdefault("app_id", app_id)
            payload.setdefault("id", request_id)
            client.send_json(payload)
        else:
            if args.command == "status":
                # 用 pet.say 探路：未登记的 app_id 也允许 pet:speak，
                # 所以这一条在任何权限下都通得过。1 毫秒的空气泡肉眼看不见，
                # 却把「连得上 + 令牌对 + 方法被受理」一次验完。
                method, params = "pet.say", {"text": "", "duration_ms": 1}
            elif args.command == "say":
                method = "pet.say"
                params = {"text": " ".join(args.text)}
                if args.duration is not None:
                    params["duration_ms"] = args.duration
            elif args.command == "act":
                method = "pet.act"
                params = {"motion": args.motion}
                if args.text:
                    params["text"] = " ".join(args.text)
                if args.expression is not None:
                    params["expression"] = args.expression
                if args.duration is not None:
                    params["duration_ms"] = args.duration
                if args.priority is not None:
                    params["priority"] = args.priority
            else:  # driver
                method, params = "pet.driver", {"action": args.action}

            client.send_json(build_packet(token, app_id, method, params, request_id))

        reply = client.recv_reply(timeout)
    except BridgeError as err:
        print(f"[失败] {err}", file=sys.stderr)
        return 1
    finally:
        client.close()

    print(f"[总线] ws://127.0.0.1:{active_port}  app_id={app_id}  令牌来源={token_path}")
    print(f"[回复] {json.dumps(reply, ensure_ascii=False)}")
    print(f"[结论] {describe_reply(reply)}")

    if reply.get("status") == "error":
        hint = hint_for(reply, app_id)
        if hint:
            print(hint, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    # Windows 控制台默认可能是 GBK，中文和符号容易炸；统一改成 UTF-8 且不因
    # 编码问题崩掉——这个脚本常被塞进 CI，崩在打印上比不打印更糟。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
