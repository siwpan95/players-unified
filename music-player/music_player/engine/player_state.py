"""播放状态契约（PlayerState）。

UI 层只依赖这个只读视图，不碰 python-vlc。内核 (PlayerEngine) 是唯一持有 VLC 的地方，
所有事件最终收敛为 PlayerState 的增量，并通过 events 总线广播给观察者。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class PlaybackStatus(Enum):
    STOPPED = "stopped"
    PLAYING = "playing"
    PAUSED = "paused"


class PlayMode(Enum):
    SEQUENTIAL = "sequential"   # 顺序
    LOOP = "loop"               # 列表循环
    SINGLE = "single"           # 单曲循环
    RANDOM = "random"           # 随机


@dataclass
class PlayerState:
    status: PlaybackStatus = PlaybackStatus.STOPPED
    current_index: int = -1
    current_uri: str = ""
    position_ms: int = 0
    duration_ms: int = 0
    volume: int = 80            # 0-100
    mute: bool = False
    play_mode: PlayMode = PlayMode.SEQUENTIAL
    equalizer_on: bool = False

    def snapshot(self) -> "PlayerState":
        """返回当前状态的浅拷贝，避免观察者持有可变内部引用。"""
        return PlayerState(
            status=self.status,
            current_index=self.current_index,
            current_uri=self.current_uri,
            position_ms=self.position_ms,
            duration_ms=self.duration_ms,
            volume=self.volume,
            mute=self.mute,
            play_mode=self.play_mode,
            equalizer_on=self.equalizer_on,
        )


__all__ = ["PlaybackStatus", "PlayMode", "PlayerState"]
