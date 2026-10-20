"""Measures the stage window in the real release and checks that the pet is never cropped.

The defect this guards is the one a user sees as "the pet is only half there": the host
grows the window when the pet is zoomed, but the drawing surface used to keep the size it
was authored with, so everything the zoom brought closer was cropped by the canvas. The
window was fine; the picture inside it was not.

The check is done on the running app because only the running app has the window, the
canvas and the zoom at the same time:

  1. The canvas has to be the size of the window, both as an element and as a bitmap.
     A canvas that stays at the authored size is the defect.
  2. The pet has to be drawn with room to spare on every side. Art that touches the
     edge of the canvas is art the canvas is cutting.

The zoom is driven by a real wheel event on the studio overlay, because that is the only
way the app is meant to grow: driving the size directly would prove nothing about the
code path a user walks.

Usage:
    python scripts/stage-smoke.py
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
  const canvas = document.querySelector('canvas');
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100);
  };
  let spriteBox = null;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (data[(y * canvas.width + x) * 4 + 3] > 200) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= 0) {
      spriteBox = {
        css: [
          minX / dpr,
          minY / dpr,
          (maxX - minX + 1) / dpr,
          (maxY - minY + 1) / dpr,
        ].map((v) => Math.round(v * 100) / 100),
      };
    }
  }
  const buttons = [...document.querySelectorAll('.tactical-dock-btn')].map((b) => {
    const r = b.getBoundingClientRect();
    const label = b.querySelector('.dock-label');
    return {
      label: label ? label.textContent.trim() : null,
      center: [r.left + r.width / 2, r.top + r.height / 2],
    };
  });
  return JSON.stringify({
    inner: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio,
    canvasRect: rectOf(canvas),
    canvasAttr: canvas ? [canvas.width, canvas.height] : null,
    canvasClient: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
    spriteBox,
    studioOpen: !!document.querySelector('.blueprint-studio-overlay'),
    buttons,
  });
})()
"""


BREAK_SURFACE = r"""
(() => {
  // Put the drawing surface back the way the defect had it: a canvas that keeps the
  // size it was authored with while the window grows. The check below has to notice.
  const stage = document.querySelector('.pet-canvas-stage');
  if (!stage) return 'no-stage';
  stage.style.width = '360px';
  stage.style.height = '420px';
  return 'fixed';
})()
"""

RESTORE_SURFACE = r"""
(() => {
  const stage = document.querySelector('.pet-canvas-stage');
  if (!stage) return 'no-stage';
  stage.style.width = '';
  stage.style.height = '';
  return 'restored';
})()
"""


def press(session, x, y):
    """A real click, delivered as input events rather than a scripted call."""
    for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
        session.call(
            "Input.dispatchMouseEvent",
            {
                "type": kind,
                "x": x,
                "y": y,
                "button": "left" if kind != "mouseMoved" else "none",
                "buttons": 1 if kind != "mouseMoved" else 0,
                "clickCount": 1,
            },
        )
        time.sleep(0.12)


def wheel_up(session, x, y, times=4):
    """Zoom in the way a user does: a wheel over the studio overlay."""
    for _ in range(times):
        session.call(
            "Input.dispatchMouseEvent",
            {"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": -120},
        )
        time.sleep(0.5)


def main() -> int:
    if not EXE.exists():
        print(f"the release binary is missing: {EXE}")
        return 1

    env = dict(os.environ)
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={PORT}"
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
    problems = []
    try:
        targets = rs.wait_for_debugger(PORT, 30)
        page = next(
            t
            for t in targets
            if (t.get("url") or "").rstrip("/") == "http://tauri.localhost"
        )
        session = rs.CdpSession(page["webSocketDebuggerUrl"])
        session.connect()
        session.call("Runtime.enable")

        deadline = time.time() + 30
        while time.time() < deadline:
            if session.evaluate("!!document.querySelector('canvas')"):
                break
            time.sleep(0.5)
        time.sleep(2.0)

        rest = json.loads(session.evaluate(MEASURE))
        print(f"\n== at rest: window {rest['inner']}  canvas {rest['canvasRect']}")
        problems.extend(surface_problems(rest, "at rest"))

        # Open the studio the way the dock does, then zoom with the wheel.
        calibrate = next(
            (b for b in rest["buttons"] if b["label"] == "校准"), None
        )
        if not calibrate:
            problems.append("the dock has no 校准 button to zoom with")
        else:
            press(session, calibrate["center"][0], calibrate["center"][1])
            time.sleep(1.2)
            opened = json.loads(session.evaluate(MEASURE))
            if not opened["studioOpen"]:
                problems.append("pressing 校准 did not open the studio")
            else:
                wheel_up(session, opened["inner"][0] / 2, opened["inner"][1] / 2)
                time.sleep(1.5)

        zoomed = json.loads(session.evaluate(MEASURE))
        print(f"== zoomed: window {zoomed['inner']}  canvas {zoomed['canvasRect']}")
        if zoomed["inner"][0] <= rest["inner"][0] or zoomed["inner"][1] <= rest["inner"][1]:
            problems.append("the window did not grow when the pet was zoomed in")
        problems.extend(surface_problems(zoomed, "zoomed"))

        # Negative control. The check has to be able to fail, so the defect is put back
        # on purpose and the same check has to notice it. A gate that cannot fail is not
        # a gate, and a green run against a broken surface would mean nothing.
        session.evaluate(BREAK_SURFACE)
        time.sleep(0.8)
        broken = json.loads(session.evaluate(MEASURE))
        print(f"== control: window {broken['inner']}  canvas {broken['canvasRect']}")
        control = surface_problems(broken, "control")
        if not control:
            problems.append(
                "the check did not notice a drawing surface that does not follow the window"
            )
        else:
            print(f"   the check noticed: {control[0]}")
        session.evaluate(RESTORE_SURFACE)

        session.close()
        print("\n== problems:", problems if problems else "none")
        return 1 if problems else 0
    finally:
        rs.kill_tree(app.pid)


def surface_problems(measured, where):
    """Everything wrong with the drawing surface: the canvas must be the window, and
    the pet must fit inside it with room to spare."""
    found = []
    inner_w, inner_h = measured["inner"]
    dpr = measured.get("dpr") or 1
    canvas_rect = measured["canvasRect"]
    if not canvas_rect:
        return [f"there is no canvas {where}"]
    if abs(canvas_rect[2] - inner_w) > 1 or abs(canvas_rect[3] - inner_h) > 1:
        found.append(
            f"the canvas is {canvas_rect[2]}x{canvas_rect[3]} but the window is "
            f"{inner_w}x{inner_h} {where}: the pet would be cropped"
        )
    attr = measured["canvasAttr"]
    if attr and (
        abs(attr[0] - inner_w * dpr) > 1 or abs(attr[1] - inner_h * dpr) > 1
    ):
        found.append(
            f"the canvas bitmap is {attr[0]}x{attr[1]} but the window is "
            f"{inner_w}x{inner_h} {where}: the picture would be stretched"
        )
    box = measured.get("spriteBox")
    if not box:
        return found + [f"the pet was not drawn {where}"]
    left, top, width, height = box["css"]
    right, bottom = left + width, top + height
    print(f"   pet box {box['css']} in canvas {measured['canvasClient']}")
    if left <= 0 or top <= 0 or right >= inner_w or bottom >= inner_h:
        found.append(
            f"the pet touches the edge of the canvas {where} "
            f"(box={box['css']} canvas={inner_w}x{inner_h}): it is being cropped"
        )
    return found


if __name__ == "__main__":
    raise SystemExit(main())
