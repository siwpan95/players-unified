"""播放模式的下一曲 / 上一曲排序逻辑（纯函数，便于单测）。

`PlaylistModel` 负责维护 `played`（已播集合）与 `history`（历史栈）；
本模块只算「下一个索引应该是什么」，不持有状态。
"""
from __future__ import annotations

import random
from typing import Optional

from .player_state import PlayMode


def next_index(current: int, length: int, mode: PlayMode, played: set[int]) -> Optional[int]:
    """返回下一曲索引；到末尾且非循环则返回 None（表示停止）。"""
    if length <= 0:
        return None
    if current < 0:
        return 0

    if mode == PlayMode.SINGLE:
        return current

    if mode == PlayMode.RANDOM:
        remaining = [i for i in range(length) if i not in played]
        if not remaining:
            played.clear()
            remaining = list(range(length))
        return random.choice(remaining)

    # SEQUENTIAL / LOOP
    nxt = current + 1
    if nxt >= length:
        return 0 if mode == PlayMode.LOOP else None
    return nxt


def prev_index(current: int, length: int, mode: PlayMode, history: list[int]) -> Optional[int]:
    """返回上一曲索引；到开头且非循环则返回 None。"""
    if length <= 0:
        return None
    if current < 0:
        return 0

    if mode == PlayMode.SINGLE:
        return current

    if mode == PlayMode.RANDOM:
        if history:
            return history[-1]
        return current

    prev = current - 1
    if prev < 0:
        return length - 1 if mode == PlayMode.LOOP else None
    return prev


__all__ = ["next_index", "prev_index"]
