#!/usr/bin/env python
"""下载某 Gitee 用户下所有公开仓库的 README 到本地归档（参考资产，不并入主 README）。

用法：
    python tools/fetch_gitee_readmes.py [--owner siwpan] [--out docs/reference-readmes]

仅用标准库（urllib）。每个仓库尝试 default_branch，失败回退 master / main。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://gitee.com/api/v5/users/{owner}/repos?per_page=100&page={page}"
RAW = "https://gitee.com/{full}/raw/{branch}/README.md"
BRANCHES = ["master", "main"]


def _http(url: str, token: str | None = None) -> str | None:
    headers = {"User-Agent": "music-player-readme-fetch"}
    if token:
        headers["Authorization"] = f"token {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        return f"__ERR__{e.code}"
    except Exception as e:  # noqa: BLE001
        return f"__ERR__{e}"


def list_repos(owner: str, token: str | None) -> list[dict]:
    repos: list[dict] = []
    page = 1
    while True:
        data = _http(API.format(owner=owner, page=page), token)
        if not data or data.startswith("__ERR__"):
            break
        chunk = json.loads(data)
        if not chunk:
            break
        repos.extend(chunk)
        if len(chunk) < 100:
            break
        page += 1
    return repos


def fetch_repo_readme(full: str, branch: str) -> str | None:
    return _http(RAW.format(full=full, branch=branch))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", default="siwpan")
    ap.add_argument("--out", default="docs/reference-readmes")
    ap.add_argument("--token", default=None, help="可选 Gitee token，提高速率上限")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    print(f"列举 {args.owner} 的仓库…")
    repos = list_repos(args.owner, args.token)
    print(f"共 {len(repos)} 个仓库")

    ok = 0
    for repo in repos:
        full = repo["full_name"]
        branch = repo.get("default_branch") or "master"
        text = fetch_repo_readme(full, branch)
        if text is None:
            # 回退其它分支
            for b in BRANCHES:
                if b == branch:
                    continue
                text = fetch_repo_readme(full, b)
                if text:
                    break
        if not text or text.startswith("__ERR__"):
            print(f"  ✗ {full}: 无 README ({text})")
            continue
        dest = out / f"{full.replace('/', '__')}.md"
        dest.write_text(text, encoding="utf-8")
        ok += 1
        print(f"  ✓ {full} ({len(text)} 字节)")

    print(f"\n完成：{ok}/{len(repos)} 个 README 已保存到 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
