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

It then talks to the in-process WebSocket bus, because a bus reply is the only place where
"the host refused this" and "the host silently pretended to succeed" are distinguishable.
The pet-switch round trip is checked in both directions on purpose: a switch to a folder
that is not installed must come back as `status: error` naming the id (it used to answer
`status: ok`), while a switch to an installed pet must still answer `status: ok`. That
part *is* a pass/fail gate and fails the run; the capability part only reports.

The app it starts is killed again, together with its children.

Usage:
    python scripts/runtime-smoke.py                 # start, probe, exercise the bus, stop
    python scripts/runtime-smoke.py --read-only     # do not click anything in the page
    python scripts/runtime-smoke.py --no-bus        # skip the bus round trip
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
BUS_PORT = 9527
APP_IDENTIFIER = "com.aipets.microkernel"
TOKEN_FILE_NAME = ".pet_ws_token"
# A well-formed id that is deliberately not installed, so the refusal path is the one used.
ABSENT_PET_ID = "runtime_smoke_absent_pet"

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

OPEN_MENU_JS = """
(function () {
  var node = document.querySelector('.tactical-wing-node');
  if (node) return 'already-open';
  var b = [...document.querySelectorAll('button')].find(function (x) {
    return x.textContent.trim() === '菜单';
  });
  if (!b) return 'no-menu-button';
  b.click();
  return 'clicked';
})()
"""

# The radial menu is where `menu_interaction` shows up: opening it reports its warnings and,
# with the shipped `auto_expand_first: true`, the first branch opens its children by itself.
MENU_JS = """
JSON.stringify({
  nodes: [...document.querySelectorAll('.tactical-wing-node')].map(function (n) {
    return n.textContent.trim();
  }),
  submenu: [...document.querySelectorAll('.subdeck-blade')].map(function (n) {
    return n.textContent.trim();
  })
})
"""

# Console output is collected *inside the page* rather than from the DevTools event stream:
# on this WebView2 build `Runtime.consoleAPICalled` never arrives, which was proven by logging
# a known string from the page and never seeing it. Collecting in-page also means the probe
# can tell "the app said nothing" apart from "we were not listening", because the hook records
# a line of its own before anything else runs.
CONSOLE_HOOK_JS = """
(function () {
  window.__warnCapture = [];
  ['warn', 'error'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      window.__warnCapture.push(level + ': ' + Array.prototype.join.call(arguments, ' '));
      return original.apply(console, arguments);
    };
  });
  return 'hooked';
})()
"""

HOOK_SELF_TEST = "runtime-smoke-hook-self-test"

READ_CAPTURE_JS = "JSON.stringify(window.__warnCapture)"

BUBBLE_TEXT_JS = (
    "(document.querySelector('.holo-speech-visor') || {}).textContent || ''"
)

# One submenu blade, driven three ways: a plain click, a press held past `long_press_ms`
# whose release also produces a click, and (elsewhere) nothing. `mode` is substituted below.
BLADE_JS = """
(function () {
  var blades = document.querySelectorAll('.subdeck-blade');
  if (!blades.length) return 'no-blade';
  var el = blades[0];
  var mode = '__MODE__';
  if (mode === 'click') {
    el.click();
  } else if (mode === 'press') {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  } else if (mode === 'release') {
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    el.click();
  }
  return mode;
})()
"""

# Reopens the menu and re-expands the first branch. Running an item closes the menu entirely,
# so this handles both states: no menu at all, and a menu that is open but collapsed.
ENSURE_BLADES_JS = """
(function () {
  if (document.querySelectorAll('.subdeck-blade').length) return 'blades-present';
  var nodes = document.querySelectorAll('.tactical-wing-node');
  if (!nodes.length) {
    var button = [...document.querySelectorAll('button')].find(function (x) {
      return x.textContent.trim() === '菜单';
    });
    if (!button) return 'no-menu-button';
    button.click();
    return 'reopened';
  }
  nodes[0].click();
  return 'expanded';
})()
"""


