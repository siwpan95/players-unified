"""daily_player PlayerEngine 适配器（Phase 2：共享 UX 控制契约）。

把 libVLC 的 `media_player` 包装成 ARCHITECTURE §3 定义的 PlayerEngine 端口：

    load(item) / play() / pause() / seek(ms) / setRate(rate 0.25..3) /
    setVolume(vol 0..100) / snapshot(path) / getState() -> PlayerState

设计要点
--------
1. **本模块不 `import vlc`**：依赖以构造参数注入（`instance` + `player`）。
   这样在没有 libVLC 运行时的环境下也能单测适配器逻辑（与 Phase 1「仅结构抽取、
   不改播放行为」同一思路）。
2. **vlc.State 是 IntEnum**（Playing=3 / Paused=4 / Ended=6 / Error=7），
   因此用 `int(state) == 3` 判定播放态，无需 import vlc 也能正确识别真实状态值。
3. 单位换算：libVLC 的 `get_time()/get_length()` 本身就是 **毫秒**，
   `set_time()` 也收毫秒 → 与 PlayerEngine 的 `seek(ms)` 直接对齐，无需换算。
4. 越界值一律夹紧（rate 0.25..3、volume 0..100），不抛异常。

未接线说明：与 Phase 1 的 `media_source.py` 一致，本适配器是**纯新增结构**，
`play.py` 既有播放行为未改动；后续在 UI 层接入即可。
"""

# libVLC State（IntEnum）的数值常量，避免 import vlc
VLC_NOTHING_SPECIAL = 0
VLC_OPENING = 1
VLC_BUFFERING = 2
VLC_PLAYING = 3
VLC_PAUSED = 4
VLC_STOPPED = 5
VLC_ENDED = 6
VLC_ERROR = 7

RATE_MIN = 0.25
RATE_MAX = 3.0
VOL_MIN = 0
VOL_MAX = 100


def clamp_rate(rate):
    """夹紧倍速到 0.25..3。非法值回落到 1.0。"""
    try:
        r = float(rate)
    except (TypeError, ValueError):
        return 1.0
    if r != r:  # NaN
        return 1.0
    return max(RATE_MIN, min(RATE_MAX, r))


def clamp_volume(vol):
    """夹紧音量到 0..100 的整数。非法值回落到 0。"""
    try:
        v = float(vol)
    except (TypeError, ValueError):
        return 0
    if v != v:  # NaN
        return 0
    return int(round(max(VOL_MIN, min(VOL_MAX, v))))


def _time_ms(v):
    """libVLC 时间（毫秒）→ PlayerState.timeMs。未知（-1/负数）→ 0。"""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return n if n >= 0 else 0


def _duration_ms(v):
    """libVLC 时长（毫秒）→ PlayerState.durationMs。未知（<=0）→ None。"""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


class VlcPlayerEngine:
    """把 libVLC 的 instance + media_player 适配成 PlayerEngine。"""

    def __init__(self, instance, player, fullscreen_getter=None):
        """
        instance: vlc.Instance（用于 media_new）
        player:   vlc.MediaPlayer
        fullscreen_getter: 可选，返回当前是否全屏（如 `lambda: daily.is_fullscreen`）
        """
        self.instance = instance
        self.player = player
        self._fullscreen_getter = fullscreen_getter or (lambda: False)

    # ---- PlayerEngine 端口 ----
    def load(self, item):
        """item: MediaItem（取其 uri）或直接的 uri 字符串。"""
        uri = item['uri'] if isinstance(item, dict) else str(item)
        media = self.instance.media_new(uri)
        self.player.set_media(media)
        return self

    def play(self):
        self.player.play()
        return self

    def pause(self):
        self.player.pause()
        return self

    def seek(self, ms):
        try:
            t = int(ms)
        except (TypeError, ValueError):
            t = 0
        self.player.set_time(max(0, t))
        return self

    def setRate(self, rate):
        self.player.set_rate(clamp_rate(rate))
        return self

    def setVolume(self, vol):
        self.player.audio_set_volume(clamp_volume(vol))
        return self

    def setMuted(self, muted):
        self.player.audio_set_mute(1 if muted else 0)
        return self

    def snapshot(self, path):
        """截图保存。libVLC: video_take_snapshot(0, path, 0, 0)。返回 vlc 的返回值。"""
        return self.player.video_take_snapshot(0, path, 0, 0)

    def getState(self):
        """返回 PlayerState（见 schema/media-item.schema.json definitions.PlayerState）。"""
        state = self.player.get_state()
        try:
            playing = int(state) == VLC_PLAYING
        except (TypeError, ValueError):
            playing = False

        try:
            rate = float(self.player.get_rate())
        except (TypeError, ValueError):
            rate = 1.0
        if rate <= 0:
            rate = 1.0

        try:
            vol = int(self.player.audio_get_volume())
        except (TypeError, ValueError):
            vol = 0
        if vol < 0:  # libVLC 出错时返回 -1
            vol = 0

        return {
            'playing': playing,
            'timeMs': _time_ms(self.player.get_time()),
            'durationMs': _duration_ms(self.player.get_length()),
            'rate': rate,
            'volume': clamp_volume(vol),
            'muted': bool(self.player.audio_get_mute()),
            'fullscreen': bool(self._fullscreen_getter()),
        }
