import time

import pytest

from music_player.utils.vlc_runtime import ensure_vlc_env

pytestmark = [
    pytest.mark.network,
    pytest.mark.skipif(not ensure_vlc_env(), reason="VLC 运行时未找到"),
]

from music_player.engine import MediaItem, MediaType, PlaybackStatus, PlayerEngine  # noqa: E402

HLS_TEST = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"


def test_hls_play():
    eng = PlayerEngine()
    item = MediaItem(name="test", path=HLS_TEST, item_type=MediaType.RADIO_HLS)
    eng.load(item)
    eng.play()
    time.sleep(3)
    assert eng.get_state().status in (PlaybackStatus.PLAYING, PlaybackStatus.PAUSED)
    eng.stop()
    eng.release()
