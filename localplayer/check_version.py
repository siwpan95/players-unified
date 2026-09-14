#!/usr/bin/env python3
"""提交前自检：校验 manifest.json 的 version 与 CHANGELOG.md 最新版本号一致。

用法：
    python check_version.py
退出码：
    0 = 一致；1 = 不一致（应阻止提交）；2 = 解析失败

注意：输出一律用 ASCII，避免 Windows 控制台 GBK 编码报错。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "manifest.json"
CHANGELOG = ROOT / "CHANGELOG.md"


def latest_changelog_version() -> str | None:
    text = CHANGELOG.read_text(encoding="utf-8")
    # 取第一个版本标题（CHANGELOG 顶部即最新）
    m = re.search(r"^##\s*\[\s*(\d+\.\d+\.\d+)\s*\]", text, re.MULTILINE)
    return m.group(1) if m else None


def manifest_version() -> str | None:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return data.get("version")


def main() -> int:
    if not MANIFEST.exists():
        print("[FAIL] 未找到 manifest.json")
        return 2
    if not CHANGELOG.exists():
        print("[FAIL] 未找到 CHANGELOG.md")
        return 2

    mv = manifest_version()
    cv = latest_changelog_version()
    if mv is None:
        print("[FAIL] 无法解析 manifest.json 的 version")
        return 2
    if cv is None:
        print("[FAIL] 无法解析 CHANGELOG.md 的最新版本号（缺少 ## [x.y.z] 标题）")
        return 2

    if mv == cv:
        print(f"[OK] 版本一致：manifest = CHANGELOG = {mv}")
        return 0

    print("[FAIL] 版本不一致：")
    print(f"    manifest.json version = {mv}")
    print(f"    CHANGELOG.md 最新    = {cv}")
    print("    提交前请把两者对齐（通常改 manifest.json 的 version 匹配 CHANGELOG）。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
