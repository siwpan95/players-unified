"""daily_player PlayerEngine 适配器测试（P1 / Phase 2）。

用「假 libVLC」（FakeInstance / FakePlayer）驱动真实的 VlcPlayerEngine，
校验端口语义与 PlayerState 契约。零三方依赖，用 python 直跑。

运行：python daily_player/tests/test_player_engine.py
"""
import os
import sys

def _find_repo_root(start):
    cur = os.path.abspath(start)
    while True:
        if os.path.isfile(os.path.join(cur, 'schema', 'media-item.schema.json')):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            raise RuntimeError('repo root not found')
        cur = parent

ROOT = _find_repo_root(__file__)
sys.path.insert(0, os.path.join(ROOT, 'schema'))
sys.path.insert(0, os.path.join(ROOT, 'daily_player'))

from validate import validate, load_schema                # noqa: E402
from player_engine import (                                # noqa: E402
    VlcPlayerEngine, clamp_rate, clamp_volume,
    VLC_PLAYING, VLC_PAUSED, VLC_ENDED,
)

SCHEMA = load_schema()
STATE_SCHEMA = SCHEMA['definitions']['PlayerState']


class FakeMedia:
    def __init__(self, uri):
        self.uri = uri


class FakeInstance:
    def __init__(self):
        self.new_calls = []

    def media_new(self, uri):
        self.new_calls.append(uri)
        return FakeMedia(uri)


class FakePlayer:
    """最小的 vlc.MediaPlayer 面，记录所有被调用的动作。"""

    def __init__(self, state=VLC_PLAYING, time_ms=1234, length_ms=60000,
                 rate=1.0, volume=80, muted=0):
        self._state = state
        self._time = time_ms
        self._length = length_ms
        self._rate = rate
        self._volume = volume
        self._muted = muted
        self.calls = []
        self.set_media_calls = []

    # --- 控制 ---
    def play(self):
        self.calls.append(('play',))

    def pause(self):
        self.calls.append(('pause',))

    def set_time(self, ms):
        self.calls.append(('set_time', ms))
        self._time = ms

    def set_rate(self, r):
        self.calls.append(('set_rate', r))
        self._rate = r

    def audio_set_volume(self, v):
        self.calls.append(('audio_set_volume', v))
        self._volume = v

    def audio_set_mute(self, v):
        self.calls.append(('audio_set_mute', v))
        self._muted = v

    def video_take_snapshot(self, num, path, w, h):
        self.calls.append(('video_take_snapshot', num, path, w, h))
        return 0

    def set_media(self, media):
        self.set_media_calls.append(media)

    # --- 查询 ---
    def get_state(self):
        return self._state

    def get_time(self):
        return self._time

    def get_length(self):
        return self._length

    def get_rate(self):
        return self._rate

    def audio_get_volume(self):
        return self._volume

    def audio_get_mute(self):
        return self._muted


def assert_state_schema(st):
    validate(st, STATE_SCHEMA)          # 不符则抛 ValueError
    assert set(st) == {'playing', 'timeMs', 'durationMs', 'rate', 'volume',
                       'muted', 'fullscreen'}, f"PlayerState 字段集不符: {sorted(st)}"
    assert isinstance(st['playing'], bool)
    assert isinstance(st['timeMs'], int)
    assert st['durationMs'] is None or isinstance(st['durationMs'], int)
    assert 0 <= st['volume'] <= 100


def main():
    # ---- 纯函数：夹紧 ----
    assert clamp_rate(5) == 3.0, "rate 上限应夹到 3.0"
    assert clamp_rate(0.1) == 0.25, "rate 下限应夹到 0.25"
    assert clamp_rate(2) == 2.0
    assert clamp_rate('bad') == 1.0, "非法 rate 应回落 1.0"
    assert clamp_volume(150) == 100
    assert clamp_volume(-3) == 0
    assert clamp_volume(42.6) == 43, "音量应四舍五入到整数"

    # ---- load / play / pause ----
    inst, pl = FakeInstance(), FakePlayer()
    eng = VlcPlayerEngine(inst, pl, fullscreen_getter=lambda: True)
    item = {'id': 'x', 'uri': r'C:\media\movie.mp4', 'title': 'movie',
            'kind': 'video', 'source': 'local-file'}
    eng.load(item)
    assert inst.new_calls == [item['uri']], "media_new 应收到 MediaItem.uri"
    assert pl.set_media_calls and pl.set_media_calls[0].uri == item['uri']
    eng.play()
    eng.pause()
    assert ('play',) in pl.calls and ('pause',) in pl.calls

    # ---- seek（毫秒直通，负数夹到 0）----
    eng.seek(1500)
    assert ('set_time', 1500) in pl.calls, "seek(1500ms) 应直接 set_time(1500)"
    eng.seek(-5)
    assert ('set_time', 0) in pl.calls, "负偏移应夹到 0"

    # ---- setRate / setVolume 夹紧 ----
    eng.setRate(5)
    assert ('set_rate', 3.0) in pl.calls
    eng.setRate(0.1)
    assert ('set_rate', 0.25) in pl.calls
    eng.setVolume(150)
    assert ('audio_set_volume', 100) in pl.calls
    eng.setVolume(-3)
    assert ('audio_set_volume', 0) in pl.calls

    # ---- setMuted ----
    eng.setMuted(True)
    assert ('audio_set_mute', 1) in pl.calls

    # ---- snapshot ----
    eng.snapshot(r'C:\media\shot.png')
    assert ('video_take_snapshot', 0, r'C:\media\shot.png', 0, 0) in pl.calls

    # ---- getState：正常播放中 ----
    # 用独立的假 player：上面的 seek 会真实改掉 FakePlayer 的 current time
    pl_state = FakePlayer(state=VLC_PLAYING, time_ms=1234, length_ms=60000,
                          rate=1.0, volume=80, muted=0)
    eng_state = VlcPlayerEngine(FakeInstance(), pl_state, fullscreen_getter=lambda: True)
    st = eng_state.getState()
    assert_state_schema(st)
    assert st['playing'] is True, "state=Playing 时 playing 应为 True"
    assert st['timeMs'] == 1234
    assert st['durationMs'] == 60000
    assert st['rate'] == 1.0
    assert st['volume'] == 80
    assert st['muted'] is False
    assert st['fullscreen'] is True, "fullscreen_getter 应生效"

    # ---- getState：暂停 / 时长未知 / 时间未知 / 音量错误(-1) ----
    pl2 = FakePlayer(state=VLC_PAUSED, time_ms=-1, length_ms=0, volume=-1, muted=1)
    st2 = VlcPlayerEngine(FakeInstance(), pl2).getState()
    assert_state_schema(st2)
    assert st2['playing'] is False, "state=Paused 时 playing 应为 False"
    assert st2['timeMs'] == 0, "get_time()=-1（未知）应归一为 0"
    assert st2['durationMs'] is None, "get_length()<=0 应为 None"
    assert st2['volume'] == 0, "audio_get_volume()=-1（出错）应归一为 0"
    assert st2['muted'] is True
    assert st2['fullscreen'] is False, "未提供 getter 时默认 False"

    # ---- getState：Ended 也不算 playing ----
    pl3 = FakePlayer(state=VLC_ENDED)
    assert VlcPlayerEngine(FakeInstance(), pl3).getState()['playing'] is False

    print("[test] daily_player PlayerEngine 全部断言通过 ✅  PlayerState 符合 schema")
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except AssertionError as e:
        print(f"[test] 断言失败 ❌  {e}")
        sys.exit(1)
    except ValueError as e:
        print(f"[test] schema 校验失败 ❌  {e}")
        sys.exit(1)
