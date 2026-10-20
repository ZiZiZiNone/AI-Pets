"""Checks that the microphone switch in the companion panel really starts the pet listening.

The switch is the whole point of the feature: with it on the pet answers what it hears,
with it off the microphone is never opened. Nothing in the source can prove that the
switch is wired to the right setting — only the running app can.

So the app is asked directly:

  1. The stage's speech recogniser is replaced with a stand-in that only counts how
     many sessions were started and stopped. The real microphone is never touched, so
     no permission prompt appears and nothing is recorded.
  2. The switch is off, and no session may exist.
  3. The switch is clicked on in the companion panel, and a session must appear in the
     stage window.
  4. The switch is clicked off again, and the session must end.

Step 2 is the control: a check that passes while the switch is off proves nothing about
what happens when it is on.

The panel writes `config/settings.yaml` when the switch is used, and that file carries
the project's hand-written comments, which the writer does not preserve. The file is
therefore put back the way it was before the run.

Usage:
    python scripts/mic-smoke.py
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "runtime_smoke", str(Path(__file__).resolve().parent / "runtime-smoke.py")
)
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)

EXE = REPO / "src-tauri" / "target" / "release" / "ai-pets.exe"
SETTINGS = REPO / "config" / "settings.yaml"
PORT = 9222

# A stand-in for the browser's recogniser. It counts sessions and nothing else, so the
# real microphone is never opened.
INSTALL_FAKE = r"""
(() => {
  if (window.__micProbeInstalled) return 'already';
  window.__micProbeInstalled = true;
  window.__micSessions = { started: 0, stopped: 0 };
  const Fake = function () {
    window.__micSessions.started += 1;
    this.start = function () {};
    this.stop = function () { window.__micSessions.stopped += 1; };
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  };
  window.SpeechRecognition = Fake;
  window.webkitSpeechRecognition = Fake;
  return 'installed';
})()
"""

READ_SESSIONS = "JSON.stringify(window.__micSessions || { started: 0, stopped: 0 })"

# The companion panel's switch for the microphone.
TOGGLE_SWITCH = r"""
(() => {
  const rows = [...document.querySelectorAll('.pod-row')];
  const row = rows.find((r) => {
    const label = r.querySelector('.pod-label');
    return label && label.textContent.trim() === '捕捉麦克风';
  });
  if (!row) return 'no-row';
  const button = row.querySelector('.cyber-switch');
  if (!button) return 'no-button';
  const state = button.querySelector('.switch-state');
  const before = state ? state.textContent.trim() : '?';
  button.click();
  return 'clicked-from-' + before;
})()
"""

READ_SWITCH = r"""
(() => {
  const rows = [...document.querySelectorAll('.pod-row')];
  const row = rows.find((r) => {
    const label = r.querySelector('.pod-label');
    return label && label.textContent.trim() === '捕捉麦克风';
  });
  if (!row) return 'no-row';
  const state = row.querySelector('.switch-state');
  return state ? state.textContent.trim() : 'no-state';
})()
"""

DOCK_LABELS = r"""
JSON.stringify([...document.querySelectorAll('.tactical-dock-btn')]
  .map((b) => {
    const label = b.querySelector('.dock-label');
    return (label ? label.textContent : b.textContent).trim();
  }))
"""


def main() -> int:
    if not EXE.exists():
        print(f"the release binary is missing: {EXE}")
        return 1

    backup = SETTINGS.with_suffix(".yaml.mic-probe-backup")
    shutil.copy2(SETTINGS, backup)

    env = dict(os.environ)
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={PORT}"
    running = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq ai-pets.exe", "/NH"],
        capture_output=True,
        text=True,
    ).stdout
    if "ai-pets.exe" in running:
        subprocess.run(
            ["taskkill", "/IM", "ai-pets.exe", "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.5)

    app = subprocess.Popen([str(EXE)], cwd=str(REPO), env=env)
    problems = []
    try:
        targets = rs.wait_for_debugger(PORT, 30)
        stage = rs.wait_for_page(PORT, [lambda u: u.rstrip("/") == "http://tauri.localhost"])
        companion = rs.wait_for_page(PORT, [lambda u: u.endswith("/companion.html")])

        stage_session = rs.CdpSession(stage["webSocketDebuggerUrl"])
        stage_session.connect()
        stage_session.call("Runtime.enable")
        companion_session = rs.CdpSession(companion["webSocketDebuggerUrl"])
        companion_session.connect()
        companion_session.call("Runtime.enable")

        deadline = time.time() + 30
        while time.time() < deadline:
            if stage_session.evaluate("!!document.querySelector('canvas')"):
                break
            time.sleep(0.5)
        time.sleep(2.0)

        print("install the stand-in recogniser:", stage_session.evaluate(INSTALL_FAKE))

        labels = json.loads(stage_session.evaluate(DOCK_LABELS))
        print("dock buttons:", labels)
        if any("对话" in label for label in labels):
            problems.append("the dock still has a 对话 button")

        # Control: with the switch off, the pet must not be listening.
        before = json.loads(stage_session.evaluate(READ_SESSIONS))
        print("sessions before:", before)
        if before["started"] != 0:
            problems.append("the pet opened a listening session with the switch off")

        print("switch:", companion_session.evaluate(TOGGLE_SWITCH))
        time.sleep(2.0)
        print("switch state:", companion_session.evaluate(READ_SWITCH))
        during = json.loads(stage_session.evaluate(READ_SESSIONS))
        print("sessions while on:", during)
        if during["started"] < 1:
            problems.append("turning the switch on did not start a listening session")

        print("switch:", companion_session.evaluate(TOGGLE_SWITCH))
        time.sleep(2.0)
        after = json.loads(stage_session.evaluate(READ_SESSIONS))
        print("sessions after turning it off:", after)
        if after["stopped"] < 1:
            problems.append("turning the switch off did not end the listening session")

        stage_session.close()
        companion_session.close()
        print("\n== problems:", problems if problems else "none")
        return 1 if problems else 0
    finally:
        rs.kill_tree(app.pid)
        # The host can still have a settings write in flight when it is killed, so the
        # file is put back after it is gone — and the restore is checked, because a
        # settings file that silently lost its comments would be noticed far too late.
        time.sleep(1.5)
        shutil.copy2(backup, SETTINGS)
        backup.unlink(missing_ok=True)
        print("config/settings.yaml restored")


if __name__ == "__main__":
    raise SystemExit(main())
