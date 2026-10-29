"""歌词面板：滚动高亮当前行（基于 LrcParser）。"""
from __future__ import annotations

from tkinter import ttk
import tkinter as tk


class LyricsPanel:
    def __init__(self, parent, app) -> None:
        self.app = app
        self.frame = ttk.LabelFrame(parent, text="歌词", padding=6)
        self.text = tk.Text(self.frame, height=18, width=28, wrap=tk.WORD,
                            state=tk.DISABLED, bg="#fafafa", fg="#333333",
                            font=("TkDefaultFont", 10))
        self.text.pack(fill=tk.BOTH, expand=True)
        self._lines: list = []
        self._last_idx = -1

    def set_lyrics(self, lines: list) -> None:
        self._lines = lines
        self._last_idx = -1
        self.text.configure(state=tk.NORMAL)
        self.text.delete(1.0, tk.END)
        for _, text in lines:
            self.text.insert(tk.END, (text or "…") + "\n")
        self.text.configure(state=tk.DISABLED)

    def update(self, position_ms: int) -> None:
        if not self._lines:
            return
        idx = self.app.lrc.line_at(position_ms)
        if idx == self._last_idx:
            return
        self._last_idx = idx
        self.text.configure(state=tk.NORMAL)
        self.text.tag_remove("cur", 1.0, tk.END)
        if idx >= 0:
            line_start = f"{idx + 1}.0"
            line_end = f"{idx + 1}.end"
            self.text.tag_add("cur", line_start, line_end)
            self.text.tag_config("cur", foreground="#1e88e5", font=("TkDefaultFont", 11, "bold"))
            self.text.see(line_start)
        self.text.configure(state=tk.DISABLED)


__all__ = ["LyricsPanel"]
