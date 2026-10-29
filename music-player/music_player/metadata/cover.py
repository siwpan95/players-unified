"""从音频文件抽取内嵌封面（APIC / FLAC picture / MP4 covr）→ 缓存 PNG/JPG。"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional

import mutagen


def extract_cover(audio_path: str, cover_dir: Path) -> Optional[Path]:
    try:
        f = mutagen.File(audio_path)
    except Exception:
        return None
    if f is None or not getattr(f, "tags", None):
        return None

    data: Optional[bytes] = None
    try:
        # ID3 / APIC
        if hasattr(f.tags, "keys"):
            for key in list(f.tags.keys()):
                if str(key).startswith("APIC"):
                    data = bytes(f.tags[key].data)
                    break
        # FLAC / OGG pictures
        if data is None and hasattr(f, "pictures") and f.pictures:
            data = bytes(f.pictures[0].data)
        # MP4 covr
        if data is None:
            try:
                from mutagen.mp4 import MP4
                if isinstance(f, MP4):
                    covr = f.tags.get("covr")
                    if covr:
                        data = bytes(covr[0])
            except Exception:
                pass
    except Exception:
        return None

    if not data:
        return None

    digest = hashlib.md5(str(audio_path).encode("utf-8")).hexdigest()[:12]
    ext = ".png" if data[:8] == b"\x89PNG\r\n\x1a\n" else ".jpg"
    out = Path(cover_dir) / f"{digest}{ext}"
    out.write_bytes(data)
    return out


__all__ = ["extract_cover"]
