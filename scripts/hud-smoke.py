"""Measures the stage HUD in the real release and checks that it can be pressed.

It answers three questions that no unit test can:

  1. Do the dock buttons fit inside the window, and do they overlap each other?
  2. Does the pointer count as being over the chrome when it is on a button? That
     answer is what decides whether the window stays clickable while the pointer
     rests on the dock.
  3. Does pressing "菜单" actually open the astrolabe?

The press is delivered as real input events rather than as a scripted call, so the
whole chain runs: pointer down, pointer up, click. A scripted `element.click()`
skips the part that used to be broken — the browser's own hit test — and reports a
green result for a dock nobody can press.

The frame the chrome sits in is `pointer-events: none`, so `elementFromPoint`
reports "nothing is here" for the whole dock. The rectangles are measured instead,
the same way the page measures them.
"""

import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# The file name has a hyphen, so it is loaded by path rather than by name.
_spec = importlib.util.spec_from_file_location(
    "runtime_smoke", str(Path(__file__).resolve().parent / "runtime-smoke.py")
)
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)

EXE = REPO / "src-tauri" / "target" / "release" / "ai-pets.exe"
PORT = 9222

MEASURE = r"""
(() => {
  const root = document.querySelector('.pet-stage-root');
  const dock = document.querySelector('.tactical-dock');
  const chrome = [...document.querySelectorAll(
    '.tactical-dock, .holo-status-pill, .inline-chat-bar, .holo-speech-visor'
  )];
  const overChrome = (x, y) =>
    chrome.some((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  const buttons = [...document.querySelectorAll('.tactical-dock-btn')].map((b) => {
    const r = b.getBoundingClientRect();
    const label = b.querySelector('.dock-label');
    const hint = b.querySelector('.dock-hint');
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return {
      label: label ? label.textContent.trim() : null,
      hint: hint ? hint.textContent.trim() : null,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      center: [Math.round(cx), Math.round(cy)],
      overChrome: overChrome(cx, cy),
    };
  });
  return JSON.stringify({
    stage: root ? { w: root.clientWidth, h: root.clientHeight } : null,
    dockVisible: !!dock,
    buttons,
  });
})()
"""

AFTER_CLICK = r"""
(() => {
  const layer = document.querySelector('.tactical-astrolabe-layer');
  const nodes = [...document.querySelectorAll('.tactical-wing-node')].map((n) => {
    const r = n.getBoundingClientRect();
    return {
      label: n.querySelector('.wing-label') ? n.querySelector('.wing-label').textContent.trim() : null,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    };
  });
  const hint = document.querySelector('.hub-hint');
  return JSON.stringify({
    astrolabeOpen: !!layer,
    nodes,
    hintVisible: !!hint,
    hintText: hint ? hint.textContent.trim() : null,
  });
})()
"""


def main() -> int:
    if not EXE.exists():
        print(f"the release binary is missing: {EXE}")
        return 1

    env = dict(os.environ)
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={PORT}"
    # WebView2 keeps one browser process per user data folder, and the devtools port
    # is read when that process starts. A host that is already running therefore owns
    # the browser process, and the port this run asks for never appears.
    running = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq ai-pets.exe", "/NH"],
        capture_output=True,
        text=True,
    ).stdout
    if "ai-pets.exe" in running:
        print("closing the host that is already running")
        subprocess.run(
            ["taskkill", "/IM", "ai-pets.exe", "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.5)

    app = subprocess.Popen([str(EXE)], cwd=str(REPO), env=env)
    print(f"started {EXE.name} as pid {app.pid} with devtools on {PORT}")
    try:
        targets = rs.wait_for_debugger(PORT, 30)
        # `companion.html` also contains "tauri.localhost", so the main stage is picked
        # by its exact url: the companion window has no dock to measure.
        page = next(
            t
            for t in targets
            if (t.get("url") or "").rstrip("/") == "http://tauri.localhost"
        )
        session = rs.CdpSession(page["webSocketDebuggerUrl"])
        session.connect()
        session.call("Runtime.enable")

        # The bundle is still mounting when the devtools target shows up.
        deadline = time.time() + 30
        while time.time() < deadline:
            if session.evaluate("!!document.querySelector('.pet-stage-root')"):
                break
            time.sleep(0.5)
        time.sleep(1.5)

        measured = json.loads(session.evaluate(MEASURE))
        stage = measured["stage"] or {"w": 0, "h": 0}
        print(f"\n== stage {stage}  dock visible: {measured['dockVisible']}")
        problems = []
        for b in measured["buttons"]:
            left, top, bw, bh = b["rect"]
            inside = left >= 0 and top >= 0 and left + bw <= stage["w"] and top + bh <= stage["h"]
            print(
                f"  {b['label']:<4} {b['hint']:<6} rect={b['rect']} inside={inside} "
                f"overChrome={b['overChrome']}"
            )
            if not inside:
                problems.append(f"{b['label']} is outside the stage")
            if not b["overChrome"]:
                problems.append(f"{b['label']} is not counted as chrome")
        for i in range(len(measured["buttons"])):
            for j in range(i + 1, len(measured["buttons"])):
                a, c = measured["buttons"][i]["rect"], measured["buttons"][j]["rect"]
                if a[0] < c[0] + c[2] and c[0] < a[0] + a[2] and a[1] < c[1] + c[3] and c[1] < a[1] + a[3]:
                    problems.append(
                        f"{measured['buttons'][i]['label']} overlaps {measured['buttons'][j]['label']}"
                    )

        # A real press on the first button, delivered as input events rather than as a
        # scripted call, so the whole chain runs: pointer down, pointer up, click.
        if measured["buttons"]:
            menu = measured["buttons"][0]
            mx, my = menu["center"]
            for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
                session.call(
                    "Input.dispatchMouseEvent",
                    {
                        "type": kind,
                        "x": mx,
                        "y": my,
                        "button": "left" if kind != "mouseMoved" else "none",
                        "buttons": 1 if kind != "mouseMoved" else 0,
                        "clickCount": 1,
                    },
                )
                time.sleep(0.15)
            time.sleep(1.2)

        after = json.loads(session.evaluate(AFTER_CLICK))
        print(f"\n== astrolabe open: {after['astrolabeOpen']}  nodes: {len(after['nodes'])}")
        for n in after["nodes"]:
            print("  ", n["label"], n["rect"])
        print("  hint:", after["hintVisible"], after["hintText"])
        if not after["astrolabeOpen"]:
            problems.append("pressing 菜单 did not open the astrolabe")
        if not after["hintVisible"]:
            problems.append("the hub hint is not on screen")
        if len(after["nodes"]) < 2:
            problems.append("the astrolabe shows fewer than two nodes")

        session.close()
        print("\n== problems:", problems if problems else "none")
        return 1 if problems else 0
    finally:
        rs.kill_tree(app.pid)


if __name__ == "__main__":
    raise SystemExit(main())
