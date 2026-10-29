import time

import pytest

from music_player.utils.vlc_runtime import ensure_vlc_env

if not ensure_vlc_env():
    pytest.skip("VLC 运行时未找到，跳过引擎 E2E", allow_module_level=True)

from music_player.engine import MediaItem, MediaType, PlaybackStatus, PlayerEngine  # noqa: E402


def test_length_and_seek(fixtures_dir):
    eng = PlayerEngine()
    item = MediaItem(name="s", path=str(fixtures_dir / "sample.mp3"),
                    item_type=MediaType.LOCAL_FILE)
    eng.load(item)
    eng.play()
    for _ in range(60):
        if eng.get_length() > 0:
            break
        time.sleep(0.1)
    assert eng.get_length() > 0, "get_length 应 > 0"

    target = int(eng.get_length() * 0.5)
    eng.seek(target)
    time.sleep(0.6)
    pos = eng.get_time()
    assert abs(pos - target) < eng.get_length() * 0.1, f"seek 后位置应≈{target}，实际 {pos}"

    eng.stop()
    eng.release()


def test_status_transitions(fixtures_dir):
    eng = PlayerEngine()
    item = MediaItem(name="s", path=str(fixtures_dir / "sample.mp3"),
                    item_type=MediaType.LOCAL_FILE)
    eng.load(item)
    eng.play()
    time.sleep(0.5)
    assert eng.get_state().status == PlaybackStatus.PLAYING
    eng.pause()
    time.sleep(0.3)
    assert eng.get_state().status == PlaybackStatus.PAUSED
    eng.release()
