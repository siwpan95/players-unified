"""缓存目录约定（cache/ 位于项目根，已 gitignore）。"""
from __future__ import annotations

import os
from pathlib import Path


def _base_cache() -> Path:
    if os.environ.get("MUSIC_PLAYER_CACHE"):
        return Path(os.environ["MUSIC_PLAYER_CACHE"])
    # music_player/utils/paths.py -> music-player/
    return Path(__file__).resolve().parents[2] / "cache"


_BASE: Path = None  # type: ignore


def app_cache_dir() -> Path:
    global _BASE
    if _BASE is None:
        _BASE = _base_cache()
        _BASE.mkdir(parents=True, exist_ok=True)
    return _BASE


def cover_cache_dir() -> Path:
    d = app_cache_dir() / "cover"
    d.mkdir(parents=True, exist_ok=True)
    return d


def decrypted_cache_dir() -> Path:
    d = app_cache_dir() / "decrypted"
    d.mkdir(parents=True, exist_ok=True)
    return d


def viz_cache_dir() -> Path:
    d = app_cache_dir() / "viz"
    d.mkdir(parents=True, exist_ok=True)
    return d


__all__ = ["app_cache_dir", "cover_cache_dir", "decrypted_cache_dir", "viz_cache_dir"]
