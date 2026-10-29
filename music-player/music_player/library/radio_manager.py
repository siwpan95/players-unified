"""网络电台 / HLS 直播流管理。

python-vlc 原生支持 .m3u8（HLS）与普通 HTTP 流，无需额外解码器。
RadioManager 仅维护电台条目；单源降级参考 private-radio-stations 的 bridge 模式。
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from ..engine.media_item import MediaItem, MediaType


class RadioManager:
    def __init__(self) -> None:
        self._stations: List[MediaItem] = []

    def add_station(self, name: str, url: str, kind: str = "hls") -> MediaItem:
        mtype = MediaType.RADIO_HLS if kind in ("hls", ".m3u8") else MediaType.RADIO_HTTP
        item = MediaItem(name=name, path=url, item_type=mtype)
        self._stations.append(item)
        return item

    def from_m3u(self, path: str) -> List[MediaItem]:
        """解析 .m3u / .m3u8 播放列表（#EXTINF 名称 + URL）。"""
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
        items: List[MediaItem] = []
        cur_name: Optional[str] = None
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith("#EXTINF"):
                if "," in line:
                    cur_name = line.split(",", 1)[1].strip()
            elif line and not line.startswith("#"):
                kind = "hls" if line.lower().endswith(".m3u8") else "http"
                items.append(self.add_station(cur_name or line, line, kind))
                cur_name = None
        return items

    def list(self) -> List[MediaItem]:
        return list(self._stations)

    def degrade(self, item: MediaItem) -> Optional[MediaItem]:
        """单源降级：当前实现返回 None（无备用源）。可在此接入多 CDN 备选。"""
        return None


__all__ = ["RadioManager"]
