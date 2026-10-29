"""轻量后台线程：在 worker 线程跑耗时任务，可选把结果回投到回调。

注意：回调里若要操作 tkinter，调用方应自行用 `root.after(0, ...)` 切回主线程。
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Optional, Tuple


def run_worker(
    fn: Callable[..., Any],
    *args: Any,
    callback: Optional[Callable[[Any], None]] = None,
    daemon: bool = True,
    name: str = "mp-worker",
) -> threading.Thread:
    def target() -> None:
        try:
            result = fn(*args)
        except Exception as exc:  # 把异常也作为结果回投，便于上层感知
            result = exc
        if callback:
            callback(result)

    t = threading.Thread(target=target, daemon=daemon, name=name)
    t.start()
    return t


__all__ = ["run_worker"]
