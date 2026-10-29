"""加密曲库导入桥（ncmturnmp3 复用，不复制其源码）。

合规：仅用于解密**用户本人已购买/拥有**的加密文件（见 COMPLIANCE.md）。
UI 层在调用前应弹窗确认，本模块只负责解密动作本身。

接入方式：把 ncmturnmp3 目录加入 sys.path，直接调用其 `audio_core.process_one`
（比 subprocess 更稳、更易定位产物路径）。找不到 ncmturnmp3 时给出清晰错误，
功能优雅降级。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

from ..engine.media_item import MediaItem, MediaType
from ..utils.paths import decrypted_cache_dir

# ncmturnmp3 的可能位置（可用环境变量 NCMTURNMP3_DIR 覆盖）
_NCM_CANDIDATES = [
    Path(os.environ["NCMTURNMP3_DIR"]) if os.environ.get("NCMTURNMP3_DIR") else None,
    Path("D:/projects/ncmturnmp3"),
    Path("E:/projects/ncmturnmp3"),
    Path(os.path.expanduser("~/projects/ncmturnmp3")),
]


class EncryptedImportError(Exception):
    """导入加密文件失败时抛出（含可操作的提示）。"""


def _load_audio_core():
    for d in _NCM_CANDIDATES:
        if d and d.exists() and (d / "audio_core.py").exists():
            if str(d) not in sys.path:
                sys.path.insert(0, str(d))
            import audio_core  # noqa: WPS433 (late import, path-injected)
            return audio_core
    return None


def import_encrypted(
    src: str,
    cache_dir: Optional[str] = None,
    output_format: str = "mp3",
    bitrate: str = "320k",
) -> MediaItem:
    """解密单个加密音频文件，返回可播放的 MediaItem。

    产物落 cache/decrypted/<stem>.<fmt>，不随仓库分发。
    """
    src_path = Path(src)
    if not src_path.exists():
        raise EncryptedImportError(f"文件不存在：{src_path}")

    audio_core = _load_audio_core()
    if audio_core is None:
        raise EncryptedImportError(
            "未找到 ncmturnmp3（加密音乐转换器）。请确认 D:/projects/ncmturnmp3 存在，"
            "或设置环境变量 NCMTURNMP3_DIR 指向其目录。"
        )

    cache = Path(cache_dir or decrypted_cache_dir())
    cache.mkdir(parents=True, exist_ok=True)

    ok, msg = audio_core.process_one(str(src_path), str(cache), output_format, bitrate)
    if not ok:
        raise EncryptedImportError(msg)

    out_path = cache / f"{src_path.stem}.{output_format}"
    if not out_path.exists():
        raise EncryptedImportError(f"解密产物未生成：预期 {out_path}（{msg}）")

    return MediaItem(
        name=src_path.stem,
        path=str(out_path.resolve()),
        item_type=MediaType.DECRYPTED_CACHE,
        source_path=str(src_path),
    )


__all__ = ["import_encrypted", "EncryptedImportError"]
