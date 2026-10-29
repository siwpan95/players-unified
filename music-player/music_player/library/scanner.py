"""文件 / 目录扫描 → MediaItem 列表。"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, List

from ..engine.media_item import MediaItem, MediaType

AUDIO_EXTENSIONS = {
    ".mp3", ".flac", ".ogg", ".wav", ".wma", ".m4a", ".aac",
    ".opus", ".ape", ".mp2", ".mp1", ".tta", ".wv", ".m4b", ".caf", ".mpc",
}


def _make_item(path: Path) -> MediaItem:
    return MediaItem(
        name=path.stem,
        path=str(path.resolve()),
        item_type=MediaType.LOCAL_FILE,
    )


def scan_paths(paths: Iterable[str], recursive: bool = True) -> List[MediaItem]:
    """扫描给定路径（文件或目录）。目录默认递归。返回 MediaItem 列表。"""
    items: List[MediaItem] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            walker = p.rglob("*") if recursive else p.glob("*")
            for f in walker:
                if f.is_file() and f.suffix.lower() in AUDIO_EXTENSIONS:
                    items.append(_make_item(f))
        elif p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS:
            items.append(_make_item(p))
    return items


__all__ = ["scan_paths", "AUDIO_EXTENSIONS"]
