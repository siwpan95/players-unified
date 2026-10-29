"""播放内核层：状态契约、媒体条目契约、播放模式、事件总线、VLC 门面。"""
from .player_state import PlayMode, PlaybackStatus, PlayerState
from .media_item import MediaItem, MediaType
from .play_mode import next_index, prev_index
from .events import EventBus
from .player_engine import PlayerEngine
from .equalizer import (
    BAND_FREQUENCIES_HZ, DEFAULT_PRESET, NUM_BANDS, PRESET_NAMES,
    clamp_bands, get_preset_bands, is_valid_preset, resolve,
)
from .rpc_bridge import DispatchFn, RpcServer

__all__ = [
    "PlayMode", "PlaybackStatus", "PlayerState",
    "MediaItem", "MediaType",
    "next_index", "prev_index",
    "EventBus", "PlayerEngine",
    "BAND_FREQUENCIES_HZ", "DEFAULT_PRESET", "NUM_BANDS", "PRESET_NAMES",
    "clamp_bands", "get_preset_bands", "is_valid_preset", "resolve",
    "DispatchFn", "RpcServer",
]
