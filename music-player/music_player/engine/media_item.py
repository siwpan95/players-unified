"""媒体条目契约 (MediaItem)。

镜像 `localplayer` 的 MediaItem 思想（name / path / type），并扩展出
封面、元数据、来源路径（加密导入合规追踪用）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class MediaType(Enum):
    LOCAL_FILE = "local_file"           # 本地音频文件
    DECRYPTED_CACHE = "decrypted_cache" # ncmturnmp3 解密产物（落 cache/）
    RADIO_HLS = "radio_hls"             # .m3u8
    RADIO_HTTP = "radio_http"           # 普通 HTTP 流


@dataclass
class MediaItem:
    name: str
    path: str                           # 本地 = 绝对路径；电台 = URL
    item_type: MediaType
    duration_ms: Optional[int] = None
    cover_path: Optional[str] = None
    metadata: dict = field(default_factory=dict)
    source_path: Optional[str] = None   # 解密来源（合规追踪）

    @property
    def is_radio(self) -> bool:
        return self.item_type in (MediaType.RADIO_HLS, MediaType.RADIO_HTTP)

    @property
    def display_title(self) -> str:
        md = self.metadata or {}
        artist = md.get("artist")
        title = md.get("title") or self.name
        if artist:
            return f"{artist} - {title}"
        return title


__all__ = ["MediaType", "MediaItem"]