def ensure_blades(session):
    """Get a submenu blade into the DOM, or explain why that was not possible."""
    for _ in range(8):
        if session.evaluate("document.querySelectorAll('.subdeck-blade').length"):
            return True
        step = session.evaluate(ENSURE_BLADES_JS)
        if step == 'no-menu-button':
            return False
        time.sleep(0.5)
    return bool(session.evaluate("document.querySelectorAll('.subdeck-blade').length"))


def read_bubble(session):
    return (session.evaluate(BUBBLE_TEXT_JS) or "").strip()


def wait_for_bubble(session, seconds):
    """Text of the visor once it holds something, or '' if nothing was said in time."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        text = read_bubble(session)
        if text:
            return text
        time.sleep(0.2)
    return ""


def slow_press_round_trip(session):
    """A press held past `long_press_ms` must still act when nothing is bound to long_press.

    This is a judgement, and it is written as an A/B against the same item: the plain click
    calibrates what "did something" looks like for whatever menu is installed (an action that
    says nothing at all skips the check instead of failing it), and the slow press must produce
    the same kind of result. The defect this replaces held the shipped menu completely inert
    for any press of about half a second.
    """
    if not ensure_blades(session):
        print("  no submenu item to drive; skipped")
        return True

    print("  " + str(session.evaluate(BLADE_JS.replace("__MODE__", "click"))))
    baseline = wait_for_bubble(session, 2.5)
    if not baseline:
        print("  the item's action says nothing; calibration impossible, skipped")
        return True
    print(f"  plain click said: {baseline[:48]}")
    deadline = time.time() + 15
    while time.time() < deadline and read_bubble(session):
        time.sleep(0.4)

    if not ensure_blades(session):
        print("  the menu could not be reopened; second half skipped")
        return True
    pressed = session.evaluate(BLADE_JS.replace("__MODE__", "press"))
    if pressed != "press":
        print(f"  pressing failed ({pressed}); second half skipped")
        return True
    time.sleep(0.65)
    session.evaluate(BLADE_JS.replace("__MODE__", "release"))
    slow = wait_for_bubble(session, 2.5)
    if not slow:
        print("  REGRESSION: a press held past long_press_ms did nothing at all")
        return False
    print(f"  slow press said: {slow[:48]}")
    return True


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

    def _read_frame(self):
        first, second = self._read(2)
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read(8))[0]
        return opcode, self._read(length)

    def call(self, method, params=None):
        ident = self.next_id
        self.next_id += 1
        self._send(json.dumps({"id": ident, "method": method, "params": params or {}}))
        for _ in range(500):
            opcode, payload = self._read_frame()
            if opcode != 0x1:
                continue
            message = json.loads(payload.decode("utf-8"))
            if message.get("id") == ident:
                return message
        raise RuntimeError(f"no reply to {method}")

    def send_packet(self, packet):
        self._send(json.dumps(packet, ensure_ascii=False))

    def recv_packet(self):
        for _ in range(200):
            opcode, payload = self._read_frame()
            if opcode != 0x1:
                continue
            return json.loads(payload.decode("utf-8"))
        raise RuntimeError("the bus sent nothing back")

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
    """Return the page targets, waiting until the real bundle is up.

    `/json/list` answers before the app's own webviews have navigated, so the first poll can
    return a bare `about:blank` target. Reporting capabilities for that page would be
    reporting the wrong webview, so the wait continues until a `tauri.localhost` page exists.
    """
    deadline = time.time() + timeout
    last = None
    latest = []
    while time.time() < deadline:
        try:
            latest = http_json(f"http://127.0.0.1:{port}/json/list")
            pages = [t for t in latest if t.get("type") == "page"]
            if any("tauri.localhost" in (t.get("url") or "") for t in pages):
                return latest
        except (urllib.error.URLError, ConnectionError, OSError, ValueError) as exc:
            last = exc
        time.sleep(0.4)
    if latest:
        return latest
    raise SystemExit(f"the app never opened devtools on port {port} ({last})")


def kill_tree(pid):
    """Kill only the process this run started, grandchildren included."""
    subprocess.run(
        ["taskkill", "/PID", str(pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def read_bus_token():
    """The same candidate order the host uses, so this never reads a stale token."""
    candidates = [REPO / TOKEN_FILE_NAME]
    for env_var in ("APPDATA", "XDG_DATA_HOME"):
        base = os.environ.get(env_var)
        if base:
            candidates.append(Path(base) / APP_IDENTIFIER / TOKEN_FILE_NAME)
    candidates.append(Path.home() / ".local" / "share" / APP_IDENTIFIER / TOKEN_FILE_NAME)
    for candidate in candidates:
        if candidate.exists():
            token = candidate.read_text(encoding="utf-8").strip()
            if token:
                return token, candidate
    raise ConnectionError("the host issued no bus token; looked in " + ", ".join(map(str, candidates)))


def installed_pets():
    pets = REPO / "pets"
    if not pets.is_dir():
        return []
    return sorted(p.name for p in pets.iterdir() if (p / "pet.yaml").is_file())


def safe_action(action_id, params):
    return {
        "priority": 1,
        "msg_type": "safe_action",
        "action": {"action_id": action_id, "params": params},
    }


def bus_round_trip(port):
    """Check both directions of one switch: a missing pet must be refused, a real one accepted.

    Returns True when both answers are the ones the fix promises. The old behaviour answered
    `status: ok` for a pet that was never installed, which is exactly what this catches.
    """
    token, token_path = read_bus_token()
    print(f"\n=== bus round trip on 127.0.0.1:{port} (token from {token_path})")
    session = CdpSession(f"ws://127.0.0.1:{port}/")
    session.connect()
    ok = True
    try:
        session.send_packet({"token": token, **safe_action("switch_pet", {"pet_id": ABSENT_PET_ID})})
        refusal = session.recv_packet()
        print(f"switch_pet({ABSENT_PET_ID}) ->", refusal)
        if refusal.get("status") != "error" or ABSENT_PET_ID not in json.dumps(refusal, ensure_ascii=False):
            print("  REGRESSION: a pet that is not installed was not refused by name")
            ok = False

        pets = installed_pets()
        if pets:
            wanted = pets[0]
            session.send_packet({"token": token, **safe_action("switch_pet", {"pet_id": wanted})})
            accepted = session.recv_packet()
            print(f"switch_pet({wanted}) ->", accepted)
            if accepted.get("status") != "ok" or accepted.get("result") != f"pet:{wanted}":
                print("  REGRESSION: an installed pet was not switched to")
                ok = False
        else:
            print("  no installed pet found under pets/, accepted-branch not exercised")
    finally:
        session.close()
    return ok


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--exe", default=str(DEFAULT_EXE), help="binary to start")
    parser.add_argument("--port", type=int, default=DEBUG_PORT, help="devtools port")
    parser.add_argument("--wait", type=float, default=25.0, help="seconds to wait for devtools")
    parser.add_argument("--read-only", action="store_true", help="do not click anything")
    parser.add_argument("--no-bus", action="store_true", help="skip the WebSocket bus round trip")
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
                # Only the main stage carries the dock, the chat bar and the radial menu.
                is_stage = (target.get("url") or "").rstrip("/") == "http://tauri.localhost"
                if args.read_only or not is_stage:
                    continue
                print("stage chat bar:", session.evaluate(CLICK_JS))
                time.sleep(0.6)
                print("stage chat bar state:", session.evaluate(CHAT_BAR_JS))

                print("stage console hook:", session.evaluate(CONSOLE_HOOK_JS))
                session.evaluate(f"console.warn('{HOOK_SELF_TEST}')")
                print("open radial menu:", session.evaluate(OPEN_MENU_JS))
                time.sleep(1.2)
                print("radial menu:", session.evaluate(MENU_JS))
                captured = json.loads(session.evaluate(READ_CAPTURE_JS) or "[]")
                listening = any(HOOK_SELF_TEST in line for line in captured)
                print(f"console capture alive: {listening} · captured {len(captured)} line(s)")
                for line in captured:
                    print("  " + line)
                if not listening:
                    # Without this the empty list above would read as "the app logged
                    # nothing", which is the one conclusion this setup cannot support.
                    print("  CAPTURE BROKEN: the hook's own line never arrived")
                    status = 1

                print("gesture round trip (click vs 650ms press):")
                if not slow_press_round_trip(session):
                    status = 1
            finally:
                session.close()
        if not args.no_bus:
            if not bus_round_trip(BUS_PORT):
                status = 1
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
