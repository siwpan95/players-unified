"""播放内核门面（PlayerEngine）。

唯一持有 python-vlc 的地方。UI / 库只通过本类的命令方法与只读查询交互，
所有 VLC 底层事件统一收敛为 `PlayerState` 增量，经 `EventBus` 广播。

线程约定：
- 命令方法（load/play/seek/set_*）必须在**主线程**调用。
- VLC 回调运行在 VLC 内部线程，只更新内部 `_state` 并广播；UI 回调内部应自行
  用 `root.after(0, ...)` 切回主线程（见 ui 层）。
"""
from __future__ import annotations

import threading
from typing import Callable, Optional

from ..utils.vlc_runtime import ensure_vlc_env, vlc_missing_message

if not ensure_vlc_env():
    raise RuntimeError(vlc_missing_message())
import vlc  # noqa: E402

from .events import EventBus  # noqa: E402
from .media_item import MediaItem  # noqa: E402
from .player_state import PlayMode, PlaybackStatus, PlayerState  # noqa: E402

_DEFAULT_ARGS = ["--no-video", "--quiet", "--no-osd"]


class PlayerEngine:
    def __init__(self, vlc_args: Optional[list[str]] = None) -> None:
        args = list(vlc_args or _DEFAULT_ARGS)
        self._instance = vlc.Instance(args)
        if self._instance is None:
            raise RuntimeError("无法创建 VLC Instance（libVLC 加载失败）")
        self._player = self._instance.media_player_new()
        self._media: Optional[vlc.Media] = None
        self._state = PlayerState()
        self._bus = EventBus()
        self._lock = threading.Lock()

        em = self._player.event_manager()
        em.event_attach(vlc.EventType.MediaPlayerEndReached, self._on_end)
        em.event_attach(vlc.EventType.MediaPlayerPlaying, self._on_playing)
        em.event_attach(vlc.EventType.MediaPlayerPaused, self._on_paused)
        em.event_attach(vlc.EventType.MediaPlayerStopped, self._on_stopped)
        em.event_attach(vlc.EventType.MediaPlayerTimeChanged, self._on_time)
        em.event_attach(vlc.EventType.MediaPlayerPositionChanged, self._on_position)
        em.event_attach(vlc.EventType.MediaPlayerEncounteredError, self._on_error)

    # ---------- 事件回调（VLC 线程） ----------
    def _emit_state(self) -> None:
        self._bus.emit_state(self._state.snapshot())

    def _on_end(self, event) -> None:  # noqa: ARG002
        with self._lock:
            self._state.status = PlaybackStatus.STOPPED
            self._state.position_ms = 0
        self._emit_state()
        self._bus.emit_end()

    def _on_playing(self, event) -> None:  # noqa: ARG002
        with self._lock:
            self._state.status = PlaybackStatus.PLAYING
        self._emit_state()

    def _on_paused(self, event) -> None:  # noqa: ARG002
        with self._lock:
            self._state.status = PlaybackStatus.PAUSED
        self._emit_state()

    def _on_stopped(self, event) -> None:  # noqa: ARG002
        with self._lock:
            self._state.status = PlaybackStatus.STOPPED
        self._emit_state()

    def _on_time(self, event) -> None:  # noqa: ARG002
        with self._lock:
            self._state.position_ms = self._player.get_time()
            self._state.duration_ms = self._player.get_length()
        self._bus.emit_position(self._state.position_ms, self._state.duration_ms)

    def _on_position(self, event) -> None:  # noqa: ARG002
        with self._lock:
            self._state.position_ms = self._player.get_time()
            self._state.duration_ms = self._player.get_length()
        self._bus.emit_position(self._state.position_ms, self._state.duration_ms)

    def _on_error(self, event) -> None:  # noqa: ARG002
        self._bus.emit_error("播放出错：文件可能损坏或格式不受支持")

    # ---------- 传输控制（主线程） ----------
    def load(self, item: MediaItem) -> None:
        with self._lock:
            if item.is_radio:
                self._media = self._instance.media_new(item.path)
            else:
                self._media = self._instance.media_new_path(item.path)
            self._player.set_media(self._media)
            self._state.current_uri = item.path
            self._state.status = PlaybackStatus.STOPPED
            self._state.position_ms = 0
            self._state.duration_ms = 0
        try:
            self._media.parse_with_options(vlc.MediaParseFlag.local, 0)
        except Exception:
            pass
        # 解析后立即取一次时长（本地文件通常同步可得）
        try:
            dur = self._media.get_duration()
            if dur and dur > 0:
                with self._lock:
                    self._state.duration_ms = dur
        except Exception:
            pass
        self._emit_state()

    def play(self) -> None:
        self._player.play()

    def pause(self) -> None:
        self._player.pause()

    def toggle_pause(self) -> None:
        if self._player.get_state() == vlc.State.Playing:
            self._player.pause()
        else:
            self._player.play()

    def stop(self) -> None:
        self._player.stop()
        with self._lock:
            self._state.status = PlaybackStatus.STOPPED
            self._state.position_ms = 0
        self._emit_state()

    def seek(self, position_ms: int) -> None:
        target = max(0, int(position_ms))
        self._player.set_time(target)
        with self._lock:
            self._state.position_ms = target
        self._bus.emit_position(target, self._state.duration_ms)

    def set_volume(self, volume: int) -> None:
        v = max(0, min(100, int(volume)))
        self._player.audio_set_volume(v)
        with self._lock:
            self._state.volume = v
        self._emit_state()

    def set_mute(self, mute: bool) -> None:
        self._player.audio_set_mute(bool(mute))
        with self._lock:
            self._state.mute = mute
        self._emit_state()

    def set_play_mode(self, mode: PlayMode) -> None:
        with self._lock:
            self._state.play_mode = mode
        self._emit_state()

    def set_equalizer(self, preset: Optional[str] = None,
                      bands: Optional[list[float]] = None) -> None:
        from .equalizer import NUM_BANDS, resolve

        gains = resolve(preset, bands)
        if gains is None:
            # 关闭均衡器
            self._player.set_equalizer(None)
            with self._lock:
                self._state.equalizer_on = False
            self._emit_state()
            return

        eq = vlc.AudioEqualizer()
        for i in range(min(NUM_BANDS, len(gains))):
            try:
                eq.set_band(i, float(gains[i]))
            except Exception:
                pass
        self._player.set_equalizer(eq)
        with self._lock:
            self._state.equalizer_on = True
        self._emit_state()

    # ---------- 只读查询 ----------
    def get_time(self) -> int:
        return self._player.get_time()

    def get_length(self) -> int:
        return self._player.get_length()

    def get_state(self) -> PlayerState:
        with self._lock:
            self._state.position_ms = self._player.get_time()
            self._state.duration_ms = self._player.get_length()
            return self._state.snapshot()

    # ---------- 事件订阅 ----------
    def on_end_reached(self, cb: Callable[[], None]) -> None:
        self._bus.on_end_reached(cb)

    def on_state_changed(self, cb: Callable[[PlayerState], None]) -> None:
        self._bus.on_state_changed(cb)

    def on_position(self, cb: Callable[[int, int], None]) -> None:
        self._bus.on_position(cb)

    def on_error(self, cb: Callable[[str], None]) -> None:
        self._bus.on_error(cb)

    # ---------- 生命周期 ----------
    def release(self) -> None:
        try:
            self._player.release()
        except Exception:
            pass
        try:
            self._instance.release()
        except Exception:
            pass


__all__ = ["PlayerEngine"]
