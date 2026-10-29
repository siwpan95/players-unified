"""音频可视化：离线预计算频谱/波形（numpy STFT，默认不依赖 librosa）。

设计：用 ffmpeg 把音频抽成 16-bit PCM → numpy 做 STFT → 缓存 .npz。
播放时按 `get_time()` 取出对应列滚动绘制，零音频回调风险、零实时开销。
可选 `librosa` 仅用于 mel 美化（pip install music-player[viz]）。
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional

import numpy as np

from ..utils.ffmpeg import find_ffmpeg
from ..utils.paths import viz_cache_dir


class Visualizer:
    def __init__(self, mode: str = "spectrum", sr: int = 22050, n_fft: int = 1024, hop: int = 512):
        self.mode = mode
        self.sr = sr
        self.n_fft = n_fft
        self.hop = hop
        self._frames: Optional[np.ndarray] = None      # (n_frames, n_bins)
        self._duration_ms: int = 0
        self._cache_dir = viz_cache_dir()

    def precompute(self, path: str) -> bool:
        """抽 PCM 并计算频谱/波形。成功返回 True。"""
        ffmpeg = find_ffmpeg()
        if ffmpeg is None:
            return False
        src = Path(path)
        key = f"{abs(hash(str(src))) & 0xffffffff:x}_{src.stat().st_size}_{self.mode}"
        cache_file = self._cache_dir / f"{key}.npz"
        if cache_file.exists():
            try:
                data = np.load(cache_file)
                self._frames = data["frames"]
                self._duration_ms = int(data["duration_ms"])
                return True
            except Exception:
                pass

        # ffmpeg: 抽单声道 16bit PCM
        cmd = [
            ffmpeg, "-y", "-i", str(src),
            "-ac", "1", "-ar", str(self.sr), "-f", "s16le", "-",
        ]
        try:
            raw = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True).stdout
        except Exception:
            return False
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if samples.size == 0:
            return False

        duration_ms = int(len(samples) / self.sr * 1000)

        if self.mode == "waveform":
            # 每 hop 取一个 RMS 包络
            n = max(1, (len(samples) - self.n_fft) // self.hop)
            env = np.zeros(n, dtype=np.float32)
            for i in range(n):
                seg = samples[i * self.hop: i * self.hop + self.n_fft]
                env[i] = np.sqrt(np.mean(seg ** 2) + 1e-12)
            self._frames = env.reshape(-1, 1)
        else:
            # 幅度谱（对数），按帧为行
            n = max(1, (len(samples) - self.n_fft) // self.hop)
            bins = self.n_fft // 2 + 1
            mag = np.zeros((n, bins), dtype=np.float32)
            window = np.hanning(self.n_fft)
            for i in range(n):
                seg = samples[i * self.hop: i * self.hop + self.n_fft] * window
                spec = np.fft.rfft(seg, self.n_fft)
                mag[i] = np.abs(spec)
            # 对数压缩 + 归一，便于绘制
            mag = np.log1p(mag)
            mag = (mag - mag.min()) / (mag.max() - mag.min() + 1e-9)
            self._frames = mag

        self._duration_ms = duration_ms
        try:
            np.savez(cache_file, frames=self._frames, duration_ms=duration_ms)
        except Exception:
            pass
        return True

    def frame_at(self, position_ms: int) -> Optional[np.ndarray]:
        if self._frames is None or self._duration_ms <= 0:
            return None
        frac = max(0.0, min(1.0, position_ms / self._duration_ms))
        idx = int(frac * (self._frames.shape[0] - 1))
        return self._frames[idx]

    def render(self, canvas, position_ms: int, width: int = 360, height: int = 120) -> None:
        """在 tk Canvas 上绘制当前帧（频谱条 / 波形）。"""
        canvas.delete("viz")
        if self._frames is None:
            return
        frame = self.frame_at(position_ms)
        if frame is None:
            return
        if self.mode == "waveform":
            v = float(frame[0])
            y = height - int(v * height)
            canvas.create_line(0, y, width, y, fill="#4CAF50", width=2, tags="viz")
            return
        n = frame.shape[0]
        bar_w = max(1, width / n)
        for i in range(n):
            v = float(frame[i])
            h = int(v * height)
            x = i * bar_w
            canvas.create_rectangle(x, height - h, x + bar_w - 1, height,
                                    fill="#5B8FF9", outline="", tags="viz")


__all__ = ["Visualizer"]
