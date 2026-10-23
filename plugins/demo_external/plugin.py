#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""示例插件本体：只发描述，不自己画界面。

它做两件事，而且只有两件：

  pet.say  —— 给桌宠一句要显示在气泡里的文字；
  hud.draw —— 给出 HUD 标注的位置、尺寸和文字。

插件自己不开窗口、不画图、不贴图：它只描述「要显示什么」，宿主决定怎么显示。这是插件
体系的硬规矩——每个插件都是一张说明，不是一套界面。想要自己的界面，宿主有 panel.open。

只用标准库，不装任何依赖。

用法：
    python plugins/demo_external/plugin.py
    python plugins/demo_external/plugin.py --port 9527
    python plugins/demo_external/plugin.py --text "今天也辛苦啦"
"""

import argparse
import base64
import hashlib
import json
import os
import re
import socket
import struct
import sys
from pathlib import Path

try:  # the Windows console is a legacy code page; page text is not.
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

PLUGIN_ID = "demo_external"
APP_IDENTIFIER = "com.aipets.microkernel"
TOKEN_FILE_NAME = ".pet_ws_token"
REPO = Path(__file__).resolve().parent.parent.parent
DEFAULT_TEXT = "外部插件已上线：这句话来自 plugins/demo_external。"
DEFAULT_PORT_RANGE = (9527, 9537)


def token_candidates():
    """令牌文件可能在哪，顺序与宿主写入的顺序一致。"""
    candidates = [REPO / TOKEN_FILE_NAME]
    for env_var in ("APPDATA", "XDG_DATA_HOME"):
        base = os.environ.get(env_var)
        if base:
            candidates.append(Path(base) / APP_IDENTIFIER / TOKEN_FILE_NAME)
    candidates.append(Path.home() / ".local" / "share" / APP_IDENTIFIER / TOKEN_FILE_NAME)
    return candidates


def read_token():
    """读总线令牌。读不到就说清楚该做什么。"""
    tried = []
    for candidate in token_candidates():
        tried.append(str(candidate))
        if not candidate.is_file():
            continue
        token = candidate.read_text(encoding="utf-8").strip()
        if token:
            return token
        print(f"令牌文件是空的：{candidate}", file=sys.stderr)
    print("找不到总线令牌。宿主启动时才会签发它——先启动桌宠宿主再跑这个插件。", file=sys.stderr)
    print("找过这些地方：", file=sys.stderr)
    for path in tried:
        print(f"  {path}", file=sys.stderr)
    raise SystemExit(2)


def port_range():
    """从 config/settings.yaml 里读端口区间。读不到就用默认的 9527~9537。"""
    settings = REPO / "config" / "settings.yaml"
    if not settings.is_file():
        return DEFAULT_PORT_RANGE
    match = re.search(
        r"ws_port_range:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]",
        settings.read_text(encoding="utf-8"),
    )
    if not match:
        return DEFAULT_PORT_RANGE
    return int(match.group(1)), int(match.group(2))


def find_port(low, high):
    """在区间里找真正在监听的端口。宿主从区间起点顺延找空位，不能写死一个。"""
    for port in range(low, high + 1):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return port
        except OSError:
            continue
    return None


class Bus:
    """最小 WebSocket 客户端：握手、发一帧、收一帧。标准库够用，不装依赖。"""

    def __init__(self, port):
        self.port = port
        self.sock = None
        self.buffer = b""

    def connect(self):
        self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=5.0)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET / HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(handshake.encode("ascii"))
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("握手被对面关掉了")
            raw += chunk
        head = raw.split(b"\r\n", 1)[0].decode("utf-8", "replace")
        if "101" not in head:
            raise ConnectionError(f"握手被拒绝：{head}")
        expected = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if expected not in raw.decode("utf-8", "replace"):
            raise ConnectionError("Sec-WebSocket-Accept 不对")

    def send(self, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        frame = bytearray([0x81])
        length = len(data)
        if length < 126:
            frame.append(0x80 | length)
        elif length < 65536:
            frame.append(0x80 | 126)
            frame.extend(struct.pack("!H", length))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        frame.extend(mask)
        frame.extend(bytes(byte ^ mask[index % 4] for index, byte in enumerate(data)))
        self.sock.sendall(bytes(frame))

    def _read(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("连接被对面关掉了")
            self.buffer += chunk
        out, self.buffer = self.buffer[:count], self.buffer[count:]
        return out

    def recv(self):
        """收一帧文本。ping/pong 直接跳过。"""
        while True:
            first, second = self._read(2)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            payload = self._read(length)
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode == 0x8:
                raise ConnectionError("对面关闭了连接")

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description="示例外部插件")
    parser.add_argument("--port", type=int, help="直接指定总线端口（默认在配置区间里找）")
    parser.add_argument("--text", default=DEFAULT_TEXT, help="要放进气泡的一句话")
    args = parser.parse_args(argv)

    token = read_token()
    if args.port:
        port = args.port
    else:
        low, high = port_range()
        port = find_port(low, high)
        if port is None:
            print(
                f"{low}~{high} 上没有在监听的端口——桌宠宿主多半没在跑。先启动它再试。",
                file=sys.stderr,
            )
            return 2

    bus = Bus(port)
    try:
        bus.connect()
        print(f"已连上桌宠总线：127.0.0.1:{port}")

        bus.send(
            {
                "token": token,
                "jsonrpc": "2.0",
                "id": 1,
                "app_id": PLUGIN_ID,
                "method": "pet.say",
                "params": {"text": args.text, "duration_ms": 4000, "priority": "P2"},
            }
        )
        print("pet.say   ->", bus.recv())

        bus.send(
            {
                "token": token,
                "jsonrpc": "2.0",
                "id": 2,
                "app_id": PLUGIN_ID,
                "method": "hud.draw",
                "params": {
                    "annotations": [
                        {
                            "id": "demo_external_note",
                            "app_id": PLUGIN_ID,
                            "type": "box",
                            "x": 220,
                            "y": 140,
                            "w": 380,
                            "h": 120,
                            "color": "#38bdf8",
                            "label": "外部插件示例",
                            "sublabel": "只发描述，界面由宿主画",
                            "countdownSec": 10,
                        }
                    ]
                },
            }
        )
        print("hud.draw  ->", bus.recv())
    finally:
        bus.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
