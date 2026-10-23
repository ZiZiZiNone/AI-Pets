"""发布产物体积报告：把一次安装要下载的字节数摊开来看。

Tauri 的发布产物由两部分组成：`frontendDist` 指向的前端目录会被**内嵌进 exe**，
`bundle.resources` 声明的资源会被**外置到安装目录**。两者都指向同一批宠物素材时，
同一份画作在安装后会被存两遍，而这一点在单独看 exe 大小时是看不出来的——exe 里
九成以上是内嵌的前端资源，不是原生代码。

本脚本把这几笔账分开算清楚，并指出重复：

    python scripts/measure-release-size.py            # 打印中文报告
    python scripts/measure-release-size.py --json     # 机器可读，便于前后对比

只读脚本：它不构建、不删除、不改动任何文件。
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

try:  # Windows 控制台是遗留代码页，文件名未必是。
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

REPO = Path(__file__).resolve().parent.parent
EXE = REPO / "src-tauri" / "target" / "release" / "ai-pets.exe"
DIST = REPO / "dist"
PETS = REPO / "pets"
BUNDLE = REPO / "src-tauri" / "target" / "release" / "bundle"
MIB = 1048576


def directory_size(path):
    """目录里所有文件的字节数与个数；目录不存在时返回 (0, 0)。"""
    if not path.is_dir():
        return 0, 0
    total = 0
    count = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += item.stat().st_size
            count += 1
    return total, count


def by_extension(path):
    """按扩展名汇总一个目录，返回 [(后缀, 文件数, 字节数), ...]，按字节数倒序。"""
    if not path.is_dir():
        return []
    buckets = {}
    for item in path.rglob("*"):
        if not item.is_file():
            continue
        suffix = item.suffix.lower() or "(无后缀)"
        entry = buckets.setdefault(suffix, [0, 0])
        entry[0] += 1
        entry[1] += item.stat().st_size
    return [(suffix, count, size) for suffix, (count, size) in sorted(
        buckets.items(), key=lambda pair: pair[1][1], reverse=True
    )]


def sub_directory_sizes(root):
    """一级子目录各自的字节数与文件数。"""
    if not root.is_dir():
        return []
    rows = []
    for child in sorted(root.iterdir()):
        if child.is_dir():
            size, count = directory_size(child)
            rows.append((child.name, count, size))
    return rows


def installers():
    """bundle/ 下现成的安装包；没有就返回空列表。"""
    if not BUNDLE.is_dir():
        return []
    found = []
    for item in BUNDLE.rglob("*"):
        if item.is_file() and item.suffix.lower() in {".msi", ".exe", ".msix", ".appx", ".deb", ".rpm", ".appimage"}:
            found.append((item.relative_to(BUNDLE).as_posix(), item.stat().st_size))
    return sorted(found)


def collect():
    """采集全部数字，供打印与 --json 共用。"""
    exe_size = EXE.stat().st_size if EXE.is_file() else 0
    dist_size, dist_files = directory_size(DIST)
    pets_size, pets_files = directory_size(PETS)
    dist_pets_size, _ = directory_size(DIST / "pets")
    return {
        "repo": str(REPO),
        "measured_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "exe": {
            "path": EXE.relative_to(REPO).as_posix(),
            "bytes": exe_size,
            "exists": EXE.is_file(),
        },
        "dist": {
            "bytes": dist_size,
            "files": dist_files,
            "children": [
                {"name": name, "files": count, "bytes": size}
                for name, count, size in sub_directory_sizes(DIST)
            ],
        },
        "pets": {
            "bytes": pets_size,
            "files": pets_files,
            "extensions": [
                {"suffix": suffix, "files": count, "bytes": size}
                for suffix, count, size in by_extension(PETS)
            ],
        },
        "bundle": {
            "path": BUNDLE.relative_to(REPO).as_posix(),
            "installers": [
                {"path": path, "bytes": size} for path, size in installers()
            ],
        },
        # exe 里除了内嵌前端资源，剩下的就是原生代码。
        "native_code_bytes": max(0, exe_size - dist_size),
        # 同一批画作：内嵌在 dist/pets 一份，bundle.resources 再外置一份。
        "art_embedded_bytes": dist_pets_size,
        "art_external_bytes": pets_size,
    }


def human(size):
    return f"{size:,} 字节（{size / MIB:.1f} MiB）"


def report(data):
    print("=== 发布产物体积报告 ===")
    print(f"仓库：{data['repo']}")
    print(f"时间：{data['measured_at']}")
    print()

    exe = data["exe"]
    print("[1] release 可执行文件")
    if exe["exists"]:
        print(f"  {exe['path']}")
        print(f"  {human(exe['bytes'])}")
    else:
        print("  尚未构建（先跑 cargo build --release --features custom-protocol）")
    print()

    dist = data["dist"]
    print("[2] 前端产物 dist/（frontendDist 会把它整份内嵌进 exe）")
    if dist["files"]:
        print(f"  合计 {human(dist['bytes'])}，{dist['files']} 个文件")
        for child in dist["children"]:
            print(f"    {child['name']:<10} {human(child['bytes'])}  {child['files']} 个文件")
    else:
        print("  不存在（先跑 npm run build）")
    print()

    pets = data["pets"]
    print("[3] 素材目录 pets/")
    if pets["files"]:
        print(f"  合计 {human(pets['bytes'])}，{pets['files']} 个文件")
        for row in pets["extensions"]:
            print(f"    {row['suffix']:<10} {human(row['bytes'])}  {row['files']} 个文件")
    print()

    bundle = data["bundle"]
    print("[4] 安装包 bundle/")
    if bundle["installers"]:
        for item in bundle["installers"]:
            print(f"  {item['path']}  {human(item['bytes'])}")
    else:
        print(f"  {bundle['path']} 下没有现成的安装包（还没跑过 tauri build）")
    print()

    native = data["native_code_bytes"]
    embedded_art = data["art_embedded_bytes"]
    external_art = data["art_external_bytes"]
    print("[5] 同一份素材被算了几遍")
    print(f"  内嵌进 exe 的前端资源：{human(dist['bytes'])}")
    print(f"  外置到安装目录的 pets/：{human(external_art)}")
    if exe["exists"]:
        print(f"  exe 中的原生代码：{human(native)}（exe 减去内嵌资源）")
    if embedded_art and external_art:
        print(f"  → 画作存了两遍：内嵌 {human(embedded_art)} + 外置 {human(external_art)}"
              f" = {human(embedded_art + external_art)}")
    print()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="输出 JSON，便于前后对比")
    args = parser.parse_args()

    data = collect()
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        report(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
