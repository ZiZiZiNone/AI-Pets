#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import sys
import threading
import time

TOKEN_FILE_NAME = ".pet_ws_token"
APP_IDENTIFIER = "com.aipets.microkernel"
DEFAULT_PORTS = range(9527, 9538)
SELFTEST_TOKEN = "selftest_token"


def token_file_candidates() -> list[Path]:
    """Where the host may have written the bus token, nearest first.

    The working directory comes first, which covers a development or portable run.
    An installed build falls back to the app data directory, because a per-machine
    install lives in `Program Files`, where a standard user cannot create files.
    """
    candidates = [Path(TOKEN_FILE_NAME)]
    for env_var in ("APPDATA", "XDG_DATA_HOME"):
        base = os.environ.get(env_var)
        if base:
            candidates.append(Path(base) / APP_IDENTIFIER / TOKEN_FILE_NAME)
    candidates.append(Path.home() / ".local" / "share" / APP_IDENTIFIER / TOKEN_FILE_NAME)
    return candidates


def read_local_token() -> str:
    tried: list[Path] = []
    for candidate in token_file_candidates():
        tried.append(candidate)
        if not candidate.exists():
            continue
        token = candidate.read_text(encoding="utf-8").strip()
        if not token:
            raise ConnectionError(
                f"{candidate} is empty - the host bus token was not issued."
            )
        return token
    locations = "\n  ".join(str(path) for path in tried)
    raise ConnectionError(
        f"bus token not found. Start AI-Pets first, then retry. Looked in:\n  {locations}"
    )


class StdlibWebSocketClient:
    def __init__(self, host: str = "127.0.0.1", port: int = 9527, origin: str = "http://localhost"):
        self.host = host
        self.port = port
        self.origin = origin
        self.sock: socket.socket | None = None

    def connect(self) -> None:
        raw_sock = socket.create_connection((self.host, self.port), timeout=4.0)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET / HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Origin: {self.origin}\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        raw_sock.sendall(handshake.encode("utf-8"))

        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = raw_sock.recv(1024)
            if not chunk:
                raise ConnectionError("WebSocket handshake closed unexpectedly")
            resp += chunk

        header_line = resp.split(b"\r\n", 1)[0].decode("utf-8", errors="replace")
        if "101" not in header_line:
            raise ConnectionError(f"Handshake rejected: {header_line}")

        expected_accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if expected_accept not in resp.decode("utf-8", errors="replace"):
            raise ConnectionError("Invalid Sec-WebSocket-Accept header")

        self.sock = raw_sock

    def send_json(self, payload: dict) -> None:
        if not self.sock:
            raise RuntimeError("Socket not connected")
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        mask_key = os.urandom(4)
        header = bytearray([0x81])

        length = len(data)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))

        header.extend(mask_key)
        masked = bytearray(length)
        for i in range(length):
            masked[i] = data[i] ^ mask_key[i % 4]

        self.sock.sendall(header + masked)

    def recv_text(self) -> str:
        if not self.sock:
            raise RuntimeError("Socket not connected")
        first_two = self._recv_exact(2)
        b1, b2 = first_two[0], first_two[1]
        masked = (b2 & 0x80) != 0
        length = b2 & 0x7F

        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]

        mask_key = self._recv_exact(4) if masked else b""
        payload = bytearray(self._recv_exact(length))
        if masked:
            for i in range(length):
                payload[i] ^= mask_key[i % 4]

        opcode = b1 & 0x0F
        if opcode == 0x8:
            raise ConnectionError("Server closed the WebSocket connection")
        if opcode == 0x9:
            # The host drives the heartbeat, so a client that ignores Pings still
            # answers them and keeps the connection alive.
            self._send_control_frame(0xA, bytes(payload))
            return self.recv_text()
        return payload.decode("utf-8", errors="replace")

    def _send_control_frame(self, opcode: int, payload: bytes) -> None:
        if not self.sock:
            raise RuntimeError("Socket not connected")
        mask_key = os.urandom(4)
        header = bytearray([0x80 | opcode, 0x80 | len(payload)])
        header.extend(mask_key)
        masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _recv_exact(self, n: int) -> bytes:
        assert self.sock is not None
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Socket closed while reading frame")
            buf += chunk
        return buf

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None


