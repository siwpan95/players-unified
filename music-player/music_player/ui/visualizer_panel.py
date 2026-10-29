"""可视化面板：承载 Visualizer 的 tk Canvas。"""
from __future__ import annotations

from tkinter import ttk
import tkinter as tk


class VisualizerPanel:
    def __init__(self, parent, app) -> None:
        self.app = app
        self.frame = ttk.LabelFrame(parent, text="可视化", padding=6)
        self.canvas = tk.Canvas(self.frame, width=360, height=120, bg="#111111")
        self.canvas.pack(fill=tk.BOTH, expand=True)

    def render(self, position_ms: int) -> None:
        self.app.viz.render(self.canvas, position_ms, width=360, height=120)


__all__ = ["VisualizerPanel"]
