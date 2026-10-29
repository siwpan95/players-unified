"""LRC 歌词解析：时间标签 → (ms, 文本) 列表，支持二分定位当前行。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import List, Tuple

# [mm:ss.xx] 或 [mm:ss.xxx]
_LINE = re.compile(r"\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def _to_ms(mm: str, ss: str, frac: Optional[str]) -> int:
    frac = (frac or "0").ljust(3, "0")[:3]
    return int(mm) * 60000 + int(ss) * 1000 + int(frac)


class LrcParser:
    @staticmethod
    def parse(text: str) -> List[Tuple[int, str]]:
        lines: List[Tuple[int, str]] = []
        for raw in text.splitlines():
            tags = _LINE.findall(raw)
            if not tags:
                continue
            content = _LINE.sub("", raw).strip()
            for mm, ss, frac in tags:
                lines.append((_to_ms(mm, ss, frac), content))
        lines.sort(key=lambda x: x[0])
        return lines

    @staticmethod
    def parse_file(path) -> List[Tuple[int, str]]:
        return LrcParser.parse(Path(path).read_text(encoding="utf-8", errors="ignore"))

    def __init__(self, path=None, text: Optional[str] = None) -> None:
        if path:
            self.lines = self.parse_file(path)
        elif text is not None:
            self.lines = self.parse(text)
        else:
            self.lines = []

    def line_at(self, position_ms: int) -> int:
        """返回最后一个 time <= position_ms 的行索引；无则 -1。"""
        lo, hi = 0, len(self.lines) - 1
        ans = -1
        while lo <= hi:
            mid = (lo + hi) // 2
            if self.lines[mid][0] <= position_ms:
                ans = mid
                lo = mid + 1
            else:
                hi = mid - 1
        return ans


__all__ = ["LrcParser"]
