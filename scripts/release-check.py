"""发布门：把 docs/发布清单.md 变成一条能跑的���令。

清单是人读的流程，这���脚本是同一套流程的可执行版本——同一批门、同一批探针、同一批
发布就绪检查，只是每一步都自己跑、自己判、自己说清楚失败意味着什么。

    python scripts/release-check.py                 # 全跑（实机探针要在时间窗内）
    python scripts/release-check.py --skip-gui      # 只跑离线的门与探针
    python scripts/release-check.py --skip-build    # 不重新构建，用现成的 release 二进制
    python scripts/release-check.py --json          # 机器可读的结果

三件事它替你做掉了：

  1. **Rust 工具链的路线问题**。清单 0.2 让人手动设三个环境变量，少设一个就会卡在链接上。
     这里会自动判断本机走 MSVC 还是 MinGW：能走 MSVC 就走 MSVC，走不了但找得到 MinGW 的
     gcc，就给所有子进程换上 GNU 路线，并把这件事打印出来。
  2. **实机测试的时间窗**。清单 2.0 规定只有 00:00~12:00 与 13:30~19:00 能开窗口。
     不在窗口里，四个 GUI 探针不会跑，脚本以「有检查没执行」退出（退出码 2），
     而不是当成通过——一个没跑过的检查不能算绿灯。
  3. **结果汇总**。每一步都留了它的输出，失败时只打最后几行；结束时给出总表。

退出码：0 全绿；1 有一门没过；2 有检查因为不在时间窗里没执行。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NPM = "npm.cmd" if os.name == "nt" else "npm"
PY = sys.executable

# 时间窗：清单 2.0 的硬约定。窗口之外只做离线的事，不开窗口。
GUI_WINDOWS = ((0, 0, 12, 0), (13, 30, 19, 0))

# 本机的 MinGW 路线（清单 0.2 里那三条环境变量指向的地方）。
MINGW_BIN = Path(r"E:\AI\mingw64\mingw64\bin")
GNU_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"

# 找 cargo 的地方：环境变量优先，然后是几个常见的家目录。
# Rust 工具链被搬过家，所以「PATH 里没有 cargo」是常态而不是意外。
CARGO_HOME_CANDIDATES = [
    os.environ.get("CARGO_HOME"),
    r"E:\AI\cargo",
    str(Path.home() / ".cargo"),
    r"C:\Users\A\.cargo",
]
RUSTUP_HOME_CANDIDATES = [
    os.environ.get("RUSTUP_HOME"),
    r"E:\AI\rustup",
    str(Path.home() / ".rustup"),
    r"C:\Users\A\.rustup",
]


@dataclass
class Step:
    """一步检查。"""

    key: str
    title: str
    #: 跑这一条的命令；None 表示这一步只是读文件做判断。
    command: list[str] | None = None
    #: 这一步属于哪一段：前置 / 代码门 / 探针 / 发布就绪。
    section: str = "代码门"
    #: 属于实机探针的会被时间窗管住。
    gui: bool = False
    #: 失败时这句话就是「为什么失败意味着什么」。
    failure: str = ""
    #: 跑完这一步之后要检查的退出码。
    expect_zero: bool = True
    #: 附加的判定：跑完之后还要满足这个函数返回 True。
    check: object = None


@dataclass
class Result:
    key: str
    title: str
    section: str
    status: str  # pass / fail / skip / deferred
    detail: str = ""
    output: str = ""
    seconds: float = 0.0
    problems: list[str] = field(default_factory=list)


class Runner:
    def __init__(self, args):
        self.args = args
        self.results: list[Result] = []
        self.env = dict(os.environ)
        self.notes: list[str] = []
        self.gnu_route_applied = False
        self.cargo_exe: str | None = None

    # ---------------------------------------------------------------- 工具链

    def prepare_rust_route(self) -> None:
        """把 Rust 的家与链接路线定好，并把结论打印出来。

        清单 0.2 让人手动设五个环境变量，少设一个就会在链接阶段炸掉，而报错信息
        （找不到 `link.exe`）跟真正的原因（工具链搬了家、默认工具链是 msvc）隔得很远。
        这里在跑之前就把两件事定好：工具链的家在哪、走 MSVC 还是 MinGW。两边都不通
        就明说缺什么。
        """
        cargo_home = self._find_home(CARGO_HOME_CANDIDATES, "cargo.exe")
        rustup_home = self._find_home(RUSTUP_HOME_CANDIDATES, "rustup.exe")
        if cargo_home:
            self.env["CARGO_HOME"] = str(cargo_home)
            self.env["PATH"] = f"{cargo_home / 'bin'};{self.env.get('PATH', '')}"
            # Windows 找可执行文件时用的是**调用进程自己**的 PATH，不是子进程的 env，
            # 所以只把 cargo 放进子进程的 PATH 是不够的——必须用绝对路径去调它。
            self.cargo_exe = str(cargo_home / "bin" / "cargo.exe")
            self.notes.append(f"CARGO_HOME = {cargo_home}")
        if rustup_home:
            self.env["RUSTUP_HOME"] = str(rustup_home)
            self.notes.append(f"RUSTUP_HOME = {rustup_home}")

        if not self.cargo_exe:
            found = shutil.which("cargo")
            if found:
                self.cargo_exe = found
        if not self.cargo_exe:
            self.notes.append(
                "找不到 cargo：Rust 三道门与构建会直接失败。"
                "工具链装好，或让 CARGO_HOME 指向它（这次找过："
                + "、".join(str(c) for c in CARGO_HOME_CANDIDATES if c)
                + "）"
            )
            return

        self.notes.append(f"cargo = {self.cargo_exe}")

        # MSVC 路线要 Visual Studio 的 link.exe；没有它就只能走 MinGW。
        msvc_linker = shutil.which("link.exe", path=self.env.get("PATH"))
        gcc = shutil.which("gcc", path=self.env.get("PATH")) or (
            str(MINGW_BIN / "gcc.exe") if (MINGW_BIN / "gcc.exe").is_file() else None
        )
        if msvc_linker:
            self.notes.append("本机有 MSVC 链接器，Rust 走默认路线")
            return
        if not gcc:
            self.notes.append(
                "既没有 MSVC 的 link.exe，也没有 MinGW 的 gcc——Rust 门会失败，"
                "先把链接器装好"
            )
            return
        self.force_gnu_route(gcc)

    def force_gnu_route(self, gcc: str | None = None) -> None:
        """把子进程切到 MinGW 路线。"""
        if not gcc:
            gcc = shutil.which("gcc", path=self.env.get("PATH")) or str(
                MINGW_BIN / "gcc.exe"
            )
        if not Path(gcc).is_file():
            self.notes.append(f"gcc 不在预期位置：{gcc}")
            return
        self.env["RUSTUP_TOOLCHAIN"] = GNU_TOOLCHAIN
        self.env["CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER"] = gcc
        self.env["PATH"] = f"{MINGW_BIN};{self.env.get('PATH', '')}"
        self.gnu_route_applied = True
        self.notes.append(f"Rust 走 MinGW 路线（{gcc}）")

    @staticmethod
    def _find_home(candidates, exe_name: str) -> Path | None:
        """在几个候选位置里找出装着某个可执行文件的那个家。"""
        for candidate in candidates:
            if not candidate:
                continue
            home = Path(candidate)
            if (home / "bin" / exe_name).is_file():
                return home
        return None

    def _exec(self, command: list[str]) -> tuple[int, str]:
        """跑一条命令，把退出码和合并后的输出拿回来。"""
        try:
            proc = subprocess.run(
                command,
                cwd=str(REPO),
                env=self.env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
        except FileNotFoundError as exc:
            return 127, f"命令不存在：{exc}"

    # ---------------------------------------------------------------- 时间窗

    @staticmethod
    def in_gui_window(now: datetime) -> bool:
        minutes = now.hour * 60 + now.minute
        for start_h, start_m, end_h, end_m in GUI_WINDOWS:
            start, end = start_h * 60 + start_m, end_h * 60 + end_m
            if start <= minutes < end:
                return True
        return False

    # ---------------------------------------------------------------- 执行

    def run_step(self, step: Step) -> Result:
        started = time.time()
        if step.gui and not self.args.skip_gui and not self.in_gui_window(datetime.now()):
            return Result(
                key=step.key,
                title=step.title,
                section=step.section,
                status="deferred",
                detail="不在实机测试时间窗（00:00~12:00 / 13:30~19:00），本步没有执行",
                seconds=0.0,
            )
        if step.gui and self.args.skip_gui:
            return Result(
                key=step.key,
                title=step.title,
                section=step.section,
                status="skip",
                detail="--skip-gui：这次不跑实机探针",
            )

        print(f"\n>>> {step.title}")
        print(f"    $ {' '.join(step.command) if step.command else '(读文件判断)'}")
        output = ""
        code = 0
        if step.command:
            code, output = self._exec(step.command)
            # cargo 步骤失败、而且还没换过路线时，换一次路线再试一遍：链接器找错是
            # 最常见也最容易修的一种失败，不该因为它把整道门判成红的。
            if code != 0 and step.command[0].endswith("cargo") and not self.gnu_route_applied:
                print("    （失败可能只是链接路线不对，换 MinGW 路线重试一次）")
                self.force_gnu_route()
                code, output = self._exec(step.command)
        else:
            code, output = (step.check or (lambda: (0, "")))()

        elapsed = time.time() - started
        problems: list[str] = []
        if step.expect_zero and code != 0:
            problems.append(f"退出码 {code}")
        if step.check is not None and step.command is not None:
            verdict = step.check(output)
            if verdict is not True:
                problems.append(str(verdict))

        status = "pass" if not problems else "fail"
        if problems:
            tail = "\n".join(output.strip().splitlines()[-12:])
            print(f"    [FAIL] {'；'.join(problems)}")
            if tail:
                print("    ---- 输出末尾 ----")
                for line in tail.splitlines():
                    print(f"    {line}")
        else:
            print(f"    [PASS] {elapsed:.1f}s")
        return Result(
            key=step.key,
            title=step.title,
            section=step.section,
            status=status,
            detail=step.failure if problems else "",
            output=output,
            seconds=elapsed,
            problems=problems,
        )

    # ---------------------------------------------------------------- 判定

    @staticmethod
    def versions_agree() -> tuple[bool, str]:
        import re

        def read_json(path: Path) -> str:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                return f"读不出来：{exc}"
            return str(data.get("version", "?"))

        pkg = read_json(REPO / "package.json")
        conf = read_json(REPO / "src-tauri" / "tauri.conf.json")
        cargo = "?"
        cargo_file = REPO / "src-tauri" / "Cargo.toml"
        if cargo_file.is_file():
            match = re.search(r'^version\s*=\s*"([^"]+)"', cargo_file.read_text(encoding="utf-8"), re.M)
            if match:
                cargo = match.group(1)
        ok = pkg == conf == cargo and pkg != "?"
        return ok, f"package.json={pkg} · tauri.conf.json={conf} · Cargo.toml={cargo}"

    @staticmethod
    def resources_cover_plugins() -> tuple[bool, str]:
        import json as _json

        conf = REPO / "src-tauri" / "tauri.conf.json"
        try:
            data = _json.loads(conf.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            return False, f"读不出 tauri.conf.json：{exc}"
        resources = (data.get("bundle") or {}).get("resources") or []
        flat = [str(item) for item in resources]
        need_pets = any("../pets/" in item for item in flat)
        need_plugins = any("../plugins/" in item for item in flat)
        ok = need_pets and need_plugins
        return ok, f"bundle.resources={flat}"

    @staticmethod
    def working_tree_clean(output: str) -> bool:
        return output.strip() == ""

    @staticmethod
    def tag_matches_version() -> tuple[bool, str]:
        import re

        pkg = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
        version = str(pkg.get("version", ""))
        try:
            proc = subprocess.run(
                ["git", "tag", "--list", f"v{version}"],
                cwd=str(REPO),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError:
            return False, "找不到 git"
        tagged = f"v{version}" in proc.stdout
        return tagged, f"v{version} {'已存在' if tagged else '还没打'}"


def build_steps(args, cargo_exe: str | None = None) -> list[Step]:
    # cargo 的 `--manifest-path` 跟在**子命令后面**：写成 `cargo --manifest-path … fmt`
    # 会被 cargo 当成「未知参数」直接拒掉（它只认 `cargo fmt --manifest-path …`）。
    def cargo_cmd(subcommand: str, *rest: str) -> list[str]:
        return [
            cargo_exe or "cargo",
            subcommand,
            "--manifest-path",
            str(REPO / "src-tauri" / "Cargo.toml"),
            *rest,
        ]

    steps: list[Step] = []

    # ---- 0. 先决条件
    steps.append(
        Step(
            key="toolchain",
            title="工具链齐不齐（node / rust / python / PyYAML）",
            section="先决条件",
            command=[
                PY,
                "-c",
                "import sys,shutil;"
                "print('node:', shutil.which('node'));"
                "print('cargo:', shutil.which('cargo'));"
                "print('python:', sys.version.split()[0]);"
                "import importlib.util;"
                "print('pyyaml:', bool(importlib.util.find_spec('yaml')))",
            ],
            failure="清单 0.1：探针要 Python，doctor 要 PyYAML（没有会退回内置解析器）",
        )
    )

    # ---- 1. 代码门
    steps.append(Step("scan_dead", "死导出扫描", command=[NPM, "run", "scan:dead"], failure="有冗余导出"))
    steps.append(Step("typecheck", "类型检查", command=[NPM, "run", "typecheck"], failure="类型或未使用变量"))
    steps.append(Step("vitest", "前端单测", command=[NPM, "test"], failure="有单测挂了，不要改测试去迁就实现"))
    if not args.skip_build:
        steps.append(
            Step(
                "build",
                "生产构建（类型 + 死导出 + 导入环 + vite build）",
                command=[NPM, "run", "build"],
                failure="三个门任一失败，或前端构建失败",
            )
        )
    steps.append(
        Step(
            "rust_fmt",
            "Rust 格式",
            command=cargo_cmd("fmt", "--check"),
            failure="有格式偏差；--check 不会改文件，要自己 cargo fmt",
        )
    )
    steps.append(
        Step(
            "rust_clippy",
            "Rust Clippy 零警告",
            command=cargo_cmd(
                "clippy",
                "--all-targets",
                "--features",
                "custom-protocol",
                "--",
                "-D",
                "warnings",
            ),
            failure="有 lint 警告，改掉而不是加 #[allow]",
        )
    )
    steps.append(
        Step(
            "rust_test",
            "Rust 单测",
            command=cargo_cmd("test", "--features", "custom-protocol"),
            failure="有 Rust 单测挂了",
        )
    )
    if not args.skip_build:
        steps.append(
            Step(
                "rust_build",
                "构建 release 二进制（内嵌上面那份 dist/）",
                command=cargo_cmd("build", "--release", "--features", "custom-protocol"),
                failure="没产出 exe；缺 custom-protocol 会让装完指向 dev server 而白屏",
            )
        )
    steps.append(
        Step(
            "verify",
            "取证（PE / 工作树 / 死导出 / 导入环 / Rust 三门 / 逐文件 diff）",
            command=[NPM, "run", "verify"],
            failure="报告里会写明是哪一项没过；没跑构建会报 release binary not found",
        )
    )

    # ---- 2. 实机探针
    steps.append(
        Step(
            "runtime_smoke",
            "运行时冒烟（三窗口 / 总线往返 / 长按）",
            command=[PY, str(REPO / "scripts" / "runtime-smoke.py")],
            section="探针",
            gui=True,
            failure="总线把拒绝伪装成成功、日志钩子没装上、或长按没反应",
        )
    )
    steps.append(
        Step(
            "hud_smoke",
            "状态坞可点 + 星盘能开",
            command=[PY, str(REPO / "scripts" / "hud-smoke.py")],
            section="探针",
            gui=True,
            failure="按钮出界/重叠/点不动，或按了菜单开不出星盘",
        )
    )
    steps.append(
        Step(
            "stage_smoke",
            "画布随窗口长、桌宠不被裁（含负控制）",
            command=[PY, str(REPO / "scripts" / "stage-smoke.py")],
            section="探针",
            gui=True,
            failure="桌宠被裁，或负控制没被抓住（说明这个检查抓不住问题）",
        )
    )
    steps.append(
        Step(
            "mic_smoke",
            "捕捉麦克风开关能开能关",
            command=[PY, str(REPO / "scripts" / "mic-smoke.py")],
            section="探针",
            gui=True,
            failure="开关不生效、关不掉，或对照不成立",
        )
    )
    steps.append(
        Step(
            "doctor",
            "宿主与插件自检（五段体检）",
            command=[PY, str(REPO / "scripts" / "doctor.py")],
            section="探针",
            gui=True,
            failure="退出码 1 = 有失败项；第 2 段要求宿主正在运行",
        )
    )
    steps.append(
        Step(
            "plugin_harness",
            "插件离线夹具（不起桌宠）",
            command=[PY, str(REPO / "scripts" / "plugin-harness.py"), "plugins/demo_external"],
            section="探针",
            failure="清单不合法；报告会指出是哪一条规则",
        )
    )
    steps.append(
        Step(
            "protocol_selftest",
            "总线协议离线自测",
            command=[PY, str(REPO / "test_external_app.py"), "--selftest"],
            section="探针",
            failure="RFC 6455 握手或帧格式坏了",
        )
    )

    # ---- 3. 发布就绪
    steps.append(
        Step(
            "version_agree",
            "版本号三处一致",
            section="发布就绪",
            command=[
                PY,
                "-c",
                "import json,re,sys;"
                "p=json.load(open('package.json',encoding='utf-8'))['version'];"
                "c=json.load(open('src-tauri/tauri.conf.json',encoding='utf-8'))['version'];"
                "m=re.search(r'^version\\s*=\\s*\"([^\"]+)\"',open('src-tauri/Cargo.toml',encoding='utf-8').read(),re.M).group(1);"
                "print(p,c,m);"
                "sys.exit(0 if p==c==m else 1)",
            ],
            failure="漏改一处 → 安装包文件名、程序「关于」页会打架",
        )
    )
    steps.append(
        Step(
            "resources",
            "安装包带上 config / pets / plugins",
            section="发布就绪",
            command=[
                PY,
                "-c",
                "import json,sys;"
                "r=json.load(open('src-tauri/tauri.conf.json',encoding='utf-8'))['bundle']['resources'];"
                "print(r);"
                "sys.exit(0 if any('../pets/' in x for x in r) and any('../plugins/' in x for x in r) else 1)",
            ],
            failure="少了 ../pets/**/* 或 ../plugins/**/*，装完机器上就没有宠物或插件",
        )
    )
    steps.append(
        Step(
            "worktree",
            "工作树干净（没有意外产物）",
            section="发布就绪",
            command=["git", "status", "--short"],
            check=lambda out: Runner.working_tree_clean(out),
            failure="还有没提交的改动或没被忽略的临时文件",
        )
    )
    steps.append(
        Step(
            "tag",
            "版本标签已存在",
            section="发布就绪",
            command=[
                PY,
                "-c",
                "import json,subprocess,sys;"
                "v=json.load(open('package.json',encoding='utf-8'))['version'];"
                "t=subprocess.run(['git','tag','--list','v'+v],capture_output=True,text=True).stdout.strip();"
                "print('v'+v, '已存在' if t else '还没打');"
                "sys.exit(0 if t else 1)",
            ],
            failure="版本号改了但标签还没打（或反过来）",
        )
    )
    return steps


def self_test() -> int:
    """脚本自己的自检：时间窗判定、步骤清单、cargo 调用路径。

    这段不需要仓库、不开窗口，可以放在 CI 里跑。它守的是两件容易悄悄坏掉的事：
    实机测试时间窗的边界（写错一个边界就等于在半夜开窗口），以及 cargo 步骤有没有
    真的用上绝对路径（Windows 找可执行文件时看的是调用进程的 PATH，不是子进程的）。
    """
    failures: list[str] = []

    def in_window(hour: int, minute: int) -> bool:
        return Runner.in_gui_window(datetime(2026, 1, 1, hour, minute))

    for hour, minute, expected in [
        (0, 0, True),
        (11, 59, True),
        (12, 0, False),
        (13, 29, False),
        (13, 30, True),
        (18, 59, True),
        (19, 0, False),
        (23, 59, False),
    ]:
        actual = in_window(hour, minute)
        if actual != expected:
            failures.append(f"时间窗 {hour:02d}:{minute:02d} 判定为 {actual}，应为 {expected}")

    full = build_steps(argparse.Namespace(skip_gui=True, skip_build=False), cargo_exe=r"E:\x\cargo.exe")
    steps = build_steps(argparse.Namespace(skip_gui=True, skip_build=True), cargo_exe=r"E:\x\cargo.exe")
    keys = [step.key for step in full]
    expected_keys = [
        "toolchain",
        "scan_dead",
        "typecheck",
        "vitest",
        "build",
        "rust_fmt",
        "rust_clippy",
        "rust_test",
        "verify",
        "runtime_smoke",
        "hud_smoke",
        "stage_smoke",
        "mic_smoke",
        "doctor",
        "plugin_harness",
        "protocol_selftest",
        "version_agree",
        "resources",
        "worktree",
        "tag",
    ]
    missing = [key for key in expected_keys if key not in keys]
    if missing:
        failures.append(f"步骤清单少了：{missing}")

    # --skip-build 必须同时跳过前端构建与 release 构建：只跳过其中一个，
    # 就会出现 dist/ 变新而 exe 没变，取证会报 STALE BINARY。
    skipped_keys = [step.key for step in steps]
    for key in ("build", "rust_build"):
        if key in skipped_keys:
            failures.append(f"--skip-build 下「{key}」不该出现")
        if key not in keys:
            failures.append(f"完整清单里少了「{key}」")

    for step in steps:
        if step.command and step.command[0].endswith("cargo"):
            # Windows 的路径在别的系统上不算「绝对路径」，所以这里认盘符开头。
            looks_absolute = Path(step.command[0]).is_absolute() or re.match(
                r"^[A-Za-z]:[\\/]", step.command[0]
            )
            if not looks_absolute:
                failures.append(f"步骤「{step.title}」用的 cargo 不是绝对路径")

    gui_steps = [step.key for step in steps if step.gui]
    if sorted(gui_steps) != sorted(["runtime_smoke", "hud_smoke", "stage_smoke", "mic_smoke", "doctor"]):
        failures.append(f"实机探针的标记不对：{gui_steps}")

    offline_steps = [step.key for step in steps if not step.gui and step.section == "探针"]
    if sorted(offline_steps) != sorted(["plugin_harness", "protocol_selftest"]):
        failures.append(f"离线探针的标记不对：{offline_steps}")

    if failures:
        print("自检没过：")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"自检通过：时间窗边界、{len(keys)} 步清单、cargo 绝对路径、实机/离线探针标记都对。")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="发布门：把 docs/发布清单.md 跑一遍")
    parser.add_argument("--skip-gui", action="store_true", help="不跑实机探针（只跑离线的门）")
    parser.add_argument("--skip-build", action="store_true", help="不重新构建 release 二进制")
    parser.add_argument("--self-test", action="store_true", help="只跑脚本自己的自检（不开窗口、不需要仓库）")
    parser.add_argument("--json", dest="as_json", action="store_true", help="输出 JSON 结果")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    runner = Runner(args)
    runner.prepare_rust_route()
    if args.skip_build:
        runner.notes.append(
            "用了 --skip-build：跳过前端构建与 release 构建，"
            "现成的 exe 必须已经比 dist/ 新，否则取证会报 STALE BINARY"
        )

    now = datetime.now()
    print("=" * 72)
    print(f"AI-Pets 发布门 · {now.strftime('%Y-%m-%d %H:%M')}")
    print(f"仓库：{REPO}")
    for note in runner.notes:
        print(f"· {note}")
    if not runner.in_gui_window(now):
        print("· 现在不在实机测试时间窗（00:00~12:00 / 13:30~19:00），实机探针不会执行")
    print("=" * 72)

    for step in build_steps(args, runner.cargo_exe):
        result = runner.run_step(step)
        runner.results.append(result)

    failed = [r for r in runner.results if r.status == "fail"]
    deferred = [r for r in runner.results if r.status == "deferred"]
    skipped = [r for r in runner.results if r.status == "skip"]

    print("\n" + "=" * 72)
    print("汇总")
    print("=" * 72)
    current = ""
    for result in runner.results:
        if result.section != current:
            current = result.section
            print(f"\n[{current}]")
        mark = {"pass": "PASS", "fail": "FAIL", "skip": "SKIP", "deferred": "DEFER"}[result.status]
        print(f"  {mark:5} {result.title}  ({result.seconds:.1f}s)")
        if result.status == "fail" and result.detail:
            print(f"        → {result.detail}")
    print(
        f"\n共 {len(runner.results)} 项：通过 {len(runner.results) - len(failed) - len(deferred) - len(skipped)}"
        f"，失败 {len(failed)}，跳过 {len(skipped)}，未执行 {len(deferred)}"
    )

    if args.as_json:
        print(
            json.dumps(
                {
                    "results": [
                        {
                            "key": r.key,
                            "title": r.title,
                            "section": r.section,
                            "status": r.status,
                            "problems": r.problems,
                            "seconds": round(r.seconds, 1),
                        }
                        for r in runner.results
                    ],
                    "notes": runner.notes,
                },
                ensure_ascii=False,
                indent=2,
            )
        )

    if failed:
        print("\n发布门没过：先修上面标 FAIL 的几项，再谈打标签。")
        return 1
    if deferred:
        print(
            "\n有检查因为不在实机测试时间窗没有执行——这不算通过，"
            "在窗口内重跑一次（或在 CI/别的机器上跑完再发）。"
        )
        return 2
    print("\n发布门全绿。剩下的动作是清单第 3 节：提交、打标签、推上去。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
