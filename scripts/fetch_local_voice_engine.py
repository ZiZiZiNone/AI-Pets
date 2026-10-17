#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地语音引擎获取脚本（TTS + STT，完全离线、免费）。

它做四件事，全部只需 Python 标准库：

1. 从 k2-fsa/sherpa-onnx 官方 Release 下载 Windows x64 命令行引擎包，只抽出
   `sherpa-onnx-offline-tts.exe`（合成）与 `sherpa-onnx-offline.exe`（识别）两个可执行文件。
2. 下载中文 TTS 模型与中文 STT 模型并解包。
3. 跑一次真实闭环自检：合成一段语音，再把它识别回来，确认识别结果包含预期关键词。
4. 打印可直接粘进 `config/settings.yaml` 的片段（已填好本机绝对路径）。

用法::

    python scripts/fetch_local_voice_engine.py --dest E:/AI/sherpa-onnx

安装完成后，把打印出来的片段贴进 `config/settings.yaml` 的 `audio.tts.local` 与
`audio.stt.local`，并把 `audio.tts.provider` 设为 `local_engine`、`audio.stt.provider`
设为 `local_engine` 即可，**不需要改任何源码**。

磁盘占用：下载缓存约 341 MB（校验通过后默认删除，可用 --keep-downloads 保留），
最终留在磁盘上的是 2 个 exe（约 38 MB）加 2 个模型目录（约 100 MB）。

