from music_player.engine import PlayMode, PlaybackStatus, PlayerState


def test_defaults():
    s = PlayerState()
    assert s.status == PlaybackStatus.STOPPED
    assert s.volume == 80
    assert s.play_mode == PlayMode.SEQUENTIAL
    assert s.mute is False


def test_snapshot_is_independent():
    s = PlayerState()
    snap = s.snapshot()
    s.volume = 50
    assert snap.volume == 80
    assert s.volume == 50


def test_enums_exhaustive():
    assert {m.value for m in PlayMode} == {"sequential", "loop", "single", "random"}
    assert {s.value for s in PlaybackStatus} == {"stopped", "playing", "paused"}
