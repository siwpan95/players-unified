"""电台面板：添加 HLS/HTTP 流地址，双击播放。"""
from __future__ import annotations

from tkinter import filedialog, ttk
import tkinter as tk

from ..engine.media_item import MediaItem


class RadioPanel:
    def __init__(self, parent, app) -> None:
        self.app = app
        self.frame = ttk.LabelFrame(parent, text="网络电台 / HLS", padding=6)

        add = ttk.Frame(self.frame)
        add.pack(fill=tk.X, pady=(0, 4))
        self.name_var = tk.StringVar()
        self.url_var = tk.StringVar()
        ttk.Label(add, text="名称").pack(side=tk.LEFT)
        ttk.Entry(add, textvariable=self.name_var, width=10).pack(side=tk.LEFT, padx=2)
        ttk.Label(add, text="URL").pack(side=tk.LEFT)
        ttk.Entry(add, textvariable=self.url_var, width=24).pack(side=tk.LEFT, padx=2, fill=tk.X, expand=True)
        ttk.Button(add, text="添加", command=self._add).pack(side=tk.LEFT, padx=2)

        self.listbox = tk.Listbox(self.frame, height=8)
        self.listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.listbox.bind("<Double-Button-1>", self._on_double)

        scroll = ttk.Scrollbar(self.frame, orient=tk.VERTICAL, command=self.listbox.yview)
        scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.listbox.config(yscrollcommand=scroll.set)

        ttk.Button(self.frame, text="导入.m3u", command=self._import_m3u).pack(
            side=tk.BOTTOM, fill=tk.X, pady=(4, 0)
        )

    def _add(self) -> None:
        name = self.name_var.get().strip() or self.url_var.get().strip()
        url = self.url_var.get().strip()
        if not url:
            return
        item = self.app.radio.add_station(name, url,
                                          "hls" if url.lower().endswith(".m3u8") else "http")
        self.app.playlist.add_item(item)
        self._refresh()
        self.name_var.set("")
        self.url_var.set("")

    def _import_m3u(self) -> None:
        path = filedialog.askopenfilename(filetypes=[("播放列表", "*.m3u *.m3u8")])
        if path:
            self.app.radio.from_m3u(path)
            for it in self.app.radio.list():
                self.app.playlist.add_item(it)
            self._refresh()

    def _on_double(self, _e) -> None:
        sel = self.listbox.curselection()
        if sel:
            item = self.app.radio.list()[sel[0]]
            self.app.play_media_item(item)

    def _refresh(self) -> None:
        self.listbox.delete(0, tk.END)
        for it in self.app.radio.list():
            self.listbox.insert(tk.END, it.display_title)


__all__ = ["RadioPanel"]
