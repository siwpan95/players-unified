"""均衡器预设 / 解析逻辑测试 + 通过引擎应用（需 VLC）。"""
from __future__ import annotations

import pytest

from music_player.engine.equalizer import (
    NUM_BANDS, PRESET_NAMES, clamp_bands, get_preset_bands, is_valid_preset, resolve,
)


def test_presets_have_correct_length():
    for name in PRESET_NAMES:
        bands = get_preset_bands(name)
        assert len(bands) == NUM_BANDS, f"预设 {name} 段数错误"


def test_resolve_preset_returns_copy():
    a = resolve("flat", None)
    a[0] = 99.0
    b = resolve("flat", None)
    assert b[0] == 0.0, "resolve 应返回拷贝，避免调用方误改预设"


def test_resolve_none_disables():
    assert resolve(None, None) is None


def test_resolve_custom_clamped_and_padded():
    bands = clamp_bands([100, -100, 5, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert bands[0] == 20.0
    assert bands[1] == -20.0
    assert len(bands) == NUM_BANDS


def test_is_valid_preset():
    assert is_valid_preset("rock")
    assert not is_valid_preset("nope")
    assert is_valid_preset("flat")


def test_engine_set_equalizer_roundtrip():
    pytest.importorskip("vlc")
    from music_player.engine import PlayerEngine

    eng = PlayerEngine()
    try:
        assert eng.get_state().equalizer_on is False
        eng.set_equalizer(preset="rock")
        assert eng.get_state().equalizer_on is True
        eng.set_equalizer(preset=None, bands=None)
        assert eng.get_state().equalizer_on is False
    finally:
        eng.release()
