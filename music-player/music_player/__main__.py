"""入口：`python -m music_player` 与 `python main.py` 共用。

VLC 的导入延迟到 main() 内部执行，使包在「未安装 VLC」时仍可 import（仅运行才报错）。
"""
import tkinter as tk
from tkinter import messagebox


def _fatal(msg: str) -> None:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror("无法启动音乐播放器", msg)
    root.destroy()


def main() -> None:
    try:
        from .ui.app_window import MusicPlayerApp
    except Exception as e:  # noqa: BLE001
        _fatal(str(e))
        return

    root = tk.Tk()
    try:
        MusicPlayerApp(root)
    except Exception as e:  # noqa: BLE001
        messagebox.showerror("启动失败", str(e))
        root.destroy()
        return
    root.mainloop()


if __name__ == "__main__":
    main()