许可提醒：脚本只负责下载，**不代替你确认许可**，也不校验许可。三个下载物里带的信息并不
一样：TTS 模型的 MODEL_CARD 写明训练数据集是 CC0（没说模型文件本身）；STT 模型的
README 只有一行上游 ModelScope 链接，没有许可声明；引擎目录里没有任何 LICENSE 文件。
逐项记录与「对外分发前要人工确认什么」见 docs/使用说明书.md 的 7.3 节。
"""

import argparse
import hashlib
import os
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

RELEASE_BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

# 三个下载物。sha256 与字节数都是本机实跑下载并通过闭环自检的这份包的实际值，
# 校验不通过说明上游重新上传过，此时先人工核对再用 --skip-hash-check 放行。
ENGINE = {
    "key": "engine",
    "tag": "v1.13.8",
    "name": "sherpa-onnx-v1.13.8-win-x64-static-MT-Release.tar.bz2",
    "sha256": "849ea51f860cefbe0ae0074ed01190cd24b91ae3da80c2637261a9e7dabe39c9",
    "size": 249216829,
    "blurb": "命令行引擎包（静态链接，解包后不需要任何 dll）",
}

TTS_MODEL_DIR = "vits-piper-zh_CN-chaowen-medium-int8"
TTS_MODEL = {
    "key": "tts_model",
    "tag": "tts-models",
    "name": TTS_MODEL_DIR + ".tar.bz2",
    "sha256": "f5f7c8628427fbb259ea4b7ec1a9a822a0c04e3f267071f0abfa0610371d9e0c",
    "size": 14011298,
    "blurb": "中文语音合成模型（超文，单说话人）",
}

STT_MODEL_DIR = "sherpa-onnx-paraformer-zh-small-2024-03-09"
STT_MODEL = {
    "key": "stt_model",
    "tag": "asr-models",
    "name": STT_MODEL_DIR + ".tar.bz2",
    "sha256": "da92b3db5218c5be53aad53e57d1b6e63e7fc98a0e054fbdd6dbe18e9c6b1450",
    "size": 77920048,
    "blurb": "中文语音识别模型（Paraformer small，int8）",
}

# 只从引擎包的大 bin/ 目录里抽这两个，其余 19 个 exe 用不到，不落盘。
WANTED_EXES = ("sherpa-onnx-offline-tts.exe", "sherpa-onnx-offline.exe")

SMOKE_TEXT = "你好，我是你的桌面宠物，很高兴见到你。"
SMOKE_KEYWORD = "桌面宠物"

TTS_EXE_NAME = WANTED_EXES[0]
STT_EXE_NAME = WANTED_EXES[1]


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.1f %s" % (n, unit)
        n /= 1024.0


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(asset, downloads_dir, skip_hash_check):
    """下载到 downloads_dir，支持断点续传。返回落盘路径。"""
    target = os.path.join(downloads_dir, asset["name"])
    part = target + ".part"

    if os.path.exists(target) and os.path.getsize(target) == asset["size"]:
        log("[skip] %s 已存在（%s）" % (asset["name"], human(asset["size"])))
        return target

    url = "%s/%s/%s" % (RELEASE_BASE, asset["tag"], asset["name"])
    already = os.path.getsize(part) if os.path.exists(part) else 0
    if already > asset["size"]:
        # 上次写坏了，重来。
        os.remove(part)
        already = 0

    req = urllib.request.Request(url, headers={"User-Agent": "ai-pets-fetch-local-voice-engine"})
    if already:
        req.add_header("Range", "bytes=%d-" % already)
        log("[get ] %s 断点续传，从 %s 继续" % (asset["name"], human(already)))
    else:
        log("[get ] %s（%s，%s）" % (asset["name"], asset["blurb"], human(asset["size"])))

    started = time.time()
    with urllib.request.urlopen(req) as resp:
        if already and resp.status != 206:
            # 服务端不支持分段，只能从头来。
            log("[warn] 服务端未返回 206，改为重新下载")
            already = 0
            mode = "wb"
        else:
            mode = "ab" if already else "wb"
        done = already
        last_mark = -1
        tty = sys.stdout.isatty()
        with open(part, mode) as fh:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                fh.write(chunk)
                done += len(chunk)
                if not tty:
                    # 重定向到文件或 CI 时，\r 不会覆盖而会刷出一屏，不如不报。
                    continue
                mark = int(done * 100 / asset["size"]) // 10
                if mark > last_mark:
                    last_mark = mark
                    sys.stdout.write(
                        "\r        %3d%%  %s / %s" % (mark * 10, human(done), human(asset["size"]))
                    )
                    sys.stdout.flush()
    if tty:
        sys.stdout.write("\r        100%%  %s\n" % human(asset["size"]))
        sys.stdout.flush()

    got = os.path.getsize(part)
    if got != asset["size"]:
        raise SystemExit(
            "%s 长度不符：期望 %d 字节，实际 %d 字节。重跑本脚本会续传。" % (asset["name"], asset["size"], got)
        )

    log("[hash] 校验 %s ..." % asset["name"])
    actual = sha256_of(part)
    if actual != asset["sha256"]:
        if skip_hash_check:
            log("[warn] sha256 不符但已用 --skip-hash-check 放行：%s" % actual)
        else:
            raise SystemExit(
                "%s 的 sha256 与脚本内置值不符。\n  期望 %s\n  实际 %s\n"
                "上游可能重新上传过该文件。人工核对后可用 --skip-hash-check 放行。"
                % (asset["name"], asset["sha256"], actual)
            )
    else:
        log("[hash] sha256 一致")

    if os.path.exists(target):
        os.remove(target)
    os.rename(part, target)
    log("[ok  ] %s 下载完成，用时 %.1f 秒" % (asset["name"], time.time() - started))
    return target


def extract_engine(pkg, bin_dir):
    """从引擎包里只取两个 exe，平铺到 bin_dir。"""
    log("[unpack] 从引擎包里抽取命令行程序")
    wanted = set(WANTED_EXES)
    found = {}
    with tarfile.open(pkg, "r:bz2") as tf:
        for member in tf:
            if not member.isfile():
                continue
            base = os.path.basename(member.name)
            if base in wanted and ("/bin/" in member.name or "\\bin\\" in member.name):
                src = tf.extractfile(member)
                if src is None:
                    continue
                dest = os.path.join(bin_dir, base)
                with open(dest, "wb") as out:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                found[base] = os.path.getsize(dest)
    missing = [name for name in WANTED_EXES if name not in found]
    if missing:
        raise SystemExit("引擎包里没找到：%s。上游结构可能变了。" % "、".join(missing))
    for name in WANTED_EXES:
        log("[ok  ] bin/%s  %s" % (name, human(found[name])))


def extract_model(pkg, models_dir):
    """解包模型：去掉压缩包的第一层目录名，落到 models_dir/<该名字>/。"""
    with tarfile.open(pkg, "r:bz2") as tf:
        names = tf.getnames()
        if not names:
            raise SystemExit("%s 是空包" % pkg)
        top = names[0].split("/")[0].split("\\")[0]
        dest = os.path.join(models_dir, top)
        log("[unpack] %s -> models/%s" % (os.path.basename(pkg), top))
        pairs = []
        for member in tf.getmembers():
            if not member.isfile():
                continue
            rel = member.name.split("/", 1)[-1].split("\\", 1)[-1]
            pairs.append((member, rel))
        total = 0
        for member, rel in pairs:
            out_path = os.path.join(dest, *rel.split("/"))
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            src = tf.extractfile(member)
            if src is None:
                continue
            with open(out_path, "wb") as out:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            total += member.size
        log("[ok  ] models/%s  %d 个文件 %s" % (top, len(pairs), human(total)))
        return dest


def run(exe, argv, timeout):
    """不带 shell 直接起进程，返回 (退出码, stdout, stderr)。"""
    proc = subprocess.Popen(
        [exe] + argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
    )
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        return None, out, err
    return proc.returncode, out, err


def decode(raw):
    return raw.decode("utf-8", "replace") if raw else ""


def wav_info(path):
    """只读 WAV 头：返回 (时长秒, 采样率, 声道数, 位深) 或 None。"""
    import struct

    with open(path, "rb") as fh:
        head = fh.read(12)
        if len(head) < 12 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
            return None
        fmt = None
        while True:
            chunk = fh.read(8)
            if len(chunk) < 8:
                return None
            cid, size = chunk[0:4], struct.unpack("<I", chunk[4:8])[0]
            if cid == b"fmt ":
                body = fh.read(size)
                if len(body) < 16:
                    return None
                # wFormatTag(2) nChannels(2) nSamplesPerSec(4) nAvgBytesPerSec(4)
                # nBlockAlign(2) wBitsPerSample(2)
                fmt = struct.unpack("<HHIIHH", body[0:16])
            elif cid == b"data":
                if fmt is None:
                    return None
                channels, rate, bits = fmt[1], fmt[2], fmt[5]
                # 用块对齐算帧数；它缺失时再退回「声道数 × 每样本字节数」。
                block = fmt[4] or max(1, channels * max(1, bits // 8))
                frames = size / block
                return frames / float(rate), rate, channels, bits
            else:
                fh.seek(size + (size % 2), os.SEEK_CUR)


def smoke_test(bin_dir, tts_dir, stt_dir, report_path):
    """合成一段语音，再识别回来，确认结果是这段语音。"""
    tts_exe = os.path.join(bin_dir, TTS_EXE_NAME)
    stt_exe = os.path.join(bin_dir, STT_EXE_NAME)
    wav = os.path.join(os.path.dirname(bin_dir), "smoke-tts.wav")
    lines = []

    onnx = [f for f in os.listdir(tts_dir) if f.endswith(".onnx")]
    if len(onnx) != 1:
        raise SystemExit("TTS 模型目录里的 .onnx 不是恰好一个：%r" % onnx)

    argv = [
        "--vits-model=" + os.path.join(tts_dir, onnx[0]),
        "--vits-lexicon=" + os.path.join(tts_dir, "lexicon.txt"),
        "--vits-tokens=" + os.path.join(tts_dir, "tokens.txt"),
        "--tts-rule-fsts="
        + ",".join(
            os.path.join(tts_dir, name) for name in ("phone.fst", "date.fst", "number.fst")
        ),
        "--num-threads=2",
        "--output-filename=" + wav,
        SMOKE_TEXT,
    ]
    log("[smoke] 合成「%s」" % SMOKE_TEXT)
    started = time.time()
    code, out, err = run(tts_exe, argv, 180)
    if code is None:
        raise SystemExit("TTS 自检超时（180 秒），引擎可能不是命令行版本。")
    if code != 0:
        lines.append("TTS exit=%s" % code)
        lines.append(decode(out))
        lines.append(decode(err))
        write_report(report_path, lines)
        raise SystemExit("TTS 自检失败，退出码 %s。完整输出见 %s" % (code, report_path))
    if not os.path.exists(wav):
        raise SystemExit("TTS 退出码为 0 但没有产出 %s" % wav)

    size = os.path.getsize(wav)
    info = wav_info(wav)
    if not info:
        raise SystemExit("%s 不是可解析的 WAV" % wav)
    duration, rate, channels, bits = info
    log(
        "[ok  ] 合成完成：%s，%.2f 秒，%d Hz / %d 声道 / %d 位，用时 %.1f 秒"
        % (human(size), duration, rate, channels, bits, time.time() - started)
    )

    argv = [
        "--paraformer=" + os.path.join(stt_dir, "model.int8.onnx"),
        "--tokens=" + os.path.join(stt_dir, "tokens.txt"),
        "--num-threads=2",
        wav,
    ]
    log("[smoke] 把刚合成的音频识别回来")
    code, out, err = run(stt_exe, argv, 180)
    text = decode(out)
    lines.append("text_out=%s" % text)
    lines.append("stderr=%s" % decode(err))
    lines.append("exit=%s" % code)
    write_report(report_path, lines)
    if code is None:
        raise SystemExit("STT 自检超时（180 秒）。")
    if code != 0:
        raise SystemExit("STT 自检失败，退出码 %s。完整输出见 %s" % (code, report_path))

    import json

    transcript = ""
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get("text"):
            transcript = payload["text"]
    if not transcript:
        raise SystemExit("STT 没有输出可解析的 text 字段。完整输出见 %s" % report_path)
    if SMOKE_KEYWORD not in transcript:
        raise SystemExit(
            "识别结果里没有出现「%s」，说明链路取到的可能不是同一段音频。\n识别结果：%s"
            % (SMOKE_KEYWORD, transcript)
        )
    log("[ok  ] 识别结果：%s" % transcript)
    log("[ok  ] 闭环自检通过（识别结果含「%s」）" % SMOKE_KEYWORD)
    return transcript


def write_report(path, lines):
    try:
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines) + "\n")
    except OSError:
        pass


def quote(path):
    """YAML 单引号标量：不做任何转义，所以反斜杠路径可以原样写。"""
    return "'%s'" % path.replace("'", "''")


def snippet(bin_dir, tts_dir, stt_dir):
    tts_exe = os.path.join(bin_dir, TTS_EXE_NAME)
    stt_exe = os.path.join(bin_dir, STT_EXE_NAME)
    return """\
  # ---- 把下面两段贴进 config/settings.yaml 的 audio: 下面 ----
  tts:
    provider: local_engine
    local:
      exe: {tts_exe}
      model_dir: {tts_dir}
      args:
        - "--vits-model={{model_dir}}/*.onnx"
        - "--vits-lexicon={{model_dir}}/lexicon.txt"
        - "--vits-tokens={{model_dir}}/tokens.txt"
        - "--tts-rule-fsts={{model_dir}}/phone.fst,{{model_dir}}/date.fst,{{model_dir}}/number.fst"
        - "--num-threads={{num_threads}}"
        - "--speed={{speed}}"
        - "--output-filename={{output}}"
        - "{{text}}"
      extra_args: []
      output_extension: "wav"
      timeout_ms: 60000
      speed: 1.0
      num_threads: 2

  stt:
    provider: local_engine
    auto_send: false
    local:
      exe: {stt_exe}
      model_dir: {stt_dir}
      args:
        - "--paraformer={{model_dir}}/*.onnx"
        - "--tokens={{model_dir}}/tokens.txt"
        - "--num-threads={{num_threads}}"
        - "{{input}}"
      extra_args: []
      output_extension: "wav"
      timeout_ms: 60000
      num_threads: 2
