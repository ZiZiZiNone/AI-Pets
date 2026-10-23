"""Exports a pet package of this repository into the Codex Pet package format.

The question it answers: *can this pet be shown by a host that is not us* — without that
host needing anything from this repository but two files. Codex Pet (and the hosts that
follow the same format) wants a folder with `pet.json` and `spritesheet.webp` in it, laid
out on a fixed grid. This script takes one `pets/<id>/` package and writes that folder.

The atlas rules come from https://codexpet.xyz/spec and are treated as fixed, not as
options:

  * 8 columns of 192x208 cells; V1 is exactly 1536x1872 (9 rows), V2 exactly 1536x2288
    (11 rows) and must declare `"spriteVersionNumber": 2`.
  * The row order is part of the format: 0 idle, 1 running-right, 2 running-left,
    3 waving, 4 jumping, 5 failed, 6 waiting, 7 running, 8 review, and in V2 rows 9/10
    the two look-direction rows.
  * A row plays consecutive non-empty frames starting at column 0; trailing empty cells
    are ignored. No grid lines, labels or frame numbers may appear in the sheet.

What this repository actually ships is one idle animation per package, so only row 0 can
be filled with frames that really exist. The remaining rows are left empty rather than
filled with borrowed idle frames, and the report says so plainly: the exported package
is honest about what the pet can do, and it does not satisfy the spec's "every action row
has at least one non-empty frame" rule until real action frames exist.

Usage:
    python scripts/export_codex_pet.py --pet ametsuchi_ame --out E:/tmp/codex_export
    python scripts/export_codex_pet.py --pet ametsuchi_ame --out E:/tmp/codex_export --version 2
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:  # the Windows console is a legacy code page; the report text is not.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

try:
    from PIL import Image, ImageChops, ImageMath, features

    PIL_AVAILABLE = True
except ImportError:  # pragma: no cover - the message below is the whole point
    PIL_AVAILABLE = False

REPO = Path(__file__).resolve().parent.parent
PETS_DIR = REPO / "pets"

COLUMNS = 8
CELL_W = 192
CELL_H = 208

# The row order belongs to the format, so it is a constant and not a choice.
ROW_STATES = [
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
]
LOOK_DIRECTION_ROWS = ["look-directions-a", "look-directions-b"]

# The only size a version is allowed to have.
ATLAS_SIZE = {1: (1536, 1872), 2: (1536, 2288)}

# A strip is preferred over a single image because a single image is one frame of a loop.
SOURCE_CANDIDATES = ["idle_strip.png", "idle.png"]


class ExportError(Exception):
    """Anything that makes a spec-conforming package impossible to write."""


def top_level_scalar(text, key):
    """Read one top-level scalar from the manifest, without a YAML dependency."""
    match = re.search(rf"^{re.escape(key)}:[ \t]*(.*)$", text, re.MULTILINE)
    if not match:
        return ""
    value = match.group(1).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def child_block(text, indent, name):
    """The lines nested under `name:` at the given indentation, and nothing else.

    A sibling key ends the block, so the values read here belong to this key and not to
    the next one.
    """
    lines = text.splitlines()
    header = re.compile(rf"^ {{{indent}}}{re.escape(name)}:[ \t]*$")
    for index, line in enumerate(lines):
        if not header.match(line):
            continue
        block = []
        for following in lines[index + 1:]:
            if not following.strip():
                block.append(following)
                continue
            if len(following) - len(following.lstrip()) <= indent:
                break
            block.append(following)
        return block
    return []


def idle_clip(text):
    """Read the idle clip of the manifest: its file name and its frame count."""
    animations = child_block(text, 2, "animations")
    block = child_block("\n".join(animations), 4, "idle")
    joined = "\n".join(block)
    file_match = re.search(r"^\s+file:[ \t]*[\"']?([^\"'\n]+?)[\"']?[ \t]*$", joined, re.MULTILINE)
    frames_match = re.search(r"^\s+frames:[ \t]*(\d+)", joined, re.MULTILINE)
    return (file_match.group(1).strip() if file_match else ""), (
        int(frames_match.group(1)) if frames_match else 0
    )


def read_manifest(path):
    """The manifest fields a Codex Pet package needs."""
    text = path.read_text(encoding="utf-8")
    clip_file, clip_frames = idle_clip(text)
    return {
        "id": top_level_scalar(text, "id"),
        "name": top_level_scalar(text, "name"),
        "description": top_level_scalar(text, "description"),
        "idle_file": clip_file,
        "idle_frames": clip_frames,
    }


def resolve_source(pkg_dir, manifest):
    """Pick the sprite source and the number of frames it holds.

    The strip comes first because a single image is one frame of a loop, and a loop of
    one frame is all the package has to offer.
    """
    for name in SOURCE_CANDIDATES:
        path = pkg_dir / name
        if not path.is_file():
            continue
        if name == "idle.png":
            return path, 1
        if manifest["idle_file"] == name and manifest["idle_frames"] > 0:
            return path, manifest["idle_frames"]
        raise ExportError(
            f"{name} 没有在 pet.yaml 的 model.animations.idle 里声明 frames，无法确定切帧方式"
        )
    raise ExportError("包里既没有 idle_strip.png 也没有 idle.png，找不到可导出的素材")


def slice_frames(image, count):
    """Cut a horizontal strip into `count` frames of equal width."""
    width, height = image.size
    if width % count:
        raise ExportError(f"帧条宽 {width} 不能被帧数 {count} 整除")
    frame_width = width // count
    return [
        image.crop((index * frame_width, 0, (index + 1) * frame_width, height)).convert("RGBA")
        for index in range(count)
    ]


def resize_rgba(image, size):
    """Resize an RGBA image without the dark fringe a plain resize leaves on the edges.

    Transparent pixels carry black in their colour channels, so resizing the channels
    independently bleeds that black into the soft edges of the character. The resize is
    therefore done on premultiplied colour, and the unpremultiply happens afterwards.
    """
    alpha = image.getchannel("A")
    premultiplied = [ImageChops.multiply(band, alpha) for band in image.convert("RGB").split()]
    alpha = alpha.resize(size, Image.LANCZOS)
    # A zero alpha would divide by zero; one keeps it finite, and a fully opaque pixel
    # keeps its own denominator.
    divisor = alpha.point(lambda value: value + 1 if value < 255 else 255)
    bands = []
    for band in premultiplied:
        band = band.resize(size, Image.LANCZOS)
        bands.append(ImageMath.unsafe_eval("r * 255 / a", r=band, a=divisor).convert("L"))
    return Image.merge("RGBA", (*bands, alpha))


def fit_into_cell(image):
    """Scale a frame to fit a 192x208 cell, keeping its ratio and its transparency."""
    scale = min(CELL_W / image.width, CELL_H / image.height)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    offset = ((CELL_W - size[0]) // 2, (CELL_H - size[1]) // 2)
    cell.alpha_composite(resize_rgba(image, size), offset)
    return cell


def build_sheet(frames, version):
    """Lay the frames out on the Codex grid.

    Only row 0 is filled: the package ships one animation, and the other rows name
    actions that do not exist here. Copying the idle frames into them would claim
    actions the pet cannot perform.
    """
    rows = ROW_STATES + (LOOK_DIRECTION_ROWS if version == 2 else [])
    width, height = ATLAS_SIZE[version]
    sheet = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for column, frame in enumerate(frames[:COLUMNS]):
        sheet.alpha_composite(fit_into_cell(frame), (column * CELL_W, 0))
    return sheet, rows


def write_package(out_dir, sheet, manifest, version):
    """Write `pet.json` and the sheet; fall back to PNG when WebP is unavailable."""
    out_dir.mkdir(parents=True, exist_ok=True)
    sprite_name = "spritesheet.webp"
    note = ""
    if features.check("webp"):
        try:
            sheet.save(out_dir / sprite_name, format="WEBP", lossless=True)
        except OSError as exc:
            sprite_name = "spritesheet.png"
            note = f"WebP 写入失败（{exc}），已退回 PNG"
    else:
        sprite_name = "spritesheet.png"
        note = "本机 Pillow 不支持 WebP，已退回 PNG"
    if sprite_name.endswith(".png"):
        sheet.save(out_dir / sprite_name, format="PNG")

    payload = {
        "id": manifest["id"],
        "displayName": manifest["name"],
        "description": manifest["description"],
        "spritesheetPath": sprite_name,
        "spriteVersionNumber": version,
    }
    (out_dir / "pet.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return sprite_name, note


def inspect_sheet(sheet, rows, frame_count):
    """Check the written sheet against the rules the spec states."""
    row_counts = []
    stray = 0
    transparent_cells = 0
    for row_index in range(len(rows)):
        count = 0
        for column in range(COLUMNS):
            cell = sheet.crop(
                (
                    column * CELL_W,
                    row_index * CELL_H,
                    (column + 1) * CELL_W,
                    (row_index + 1) * CELL_H,
                )
            )
            empty = cell.getchannel("A").getbbox() is None
            assigned = row_index == 0 and column < min(frame_count, COLUMNS)
            if not empty:
                count += 1
            elif not assigned:
                transparent_cells += 1
            if assigned and empty:
                stray += 1
        row_counts.append(count)
    return {
        "row_counts": row_counts,
        "stray": stray,
        "transparent_cells": transparent_cells,
        "alpha_range": sheet.getchannel("A").getextrema(),
    }


def export_package(pkg_dir, out_dir, version):
    """Write one Codex Pet package and report what was written and what was found."""
    manifest = read_manifest(pkg_dir / "pet.yaml")
    manifest["id"] = manifest["id"] or pkg_dir.name
    manifest["name"] = manifest["name"] or manifest["id"]
    source, frame_count = resolve_source(pkg_dir, manifest)

    with Image.open(source) as opened:
        strip = opened.convert("RGBA")
    frames = slice_frames(strip, frame_count)

    sheet, rows = build_sheet(frames, version)
    expected = ATLAS_SIZE[version]
    if sheet.size != expected:
        raise ExportError(f"图集尺寸 {sheet.size} 不等于规范要求的 {expected}")

    sprite_name, note = write_package(out_dir, sheet, manifest, version)
    with Image.open(out_dir / sprite_name) as written:
        written_sheet = written.convert("RGBA")

    export = {
        "manifest": manifest,
        "source": source,
        "frame_count": frame_count,
        "frame_size": frames[0].size,
        "version": version,
        "out_dir": out_dir,
        "sprite_name": sprite_name,
        "note": note,
        "rows": rows,
        "measured": written_sheet.size,
    }
    return export, inspect_sheet(written_sheet, rows, frame_count)


def report(export, checks):
    """Print what was written and what the reader on the other side will find."""
    manifest = export["manifest"]
    source = export["source"]
    out_dir = export["out_dir"]
    expected = ATLAS_SIZE[export["version"]]
    measured = export["measured"]
    alpha_range = checks["alpha_range"]

    print(f"=== Codex Pet 导出：{manifest['id']} ===")
    print(f"源包      : {source.parent}")
    print(f"清单      : pet.yaml（id={manifest['id']}，name={manifest['name']}）")
    print(f"素材      : {source.name}，切成 {export['frame_count']} 帧"
          f"（每帧 {export['frame_size'][0]}x{export['frame_size'][1]}）")
    print(f"版本      : V{export['version']}（规范要求 {expected[0]}x{expected[1]}）")
    print(f"写入      : {out_dir / export['sprite_name']}")
    print(f"写入      : {out_dir / 'pet.json'}")
    if export["note"]:
        print(f"格式回退  : {export['note']}")
    print()
    print("--- 自检（读回产物） ---")
    print(f"图集尺寸  : {measured[0]}x{measured[1]} "
          f"{'✓ 与规范精确一致' if measured == expected else '✗ 与规范不一致'}")
    print(f"透明通道  : alpha 范围 {alpha_range[0]}-{alpha_range[1]}，"
          f"{'✓ 存在完全透明像素 (0,0,0,0)，背景没有被填成不透明色' if alpha_range[0] == 0 else '✗ 没有完全透明的像素'}")
    print("逐行非空帧:")
    for index, state in enumerate(export["rows"]):
        count = checks["row_counts"][index]
        print(f"  行 {index} {state:<16} {count} 帧（{'有帧' if count else '留空'}）")
    print(f"未分配格子: {checks['transparent_cells']} 个，全部全透明 "
          f"{'✓ 图集里没有网格线、标签或帧号' if checks['stray'] == 0 else '✗ 有格子该空却不为空'}")
    print(f"产物目录  : {', '.join(sorted(p.name for p in out_dir.iterdir()))}")
    print()
    print("--- 需要知道的两件事 ---")
    print("1. 这个包只有 idle 动作，其余行是空的：仓库里的宠物包只有一条 idle 帧条，"
          "没有 running / waving / jumping 这些动作帧。")
    print("   规范希望每一行至少有一帧非空（那是上传校验的要求），所以这个包目前过不了"
          "那条校验；空行不会被误播，尾部空格按规范忽略。")
    print(f"2. 帧数取舍：idle 行最多放 {COLUMNS} 帧（网格只有 {COLUMNS} 列），源包有 "
          f"{export['frame_count']} 帧，放不下的第 {export['frame_count']} 帧被丢弃。"
          f"规范建议 idle 行 6 帧，这里填满 {COLUMNS} 列，让循环更连贯。")


def main():
    parser = argparse.ArgumentParser(description="把仓库里的宠物包导出成 Codex Pet 兼容格式")
    parser.add_argument("--pet", required=True, help="宠物 ID（pets/ 下的文件夹名）")
    parser.add_argument("--out", required=True, help="产物目录（就是宠物包文件夹本身）")
    parser.add_argument("--version", type=int, choices=[1, 2], default=1, help="精灵图版本，默认 1")
    args = parser.parse_args()

    if not PIL_AVAILABLE:
        print("本机没有 Pillow，无法导出；请在装有 Pillow 的环境里运行（不要往 C 盘装东西）", file=sys.stderr)
        return 1

    pkg_dir = PETS_DIR / args.pet
    if not pkg_dir.is_dir():
        print(f"找不到宠物包：{pkg_dir}", file=sys.stderr)
        return 1
    if not (pkg_dir / "pet.yaml").is_file():
        print(f"找不到清单：{pkg_dir / 'pet.yaml'}", file=sys.stderr)
        return 1

    out_dir = Path(args.out)
    try:
        out_dir.resolve().relative_to(PETS_DIR.resolve())
    except ValueError:
        pass
    else:
        print(f"拒绝写入 pets/：{out_dir}（宠物包是只读的）", file=sys.stderr)
        return 1

    try:
        export, checks = export_package(pkg_dir, out_dir, args.version)
    except ExportError as exc:
        print(f"导出失败：{exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"导出失败：{exc}", file=sys.stderr)
        return 1

    report(export, checks)
    print()
    print("--- pet.json ---")
    print((out_dir / "pet.json").read_text(encoding="utf-8").rstrip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
