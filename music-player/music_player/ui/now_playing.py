"""正在播放面板：封面 + 标题 + 进度条（可拖动 seek）。"""
from __future__ import annotations

from pathlib import Path
from tkinter import ttk
import tkinter as tk

from PIL import Image, ImageTk


def _fmt(ms: int) -> str:
    if ms is None or ms < 0:
        ms = 0
    s = ms // 1000
    return f"{s // 60}:{s % 60:02d}"


class NowPlayingPanel:
    def __init__(self, parent, app) -> None:
        self.app = app
        self.frame = ttk.LabelFrame(parent, text="正在播放", padding=8)

        self.cover = tk.Label(self.frame, text="(无封面)", width=30, height=15, bg="#222222", fg="#999999")
        self.cover.pack(pady=(0, 6))

        self.title = tk.Label(self.frame, text="—", font=("TkDefaultFont", 12, "bold"), wraplength=320)
        self.title.pack(fill=tk.X)
        self.sub = tk.Label(self.frame, text="", fg="#666666")
        self.sub.pack(fill=tk.X)

        self.scale = ttk.Scale(self.frame, from_=0, to=1000, orient=tk.HORIZONTAL, command=self._on_scale)
        self.scale.pack(fill=tk.X, pady=(6, 0))
        self.scale.bind("<ButtonPress-1>", lambda e: setattr(self, "_dragging", True))
        self.scale.bind("<ButtonRelease-1>", self._on_release)

        self.time = tk.Label(self.frame, text="0:00 / 0:00", fg="#666666")
        self.time.pack()

        self._dragging = False
        self._cover_img = None

    def _on_scale(self, _val) -> None:
        pass

    def _on_release(self, _e) -> None:
        self._dragging = False
        dur = self.app.engine.get_length()
        if dur > 0:
            frac = float(self.scale.get()) / 1000.0
            self.app.seek(int(frac * dur))

    def set_current(self, item) -> None:
        if item is None:
            self.title["text"] = "—"
            self.sub["text"] = ""
            self._load_cover(None)
            return
        self.title["text"] = item.display_title
        self.sub["text"] = item.path
        self._load_cover(item)

    def _load_cover(self, item) -> None:
        self._cover_img = None
        self.cover.configure(image="", text="(无封面)", bg="#222222", fg="#999999")
        if item and item.cover_path and Path(item.cover_path).exists():
            try:
                img = Image.open(item.cover_path).resize((240, 240))
                self._cover_img = ImageTk.PhotoImage(img)
                self.cover.configure(image=self._cover_img, text="")
            except Exception:
                pass

    def update_progress(self, pos: int, dur: int) -> None:
        if dur > 0:
            self.time["text"] = f"{_fmt(pos)} / {_fmt(dur)}"
            if not self._dragging:
                self.scale.set(pos / dur * 1000)


__all__ = ["NowPlayingPanel"]
