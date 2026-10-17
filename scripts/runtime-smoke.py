"""Runtime smoke probe for the *built* application.

Every other check in this repository stops at the source level or at the PE headers of
the release binary. This one starts the binary for real, lets WebView2 load the embedded
bundle, and asks the live pages what they actually are. Two families of question only a
running app can answer:

* What the WebView2 build offers a page (`SpeechRecognition`, `getUserMedia`,
  `MediaRecorder`, `AudioContext`, `speechSynthesis`). The documentation is not allowed to
  guess at these — an API that is absent has to be reported as absent.
* What the rendered entry points say, e.g. the readiness text on the stage recognition
  button, which differs per `audio.stt.provider` and must match the code.

It is **not** a pass/fail gate: it reports what it observed and exits non-zero only when it
cannot observe anything. The app it starts is killed again, together with its children.

Usage:
    python scripts/runtime-smoke.py                 # start, probe, stop
    python scripts/runtime-smoke.py --read-only     # do not click anything in the page
    python scripts/runtime-smoke.py --keep-running  # leave the app up for manual inspection
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:  # the Windows console is a legacy code page; page text is not.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

REPO = Path(__file__).resolve().parent.parent
DEFAULT_EXE = REPO / "src-tauri" / "target" / "release" / "ai-pets.exe"
DEBUG_PORT = 9222

# Reported verbatim in the output, so the probe result can be compared against the docs.
CAPABILITIES_JS = """
JSON.stringify({
  title: document.title,
  path: location.pathname,
  isSecureContext: window.isSecureContext,
  SpeechRecognition: typeof window.SpeechRecognition,
  webkitSpeechRecognition: typeof window.webkitSpeechRecognition,
  getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  MediaRecorder: typeof window.MediaRecorder,
  AudioContext: typeof (window.AudioContext || window.webkitAudioContext),
  speechSynthesis: typeof window.speechSynthesis,
  voiceCount: (window.speechSynthesis ? speechSynthesis.getVoices().length : -1),
  canvasCount: document.querySelectorAll('canvas').length,
  buttons: [...document.querySelectorAll('button')].map(function (b) { return b.textContent.trim(); }).filter(Boolean)
})
"""

CHAT_BAR_JS = """
JSON.stringify({
  chatBar: !!document.querySelector('.inline-chat-bar'),
  micBtn: !!document.querySelector('.chat-mic-btn'),
  micLabel: (document.querySelector('.mic-label') || {}).textContent,
  micTitle: (document.querySelector('.chat-mic-btn') || {}).title,
  micDisabled: (document.querySelector('.chat-mic-btn') || {}).disabled,
  notice: (document.querySelector('.chat-voice-notice') || {}).textContent,
  sendLabel: (document.querySelector('.chat-send-btn') || {}).textContent
})
"""

CLICK_JS = """
(function () {
  var bar = document.querySelector('.inline-chat-bar');
  if (bar) return 'already-open';
  var b = [...document.querySelectorAll('button')].find(function (x) {
    return x.textContent.trim() === '对话';
  });
  if (!b) return 'no-chat-button';
  b.click();
  return 'clicked';
})()
"""


def http_json(url, timeout=2.0):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class CdpSession:
    """Just enough of the DevTools protocol: one HTTP upgrade, then request/reply frames."""

    def __init__(self, ws_url):
        host_port, path = ws_url[len("ws://"):].split("/", 1)
        self.path = "/" + path
        self.host, port = host_port.split(":")
        self.port = int(port)
        self.buffer = b""
        self.next_id = 1

    def connect(self):
        sock = socket.create_connection((self.host, self.port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(request.encode("ascii"))

        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("handshake closed unexpectedly")
            raw += chunk
        head, _, rest = raw.partition(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0].decode("utf-8", "replace")
        expected = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if "101" not in status or expected not in head.decode("utf-8", "replace"):
            raise ConnectionError(f"handshake rejected: {status}")

        self.sock = sock
        self.buffer = rest

    def _read(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("connection closed mid-frame")
            self.buffer += chunk
        out, self.buffer = self.buffer[:count], self.buffer[count:]
        return out

    def _send(self, text):
        payload = text.encode("utf-8")
        frame = bytearray([0x81])
        if len(payload) < 126:
            frame.append(0x80 | len(payload))
        elif len(payload) < 65536:
            frame.append(0x80 | 126)
            frame += struct.pack("!H", len(payload))
        else:
            frame.append(0x80 | 127)
            frame += struct.pack("!Q", len(payload))
        mask = os.urandom(4)
        frame += mask
        frame += bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(frame))

    def call(self, method, params=None):
        ident = self.next_id
        self.next_id += 1
        self._send(json.dumps({"id": ident, "method": method, "params": params or {}}))
        for _ in range(500):
            first, second = self._read(2)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            payload = self._read(length)
            if opcode != 0x1:
                continue
            message = json.loads(payload.decode("utf-8"))
            if message.get("id") == ident:
                return message
        raise RuntimeError(f"no reply to {method}")

    def evaluate(self, expression):
        reply = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        result = reply.get("result", {})
        if "exceptionDetails" in result:
            return {"error": result["exceptionDetails"].get("text", "page raised")}
        return result.get("result", {}).get("value")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def wait_for_debugger(port, timeout):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            return http_json(f"http://127.0.0.1:{port}/json/list")
        except (urllib.error.URLError, ConnectionError, OSError, ValueError) as exc:
            last = exc
            time.sleep(0.4)
    raise SystemExit(f"the app never opened devtools on port {port} ({last})")


def kill_tree(pid):
    """Kill only the process this run started, grandchildren included."""
    subprocess.run(
        ["taskkill", "/PID", str(pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--exe", default=str(DEFAULT_EXE), help="binary to start")
    parser.add_argument("--port", type=int, default=DEBUG_PORT, help="devtools port")
    parser.add_argument("--wait", type=float, default=25.0, help="seconds to wait for devtools")
    parser.add_argument("--read-only", action="store_true", help="do not click anything")
    parser.add_argument("--keep-running", action="store_true", help="leave the app running")
    args = parser.parse_args()

    exe = Path(args.exe)
    if not exe.exists():
        raise SystemExit(
            f"binary not found: {exe}\nBuild it first: npm run build, then "
            "cargo build --release --features custom-protocol --manifest-path src-tauri/Cargo.toml"
        )

    token = REPO / ".pet_ws_token"
    token_before = token.exists()

    environment = dict(os.environ)
    environment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={args.port}"
    app = subprocess.Popen([str(exe)], cwd=str(REPO), env=environment)
    print(f"started {exe.name} as pid {app.pid} with devtools on {args.port}")

    status = 0
    try:
        targets = wait_for_debugger(args.port, args.wait)
        pages = [t for t in targets if t.get("type") == "page"]
        print(f"devtools targets: {len(targets)} (pages: {len(pages)})")
        for target in pages:
            print(f"\n=== {target.get('title')!r}  {target.get('url', '')}")
            session = CdpSession(target["webSocketDebuggerUrl"])
            session.connect()
            try:
                print("capabilities:", session.evaluate(CAPABILITIES_JS))
                if args.read_only:
                    outcome = "skipped (--read-only)"
                else:
                    outcome = session.evaluate(CLICK_JS)
                    time.sleep(0.6)
                print("stage chat bar:", outcome)
                print("stage chat bar state:", session.evaluate(CHAT_BAR_JS))
            finally:
                session.close()
    except (SystemExit, ConnectionError, RuntimeError) as exc:
        print(f"probe failed: {exc}")
        status = 1
    finally:
        if args.keep_running:
            print(f"\nleft running as pid {app.pid} (devtools on {args.port})")
        else:
            kill_tree(app.pid)
            print(f"\nstopped pid {app.pid}")
            time.sleep(1.0)
            if token.exists() and not token_before:
                try:
                    token.unlink()
                    print(f"removed {token.name} (created by this run)")
                except OSError as exc:
                    print(f"could not remove {token}: {exc}")

    return status


if __name__ == "__main__":
    raise SystemExit(main())
