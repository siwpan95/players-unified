"""均衡器预设（vlc.AudioEqualizer 桥）。

本模块不依赖 python-vlc，可独立 import（便于测试 / 无头环境）。
播放内核 (PlayerEngine.set_equalizer) 会把预设名解析成这里定义的 10 段增益列表。

VLC 均衡器为 10 段，中心频率（Hz）固定如下；增益单位为 dB，范围约 [-20, 20]。
"""
from __future__ import annotations

from typing import Optional

# VLC 10 段均衡器的中心频率（顺序固定，UI 标注用）
BAND_FREQUENCIES_HZ: tuple[int, ...] = (
    60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000,
)
NUM_BANDS: int = len(BAND_FREQUENCIES_HZ)

# 预设：每个预设是长度为 10 的 dB 增益列表，顺序对应 BAND_FREQUENCIES_HZ
_PRESETS: dict[str, list[float]] = {
    "flat":     [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "rock":     [4.0, 3.0, 2.0, 1.0, -1.0, -1.0, 1.0, 2.0, 3.0, 4.0],
    "pop":      [-1.0, 2.0, 4.0, 4.0, 1.0, -1.0, -1.0, 0.0, 1.0, 2.0],
    "jazz":     [3.0, 2.0, 1.0, 2.0, -1.0, -1.0, 0.0, 1.0, 2.0, 3.0],
    "classical":[4.0, 3.0, 2.0, 1.0, -1.0, -1.0, 0.0, 2.0, 3.0, 4.0],
    "bass":     [6.0, 5.0, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "vocal":    [-2.0, -1.0, 0.0, 2.0, 3.0, 3.0, 2.0, 0.0, -1.0, -2.0],
}

DEFAULT_PRESET: str = "flat"
PRESET_NAMES: list[str] = list(_PRESETS.keys())


def get_preset_bands(name: str) -> list[float]:
    """返回预设的 10 段增益列表（拷贝）。未知名称回退到 flat。"""
    return list(_PRESETS.get(name, _PRESETS[DEFAULT_PRESET]))


def is_valid_preset(name: str) -> bool:
    return name in _PRESETS


def clamp_bands(bands: list[float], lo: float = -20.0, hi: float = 20.0) -> list[float]:
    """约束每个频段的增益到 [lo, hi]，并补齐/截断到 NUM_BANDS 段。"""
    out: list[float] = []
    for i in range(NUM_BANDS):
        if i < len(bands):
            try:
                g = float(bands[i])
            except (TypeError, ValueError):
                g = 0.0
        else:
            g = 0.0
        out.append(max(lo, min(hi, g)))
    return out


def resolve(preset: Optional[str], bands: Optional[list[float]]) -> Optional[list[float]]:
    """把 (preset 名 / 自定义 bands) 解析为实际增益列表；两者皆空返回 None（关闭）。"""
    if bands:
        return clamp_bands(bands)
    if preset:
        return get_preset_bands(preset)
    return None


__all__ = [
    "BAND_FREQUENCIES_HZ",
    "NUM_BANDS",
    "PRESET_NAMES",
    "DEFAULT_PRESET",
    "get_preset_bands",
    "is_valid_preset",
    "clamp_bands",
    "resolve",
]