def connect_to_active_pet_port(ports=DEFAULT_PORTS) -> StdlibWebSocketClient:
    for port in ports:
        client = StdlibWebSocketClient(port=port)
        try:
            client.connect()
            print(f"[+] Connected -> ws://127.0.0.1:{port}")
            return client
        except Exception:
            continue
    raise ConnectionError("AI-Pets not reachable on ports 9527..9537")


def run_protocol_steps(ws: StdlibWebSocketClient, token: str, pause_sec: float = 0.8) -> None:
    ws.send_json({
        "token": token,
        "priority": 1,
        "msg_type": "speak",
        "text": "⚡ 外部智能助手节点已通过鉴权接入微内核总线！",
        "emotion": "smile",
        "motion": "happy",
        "duration_ms": 4000,
    })
    print("[1/5] speak:", ws.recv_text())
    time.sleep(pause_sec)

    ws.send_json({
        "token": token,
        "priority": 1,
        "msg_type": "safe_action",
        "action": {"action_id": "switch_emotion", "params": {"emotion": "smile"}},
    })
    print("[2/5] safe_action:", ws.recv_text())
    time.sleep(pause_sec)

    ws.send_json({
        "token": token,
        "jsonrpc": "2.0",
        "id": 101,
        "app_id": "ai_copilot_plugin",
        "method": "menu.register",
        "params": {
            "app_id": "ai_copilot_plugin",
            "menus": [
                {
                    "id": "ext_ai_copilot",
                    "label": "智能助手",
                    "icon": "🤖",
                    "children": [
                        {
                            "id": "ai_code_review",
                            "label": "代码质量扫描",
                            "icon": "🔍",
                            "badge": "AI",
                            "action": {
                                "type": "emit",
                                "app_id": "internal",
                                "event": "pet.quick_action",
                                "payload": {
                                    "motion": "happy",
                                    "expression": "smile",
                                    "text": "🤖 [AI Copilot] 静态扫描完毕：零高危漏洞 ✨",
                                },
                            },
                        },
                        {
                            "id": "ai_focus_sprint",
                            "label": "开启25m冲刺",
                            "icon": "🍅",
                            "action": {
                                "type": "emit",
                                "app_id": "internal",
                                "event": "pomodoro.start",
                                "payload": {
                                    "minutes": 25,
                                    "mode": "focus",
                                    "label": "AI 结对编程冲刺",
                                },
                            },
                        },
                    ],
                }
            ],
        },
    })
    print("[3/5] menu.register:", ws.recv_text())
    time.sleep(pause_sec)

    ws.send_json({
        "token": token,
        "jsonrpc": "2.0",
        "id": 102,
        "app_id": "ai_copilot_plugin",
        "method": "hud.draw",
        "params": {
            "annotations": [
                {
                    "id": "ext_ai_hud_lock",
                    "app_id": "ai_copilot_plugin",
                    "type": "box",
                    "x": 220,
                    "y": 140,
                    "w": 380,
                    "h": 200,
                    "color": "#10b981",
                    "label": "🤖 AI COPILOT // 实时语义分析锁定区",
                    "sublabel": "外部热插拔节点投射 · 物理鼠标穿透激活",
                    "countdownSec": 10,
                }
            ]
        },
    })
    print("[4/5] hud.draw:", ws.recv_text())

    ws.send_json({
        "token": token,
        "jsonrpc": "2.0",
        "id": 103,
        "app_id": "ai_copilot_plugin",
        "method": "panel.update",
        "params": {"log_line": "[AI-Copilot] 外部插件热插拔联调通过 ✨"},
    })
    print("[5/5] panel.update:", ws.recv_text())


