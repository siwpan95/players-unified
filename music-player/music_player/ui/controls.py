"""控制栏：上一首 / 播放·暂停 / 停止 / 下一首 / 音量 / 播放模式。"""
from __future__ import annotations

from tkinter import ttk
import tkinter as tk

from ..engine.player_state import PlayMode


class ControlsPanel:
    def __init__(self, parent, app) -> None:
        self.app = app
        self.frame = ttk.Frame(parent, padding=6)

        self.btn_prev = ttk.Button(self.frame, text="上一首", width=8, command=self.app.prev)
        self.btn_prev.pack(side=tk.LEFT, padx=2)
        self.btn_play = ttk.Button(self.frame, text="播放", width=8, command=self.app.toggle_play)
        self.btn_play.pack(side=tk.LEFT, padx=2)
        self.btn_stop = ttk.Button(self.frame, text="停止", width=8, command=self.app.stop)
        self.btn_stop.pack(side=tk.LEFT, padx=2)
        self.btn_next = ttk.Button(self.frame, text="下一首", width=8, command=self.app.next)
        self.btn_next.pack(side=tk.LEFT, padx=2)

        ttk.Label(self.frame, text=" 音量").pack(side=tk.LEFT, padx=(10, 0))
        self.volume = ttk.Scale(self.frame, from_=0, to=100, orient=tk.HORIZONTAL,
                               command=lambda v: self.app.set_volume(int(float(v))))
        self.volume.set(80)
        self.volume.pack(side=tk.LEFT, padx=4, fill=tk.X, expand=True)

        self.btn_mode = ttk.Button(self.frame, text="顺序", width=8, command=self.app.cycle_mode)
        self.btn_mode.pack(side=tk.LEFT, padx=2)

        self.btn_eq = ttk.Button(self.frame, text="均衡器", width=8, command=self.app.open_equalizer)
        self.btn_eq.pack(side=tk.LEFT, padx=2)
        self._mode_labels = {
            PlayMode.SEQUENTIAL: "顺序",
            PlayMode.LOOP: "列表循环",
            PlayMode.SINGLE: "单曲循环",
            PlayMode.RANDOM: "随机",
        }

    def set_playing(self, playing: bool) -> None:
        self.btn_play["text"] = "暂停" if playing else "播放"

    def set_mode(self, mode: PlayMode) -> None:
        self.btn_mode["text"] = self._mode_labels.get(mode, str(mode))

    def set_volume(self, v: int) -> None:
        self.volume.set(v)


__all__ = ["ControlsPanel"]
