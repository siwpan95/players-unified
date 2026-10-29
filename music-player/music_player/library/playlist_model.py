"""播放列表模型：增删、乱序、按模式取下一曲/上一曲。

状态维护：
- `_played`：已播索引集合（RANDOM 模式下去重）
- `_history`：导航栈（RANDOM 模式「上一曲」回退用）
"""
from __future__ import annotations

import random
from typing import List, Optional

from ..engine.media_item import MediaItem
from ..engine.player_state import PlayMode
from ..engine.play_mode import next_index, prev_index


class PlaylistModel:
    def __init__(self, mode: PlayMode = PlayMode.SEQUENTIAL) -> None:
        self._items: List[MediaItem] = []
        self._index: int = -1
        self._mode: PlayMode = mode
        self._played: set[int] = set()
        self._history: List[int] = []

    # ---------- 修改 ----------
    def add(self, items: List[MediaItem]) -> None:
        self._items.extend(items)

    def add_item(self, item: MediaItem) -> None:
        self._items.append(item)

    def remove(self, index: int) -> None:
        if not (0 <= index < len(self._items)):
            return
        del self._items[index]
        if index < self._index:
            self._index -= 1
        elif index == self._index:
            self._index = -1
        # 重建 played / history 中的索引
        self._played = {i if i < index else i - 1 for i in self._played if i != index}
        self._history = [i if i < index else i - 1 for i in self._history if i != index]

    def clear(self) -> None:
        self._items = []
        self._index = -1
        self._played = set()
        self._history = []

    # ---------- 导航 ----------
    def current(self) -> Optional[MediaItem]:
        if 0 <= self._index < len(self._items):
            return self._items[self._index]
        return None

    def jump(self, index: int) -> Optional[MediaItem]:
        if not (0 <= index < len(self._items)):
            return None
        self._index = index
        self._played.add(index)
        self._history.append(index)
        return self._items[index]

    def next(self) -> Optional[MediaItem]:
        cand = next_index(self._index, len(self._items), self._mode, self._played)
        if cand is None:
            return None
        self._index = cand
        self._played.add(cand)
        self._history.append(cand)
        return self._items[cand]

    def prev(self) -> Optional[MediaItem]:
        if not self._items:
            return None
        if self._mode == PlayMode.RANDOM:
            if len(self._history) >= 2:
                self._history.pop()  # 移除当前
                cand = self._history[-1]
                self._index = cand
                return self._items[cand]
            return self.current()
        cand = prev_index(self._index, len(self._items), self._mode, self._history)
        if cand is None:
            return None
        self._index = cand
        self._history.append(cand)
        return self._items[cand]

    # ---------- 模式 / 工具 ----------
    def set_mode(self, mode: PlayMode) -> None:
        self._mode = mode

    def get_mode(self) -> PlayMode:
        return self._mode

    def shuffle(self) -> None:
        random.shuffle(self._items)
        self._index = -1
        self._played = set()
        self._history = []

    def __len__(self) -> int:
        return len(self._items)

    def items(self) -> List[MediaItem]:
        return list(self._items)

    def index(self) -> int:
        return self._index


__all__ = ["PlaylistModel"]