""".format(
        tts_exe=quote(os.path.abspath(tts_exe)),
        tts_dir=quote(os.path.abspath(tts_dir)),
        stt_exe=quote(os.path.abspath(stt_exe)),
        stt_dir=quote(os.path.abspath(stt_dir)),
    )


def main():
    parser = argparse.ArgumentParser(
        description="下载并自检 sherpa-onnx 本地语音引擎（TTS + STT）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="例：python scripts/fetch_local_voice_engine.py --dest E:/AI/sherpa-onnx",
    )
    parser.add_argument(
        "--dest",
        required=True,
        help="安装目录（必须显式指定，避免误写进系统盘）。不存在会自动创建。",
    )
    parser.add_argument(
        "--component",
        choices=("all", "tts", "stt"),
        default="all",
        help="只装其中一半时可以省下一次下载（默认 all，含闭环自检）",
    )
    parser.add_argument("--skip-engine", action="store_true", help="跳过引擎包（已手动放好 exe 时用）")
    parser.add_argument("--skip-hash-check", action="store_true", help="sha256 不符时仍继续")
    parser.add_argument("--keep-downloads", action="store_true", help="保留下载缓存（默认校验后删除，省 341 MB）")
    parser.add_argument("--skip-smoke", action="store_true", help="跳过闭环自检")
    parser.add_argument("--print-snippet-only", action="store_true", help="只打印配置片段，不下载")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        # 控制台代码页在中文 Windows 上是 GBK，直接输出中文会 UnicodeEncodeError 中断。
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    dest = os.path.abspath(args.dest)
    bin_dir = os.path.join(dest, "bin")
    models_dir = os.path.join(dest, "models")
    downloads_dir = os.path.join(dest, "downloads")
    tts_dir = os.path.join(models_dir, TTS_MODEL_DIR)
    stt_dir = os.path.join(models_dir, STT_MODEL_DIR)

    if args.print_snippet_only:
        log(snippet(bin_dir, tts_dir, stt_dir))
        return 0

    for path in (dest, bin_dir, models_dir, downloads_dir):
        os.makedirs(path, exist_ok=True)
    log("[dest] %s" % dest)

    need_engine = not args.skip_engine and not all(
        os.path.exists(os.path.join(bin_dir, name)) for name in WANTED_EXES
    )
    need_tts = args.component in ("all", "tts") and not os.path.exists(
        os.path.join(tts_dir, "tokens.txt")
    )
    need_stt = args.component in ("all", "stt") and not os.path.exists(
        os.path.join(stt_dir, "tokens.txt")
    )

    keep = []
    try:
        if need_engine:
            keep.append(download(ENGINE, downloads_dir, args.skip_hash_check))
            extract_engine(keep[-1], bin_dir)
        else:
            log("[skip] 引擎命令行程序已在 bin/ 就位")

        if need_tts:
            keep.append(download(TTS_MODEL, downloads_dir, args.skip_hash_check))
            tts_dir = extract_model(keep[-1], models_dir)
        else:
            log("[skip] TTS 模型已就位：%s" % tts_dir)

        if need_stt:
            keep.append(download(STT_MODEL, downloads_dir, args.skip_hash_check))
            stt_dir = extract_model(keep[-1], models_dir)
        else:
            log("[skip] STT 模型已就位：%s" % stt_dir)

        if not args.skip_smoke and not need_tts and not need_stt:
            report = os.path.join(dest, "smoke-report.txt")
            smoke_test(bin_dir, tts_dir, stt_dir, report)
        elif not args.skip_smoke:
            log("[skip] 只装了部分组件，跳过闭环自检")
    finally:
        if not args.keep_downloads:
            freed = 0
            for path in keep:
                if os.path.exists(path):
                    freed += os.path.getsize(path)
                    os.remove(path)
            if freed:
                log("[clean] 已删除下载缓存 %s（用 --keep-downloads 可保留）" % human(freed))

    log("")
    log("=== 安装完成，把下面这段贴进 config/settings.yaml ===")
    log("")
    log(snippet(bin_dir, tts_dir, stt_dir))
    log("贴好后保存即可热重载，不需要重启宿主，也不需要重新编译。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.URLError as exc:
        raise SystemExit("网络错误：%s。重跑本脚本会断点续传。" % exc)
    except KeyboardInterrupt:
        raise SystemExit("已中断。重跑本脚本会断点续传。")