def run_selftest() -> int:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    port = srv.getsockname()[1]
    srv.listen(1)

    def mock_host() -> None:
        conn, _ = srv.accept()
        req = b""
        while b"\r\n\r\n" not in req:
            req += conn.recv(1024)
        key = ""
        for line in req.decode("utf-8").split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        conn.sendall(
            f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode("utf-8")
        )
        for _ in range(5):
            hdr = conn.recv(2)
            if not hdr:
                break
            length = hdr[1] & 0x7F
            if length == 126:
                length = struct.unpack("!H", conn.recv(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", conn.recv(8))[0]
            mask = conn.recv(4)
            body = bytearray(conn.recv(length))
            for i in range(length):
                body[i] ^= mask[i % 4]
            pkt = json.loads(body.decode("utf-8"))
            reply = json.dumps({"status": "ok", "echo": pkt.get("method") or pkt.get("msg_type")}).encode("utf-8")
            conn.sendall(bytes([0x81, len(reply)]) + reply)
        conn.close()
        srv.close()

    t = threading.Thread(target=mock_host, daemon=True)
    t.start()

    ws = connect_to_active_pet_port(ports=[port])
    try:
        # The mock host echoes any token, so the offline run uses a synthetic one
        # instead of requiring a token file from a running host.
        run_protocol_steps(ws, SELFTEST_TOKEN, pause_sec=0.02)
    finally:
        ws.close()
    t.join(timeout=2.0)
    print("[PASS] Offline RFC 6455 WebSocket 5-step protocol self-test succeeded.")
    return 0


def expect_unauthorized(ws: StdlibWebSocketClient, payload: dict, label: str) -> bool:
    ws.send_json(payload)
    reply = json.loads(ws.recv_text())
    rejected = reply.get("status") == "error" and "Unauthorized" in reply.get("reason", "")
    mark = "PASS" if rejected else "FAIL"
    print(f"[{mark}] {label} -> {reply}")
    return rejected


def run_auth_check() -> int:
    """Every inbound packet must carry the process token, hotplug methods included."""
    token = read_local_token()
    ws = connect_to_active_pet_port()
    try:
        results = [
            expect_unauthorized(
                ws, {"method": "pet.act", "params": {}}, "pet.act without token"
            ),
            expect_unauthorized(
                ws,
                {"method": "menu.register", "token": "dev_fallback_token", "params": {}},
                "menu.register with removed dev backdoor",
            ),
            expect_unauthorized(
                ws,
                {"method": "panel.open", "token": "wrong-token", "params": {}},
                "panel.open with wrong token",
            ),
            expect_unauthorized(
                ws, {"msg_type": "speak", "text": "no token"}, "speak without token"
            ),
            expect_unauthorized(
                ws,
                {
                    "msg_type": "safe_action",
                    "token": "wrong-token",
                    "action": {
                        "action_id": "switch_emotion",
                        "params": {"emotion": "smile"},
                    },
                },
                "safe_action with wrong token",
            ),
        ]
    finally:
        ws.close()

    if all(results):
        print(f"[PASS] All {len(results)} unauthorized packets were rejected.")
        return 0
    print(f"[FAIL] {results.count(False)} of {len(results)} unauthorized packets leaked.")
    return 1


def run_external_test() -> int:
    if "--selftest" in sys.argv:
        return run_selftest()
    if "--authcheck" in sys.argv:
        return run_auth_check()
    try:
        token = read_local_token()
        ws = connect_to_active_pet_port()
    except ConnectionError as err:
        print(f"[!] {err} (Tip: pass --selftest for offline protocol verification)")
        return 1

    try:
        run_protocol_steps(ws, token, pause_sec=0.8)
    finally:
        ws.close()
        print("[+] Disconnected.")

    return 0


if __name__ == "__main__":
    sys.exit(run_external_test())
