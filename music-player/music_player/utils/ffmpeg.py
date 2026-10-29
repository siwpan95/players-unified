"""ffmpeg 发现：FFMPEG_BIN > PATH > imageio-ffmpeg。"""
from __future__ import annotations

import os
import shutil
from typing import Optional


def find_ffmpeg() -> Optional[str]:
    env = os.environ.get("FFMPEG_BIN")
    if env and os.path.exists(env):
        return env
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    return None


__all__ = ["find_ffmpeg"]
