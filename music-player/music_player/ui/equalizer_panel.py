"""均衡器面板：独立 Toplevel 窗口，预设下拉 + 10 段增益滑块。

只在用户点「均衡器」时打开，不占用主窗口布局。所有修改实时应用到播放内核。
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from ..engine.equalizer import (
    BAND_FREQUENCIES_HZ, DEFAULT_PRESET, NUM_BANDS, PRESET_NAMES,
    get_preset_bands,
)


class EqualizerPanel:
    def __init__(self, app) -> None:
        self.app = app
        self.window: tk.Toplevel | None = None
        self._scales: list[ttk.Scale] = []
        self._val_labels: list[ttk.Label] = []
        self._preset_var = tk.StringVar(value=DEFAULT_PRESET)
        self._on = tk.BooleanVar(value=self.app.engine.get_state().equalizer_on)

    def open(self) -> None:
        if self.window is not None and self.window.winfo_exists():
            self.window.lift()
            return
        w = tk.Toplevel(self.app.root)
        w.title("均衡器")
        w.geometry("460x340")
        w.resizable(False, False)
        w.protocol("WM_DELETE_WINDOW", self.close)
        self.window = w

        top = ttk.Frame(w, padding=8)
        top.pack(fill=tk.X)
        ttk.Label(top, text="预设").pack(side=tk.LEFT)
        preset_cb = ttk.Combobox(
            top, textvariable=self._preset_var, values=PRESET_NAMES,
            state="readonly", width=12,
        )
        preset_cb.pack(side=tk.LEFT, padx=6)
        preset_cb.bind("<<ComboboxSelected>>", lambda e: self._apply_preset())
        ttk.Checkbutton(top, text="启用", variable=self._on,
                        command=self._toggle_on).pack(side=tk.LEFT, padx=8)

        grid = ttk.Frame(w, padding=(8, 4))
        grid.pack(fill=tk.BOTH, expand=True)
        for i in range(NUM_BANDS):
            col = ttk.Frame(grid, padding=2)
            col.grid(row=0, column=i, sticky="nsew")
            ttk.Label(col, text=f"{BAND_FREQUENCIES_HZ[i]}", font=("TkDefaultFont", 7)).pack()
            ttk.Label(col, text="Hz", font=("TkDefaultFont", 7)).pack()
            sc = ttk.Scale(
                col, from_=20, to=-20, orient=tk.VERTICAL, length=200,
                command=lambda v, idx=i: self._on_band(idx, float(v)),
            )
            sc.set(0.0)
            sc.pack(fill=tk.Y, expand=True)
            self._scales.append(sc)
            val = ttk.Label(col, text="0", font=("TkDefaultFont", 7))
            val.pack()
            self._val_labels.append(val)

        # 初始化为当前状态
        if self.app.engine.get_state().equalizer_on:
            self._apply_preset(silent=True)
        w.update_idletasks()

    def _toggle_on(self) -> None:
        if self._on.get():
            self._apply_preset(silent=True)
        else:
            self.app.engine.set_equalizer(None, None)

    def _apply_preset(self, silent: bool = False) -> None:
        name = self._preset_var.get()
        bands = get_preset_bands(name)
        for sc, g, lab in zip(self._scales, bands, self._val_labels):
            sc.set(g)
            lab["text"] = f"{g:+.0f}"
        if self._on.get() or silent:
            self.app.engine.set_equalizer(preset=name, bands=None)

    def _on_band(self, idx: int, gain: float) -> None:
        self._on.set(True)
        self._val_labels[idx]["text"] = f"{gain:+.0f}"
        # 自定义：把当前 10 段滑块值作为 bands 下发
        bands = [float(sc.get()) for sc in self._scales]
        self.app.engine.set_equalizer(preset=None, bands=bands)

    def close(self) -> None:
        if self.window is not None:
            self.window.destroy()
            self.window = None

    def is_open(self) -> bool:
        return self.window is not None and self.window.winfo_exists()


__all__ = ["EqualizerPanel"]
