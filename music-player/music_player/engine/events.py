"""状态观察者 / 命令总线（RPC-ready）。

PlayerEngine 把 VLC 的底层事件统一收敛成三类高层回调：
- end_reached：一曲播完（用于自动切歌，命令总线）
- state_changed：PlayerState 增量（UI 只读此对象刷新）
- position：播放进度 (pos_ms, length_ms)

P2 阶段可由 RPC 桥（engine/events 之上的 asyncio 服务）直接订阅这些回调，
实现无头控制，无需修改引擎本身。
"""
from __future__ import annotations

from typing import Callable

from .player_state import PlayerState


class EventBus:
    def __init__(self) -> None:
        self._end_cbs: list[Callable[[], None]] = []
        self._state_cbs: list[Callable[[PlayerState], None]] = []
        self._pos_cbs: list[Callable[[int, int], None]] = []
        self._error_cbs: list[Callable[[str], None]] = []

    # --- 订阅 ---
    def on_end_reached(self, cb: Callable[[], None]) -> None:
        self._end_cbs.append(cb)

    def on_state_changed(self, cb: Callable[[PlayerState], None]) -> None:
        self._state_cbs.append(cb)

    def on_position(self, cb: Callable[[int, int], None]) -> None:
        self._pos_cbs.append(cb)

    def on_error(self, cb: Callable[[str], None]) -> None:
        self._error_cbs.append(cb)

    # --- 广播 ---
    def emit_end(self) -> None:
        for cb in self._end_cbs:
            cb()

    def emit_state(self, state: PlayerState) -> None:
        for cb in self._state_cbs:
            cb(state)

    def emit_position(self, pos_ms: int, length_ms: int) -> None:
        for cb in self._pos_cbs:
            cb(pos_ms, length_ms)

    def emit_error(self, message: str) -> None:
        for cb in self._error_cbs:
            cb(message)


__all__ = ["EventBus"]
