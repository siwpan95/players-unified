"""元数据读取（mutagen）：标签 + 时长 + 封面。带内存缓存。"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional

import mutagen

from .cover import extract_cover


class MetadataCache:
    def __init__(self, cache_dir: str) -> None:
        self.cache_dir = Path(cache_dir)
        self._cover_dir = self.cache_dir / "cover"
        self._cover_dir.mkdir(parents=True, exist_ok=True)
        self._mem: Dict[str, dict] = {}

    def get(self, item) -> dict:
        key = item.path
        if key in self._mem:
            return self._mem[key]
        info = self._read(key)
        self._mem[key] = info
        return info

    def _read(self, path: str) -> dict:
        out: dict = {}
        try:
            audio = mutagen.File(path, easy=True)
        except Exception:
            return out
        if audio is None:
            return out
        try:
            if audio.info and getattr(audio.info, "length", None):
                out["duration_ms"] = int(audio.info.length * 1000)
        except Exception:
            pass
        for tag in ("title", "artist", "album", "date", "genre"):
            try:
                val = audio.get(tag)
                if val:
                    out[tag] = val[0]
            except Exception:
                pass
        # 把时长回写到 item 以便列表显示
        return out

    def fetch_cover(self, item) -> Optional[str]:
        if item.cover_path and Path(item.cover_path).exists():
            return item.cover_path
        cover = extract_cover(item.path, self._cover_dir)
        if cover:
            item.cover_path = str(cover)
        return item.cover_path


__all__ = ["MetadataCache"]
