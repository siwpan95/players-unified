"""播放列表面板：列表 + 添加文件/文件夹 + 双击播放。"""
from __future__ import annotations

from tkinter import filedialog, ttk
import tkinter as tk

from ..engine.media_item import MediaItem


class PlaylistPanel:
    def __init__(self, parent, app) -> None:
        self.app = app
        self.frame = ttk.LabelFrame(parent, text="播放列表", padding=6)

        self.listbox = tk.Listbox(self.frame, height=18, selectmode=tk.EXTENDED)
        self.listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.listbox.bind("<Double-Button-1>", self._on_double)

        scroll = ttk.Scrollbar(self.frame, orient=tk.VERTICAL, command=self.listbox.yview)
        scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.listbox.config(yscrollcommand=scroll.set)

        btn = ttk.Frame(self.frame)
        btn.pack(side=tk.BOTTOM, fill=tk.X, pady=(4, 0))
        ttk.Button(btn, text="添加文件", command=self.app.add_files).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn, text="添加文件夹", command=self.app.add_folder).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn, text="移除选中", command=self._remove_selected).pack(side=tk.LEFT, padx=2)

    def _on_double(self, _e) -> None:
        sel = self.listbox.curselection()
        if sel:
            self.app.play_index(sel[0])

    def _remove_selected(self) -> None:
        sel = list(self.listbox.curselection())
        for i in reversed(sel):
            self.app.playlist.remove(i)
        self.refresh()

    def refresh(self) -> None:
        self.listbox.delete(0, tk.END)
        for it in self.app.playlist.items():
            self.listbox.insert(tk.END, self._label(it))
        cur = self.app.playlist.index()
        if 0 <= cur < self.listbox.size():
            self.listbox.selection_set(cur)
            self.listbox.see(cur)

    @staticmethod
    def _label(item: MediaItem) -> str:
        md = item.metadata or {}
        title = md.get("title") or item.name
        artist = md.get("artist")
        if artist:
            return f"{artist} - {title}"
        return title


__all__ = ["PlaylistPanel"]
