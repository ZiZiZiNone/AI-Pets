#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""插件离线测试夹具：不用启动桌宠，也能验证一个插件清单。

它回答外部开发者最关心的三个问题：

  1. 我的清单合法吗？（id 与目录名一致吗、版本号对吗、申请的权限在不在白名单里）
  2. 这个插件会向宿主申请什么、当前批准表下真正生效的是什么？
  3. 它调某个总线方法时，宿主会放行还是拒绝？

第 3 条是离线模拟的：按权限表判断，不连总线，也不改宿主状态。真正的放行与否由宿主在
运行时裁定，这里提前把结论摆出来，免得插件作者等桌宠起来才发现权限没批。

清单规则与自检脚本共用一份（scripts/doctor.py），所以「自检说合法、夹具说不合法」不可能发生。

用法：
    python scripts/plugin-harness.py plugins/demo_external
    python scripts/plugin-harness.py demo_external
    python scripts/plugin-harness.py plugins/demo_external --approvals /path/to/approvals.json
"""

import argparse
import importlib.util
import sys
from pathlib import Path

try:  # the Windows console is a legacy code page; page text is not.
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

REPO = Path(__file__).resolve().parent.parent
PLUGINS_DIR = REPO / "plugins"

# The file name has a hyphen, so it is loaded by path rather than by name.
_spec = importlib.util.spec_from_file_location(
    "doctor", str(Path(__file__).resolve().parent / "doctor.py")
)
doctor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(doctor)


def resolve_plugin_dir(argument):
    """把命令行给的参数变成插件目录。"""
    candidate = Path(argument)
    if candidate.is_dir():
        return candidate
    inside = PLUGINS_DIR / argument
    if inside.is_dir():
        return inside
    return None


def describe_permission(manifest, permission):
    """权限 → 申请理由（写在清单里那行注释上）。"""
    return manifest.reasons.get(permission, "")


def print_bus_decisions(manifest, effective):
    """离线模拟一次总线调用：每个方法会不会被宿主放行。"""
    print()
    print("总线方法判定（离线模拟，没有连总线）：")
    for method, permission, description in doctor.BUS_METHODS:
        if permission in effective:
            verdict = "允许"
            why = "已声明且已批准"
        elif permission in manifest.declared_permissions:
            verdict = "拒绝"
            why = "已声明，但用户还没批准"
        else:
            verdict = "拒绝"
            why = f"没有声明 {permission}"
        print(f"  {method:<17} 需要 {permission:<14} {verdict}（{why}） —— {description}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="插件离线测试夹具")
    parser.add_argument("plugin", help="插件目录（plugins/demo_external）或插件 id")
    parser.add_argument(
        "--approvals",
        help="用别的 JSON 文件当批准表（默认读 config/settings.yaml 的 host.plugin_approvals）",
    )
    args = parser.parse_args(argv)

    plugin_dir = resolve_plugin_dir(args.plugin)
    if plugin_dir is None:
        print(f"找不到插件目录：{args.plugin}")
        print(f"用法：python scripts/plugin-harness.py plugins/<插件 id>")
        print(f"仓库里的插件目录：{PLUGINS_DIR}")
        return 1

    print(f"插件夹具 · {plugin_dir.name}")
    print(f"清单：{plugin_dir / 'plugin.yaml'}")
    print(f"YAML 解析：{doctor._yaml_label()}")

    manifest = doctor.read_manifest(plugin_dir)
    if manifest.errors:
        print()
        print("清单不合法：")
        for error in manifest.errors:
            print(f"  - {error}")
            print(f"    修复：{doctor.manifest_fix(manifest, error)}")
        print()
        print("结论：清单非法（退出码 1）")
        return 1

    print(f"id：{manifest.plugin_id}    版本：{manifest.version}    名称：{manifest.name}")
    if manifest.description:
        print(f"说明：{manifest.description}")

    approvals = doctor.load_approvals(doctor.read_settings()[0], args.approvals)
    for error in approvals.errors:
        print(f"批准表有问题：{error}")

    declared = manifest.declared_permissions
    approved = approvals.host.get(manifest.plugin_id, [])
    effective = doctor.effective_permissions(declared, approved)

    print()
    print("插件会向宿主申请什么（声明的权限）：")
    if declared:
        for permission in declared:
            reason = describe_permission(manifest, permission)
            print(f"  {permission:<14} {reason}")
    else:
        print("  （没有申请任何权限）")

    print()
    print(f"用户批准了什么（{approvals.host_source}）：")
    if approved:
        for permission in approved:
            mark = "  " if permission in declared else " !"
            print(f"{mark} {permission}")
    else:
        print("  （一条都没批准）")

    mirror = approvals.mirror.get(manifest.plugin_id)
    if mirror is not None and set(mirror) != set(approved):
        print(
            f"  ! 另一处记录（{approvals.mirror_source}）说的是："
            f"{'、'.join(mirror) or '（无）'} —— 宿主不读那份文件，以上面那份为准",
        )

    print()
    print("实际生效什么（声明 ∩ 批准）：")
    if effective:
        for permission in effective:
            print(f"  {permission}")
    else:
        print("  （一条都不生效：这个插件现在对宿主没有任何权限）")

    unapproved = [item for item in declared if item not in approved]
    for permission in unapproved:
        print(f"  ! 未批准的声明项：{permission} —— 宿主不会放行")
    stray = [item for item in approved if item not in declared]
    for permission in stray:
        print(f"  ! 批准了但没声明：{permission} —— 不会生效")

    print_bus_decisions(manifest, effective)

    print()
    if manifest.warnings:
        print("提醒：")
        for warning in manifest.warnings:
            print(f"  - {warning}")
        print()

    print("结论：清单合法（退出码 0）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
