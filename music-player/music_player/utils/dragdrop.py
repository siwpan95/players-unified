"""Windows 文件拖放（ctypes WM_DROPFILES，零第三方依赖，PyInstaller 干净）。

仅转发未处理的消息给原窗口过程，避免破坏 tkinter 事件循环。挂到 tk 根窗口上最稳。
调用方需在销毁前调用 disable() 还原原子类化。
"""
from __future__ import annotations

import ctypes
import sys
from pathlib import Path
from typing import Callable, List, Optional

WM_DROPFILES = 0x0233
GWL_WNDPROC = -4


class DragDropHandler:
    def __init__(self, tk_widget, on_drop: Callable[[List[Path]], None]) -> None:
        self.widget = tk_widget
        self.on_drop = on_drop
        self._hwnd = tk_widget.winfo_id()
        self._old_wndproc = None
        self._wndproc = None
        self._user32 = ctypes.windll.user32
        self._shell32 = ctypes.windll.shell32

    def enable(self) -> None:
        if not sys.platform.startswith("win"):
            return
        u, s = self._user32, self._shell32

        SetWindowLongPtrW = u.SetWindowLongPtrW
        SetWindowLongPtrW.restype = ctypes.c_void_p
        SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        CallWindowProcW = u.CallWindowProcW
        CallWindowProcW.restype = ctypes.c_long
        CallWindowProcW.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_long
        ]
        DragQueryFileW = s.DragQueryFileW
        DragQueryFileW.restype = ctypes.c_uint
        DragQueryFileW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_uint]

        WNDPROC = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_long, ctypes.c_uint, ctypes.c_uint, ctypes.c_long
        )
        handler = self

        def wndproc(hwnd, msg, wparam, lparam):
            try:
                if msg == WM_DROPFILES:
                    handler._on_drop(wparam)
                    return 0
            except OSError:
                return 0
            return CallWindowProcW(handler._old_wndproc, hwnd, msg, wparam, lparam)

        self._wndproc = WNDPROC(wndproc)
        s.DragAcceptFiles(self._hwnd, True)
        self._old_wndproc = SetWindowLongPtrW(self._hwnd, GWL_WNDPROC, self._wndproc)

    def disable(self) -> None:
        if self._old_wndproc is None:
            return
        try:
            self._user32.SetWindowLongPtrW(self._hwnd, GWL_WNDPROC, self._old_wndproc)
        except Exception:
            pass
        self._old_wndproc = None

    def _on_drop(self, hdrop) -> None:
        s = self._shell32
        count = s.DragQueryFileW(hdrop, 0xFFFFFFFF, None, 0)
        paths: List[Path] = []
        for i in range(count):
            length = s.DragQueryFileW(hdrop, i, None, 0)
            buf = ctypes.create_unicode_buffer(length + 1)
            s.DragQueryFileW(hdrop, i, buf, length + 1)
            paths.append(Path(buf.value))
        s.DragFinish(hdrop)
        if paths:
            self.on_drop(paths)


__all__ = ["DragDropHandler"]
