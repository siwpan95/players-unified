"""推送前安全门禁：令牌本体/形态双层扫描 + 敏感目录 + 大文件。

读 HEAD 的 blob（git cat-file -p HEAD:<path>），而非工作区文件。
用法：python tools/push_gate.py   （退出码 0=通过，1=不通过）
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

SENSITIVE_DIRS = ("cache/", "_ref/", "dist/", "build/", "__pycache__/",
                  "node_modules/", ".pytest_cache/")
MAX_BLOB = 5 * 1024 * 1024

PATTERNS = [
    (r'(?i)\b(access_token|api_key|apikey|password|passwd|secret|token)\b\s*[=:]\s*["\']?[0-9a-zA-Z_\-]{16,}', '凭据键值'),
    (r'(?i)https://[^/\s]+:[0-9a-fA-F]{32,}@', 'URL 内嵌令牌'),
    (r'(?i)\bsk-[0-9a-zA-Z]{20,}', 'OpenAI 风格密钥'),
]


def read_token() -> str | None:
    cred = os.path.expanduser("~/.git-credentials")
    if not os.path.exists(cred):
        return None
    for line in open(cred, encoding="utf-8", errors="replace"):
        if "gitee.com" in line:
            m = re.search(r":([0-9a-zA-Z]{32,64})@", line)
            if m:
                return m.group(1)
    return None


def main() -> int:
    token = read_token()
    files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split()
    issues: list[str] = []

    for f in files:
        for d in SENSITIVE_DIRS:
            if f == d.rstrip("/") or f.startswith(d) or ("/" + d) in ("/" + f):
                issues.append(f"敏感目录文件: {f}")
                break

        blob_sha = subprocess.run(["git", "rev-parse", f"HEAD:{f}"],
                                  capture_output=True, text=True).stdout.strip()
        try:
            size = int(subprocess.run(["git", "cat-file", "-s", blob_sha],
                                      capture_output=True, text=True).stdout.strip())
        except ValueError:
            size = 0
        if size > MAX_BLOB:
            issues.append(f"大文件 {f} ({size} 字节)")

        content = subprocess.run(["git", "cat-file", "-p", f"HEAD:{f}"],
                                 capture_output=True).stdout
        if token and token.encode() in content:
            issues.append(f"令牌本体泄漏: {f}")
        text = content.decode("utf-8", "ignore")
        for pat, name in PATTERNS:
            if re.search(pat, text):
                issues.append(f"{name}: {f}")

    if issues:
        print("FAIL")
        for i in issues:
            print("  -", i)
        return 1
    print(f"PASS: {len(files)} 个文件无令牌 / 敏感目录 / 大文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
