"""无头 A/B 对拍参照实现（A 侧）。

用 PlayerEngine + PlaylistModel 复刻 ui/app_window.py 的 `_rpc_execute` 命令面，
不依赖 tkinter。经 RpcServer（engine/rpc_bridge.py）暴露 TCP JSON-RPC 2.0。

关键：所有 VLC 操作必须串行在一个专用「引擎线程」执行（原实现用 tkinter 的
root.after 切回主线程规避跨线程动 VLC；无头版用 queue.Queue + 引擎线程等价实现）。

用法：python tools/ab_harness.py [port]

对照修正（相对参照实现 app_window.py，详见 A/B 报告）：
  1. `current_index`：原实现读 PlayerState.current_index（从未被赋值，恒 -1），
     本 harness 改为读 PlaylistModel.index()（真实当前索引）。
"""
from __future__ import annotations

import concurrent.futures
import os
import queue
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from music_player.engine import (  # noqa: E402
    MediaItem, MediaType, PlayMode, PlayerEngine, RpcServer,
)
from music_player.library import PlaylistModel  # noqa: E402


def _make_item(path: str) -> MediaItem:
    stem = os.path.splitext(os.path.basename(path))[0]
    return MediaItem(name=stem, path=os.path.abspath(path), item_type=MediaType.LOCAL_FILE)


class HeadlessPlayer:
    def __init__(self) -> None:
        self._q: queue.Queue = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True, name="engine-thread")
        self._thread.start()

    # ---- 引擎线程（串行执行所有 VLC 操作）----
    def _run(self) -> None:
        self.engine = PlayerEngine()
        self.playlist = PlaylistModel()
        self._current: MediaItem | None = None
        self.engine.set_volume(80)
        self.engine.on_end_reached(self._on_end_reached)
        while True:
            method, params, fut = self._q.get()
            try:
                fut.set_result(self._dispatch(method, params))
            except Exception as e:  # noqa: BLE001
                fut.set_exception(e)

    def _on_end_reached(self) -> None:
        # VLC 回调线程 → 投递回引擎线程
        self._q.put(("__auto_next__", {}, None))

    # ---- 对外：把命令投递到引擎线程并同步等结果 ----
    def execute(self, method: str, params: dict) -> object:
        fut: concurrent.futures.Future = concurrent.futures.Future()
        self._q.put((method, params, fut))
        return fut.result(timeout=15)

    # ---- 命令面（对齐 app_window._rpc_execute，在引擎线程执行）----
    def _after_load(self, item: MediaItem) -> None:
        self._current = item
        self.engine.load(item)
        self.engine.play()

    def _auto_next(self) -> None:
        item = self.playlist.next()
        if item:
            self._after_load(item)
        else:
            self.engine.stop()

    def _status(self) -> dict:
        d = self.engine.get_state().snapshot().__dict__
        # 修正 1：current_index 由 PlaylistModel 维护（参照实现原本恒 -1）
        d["current_index"] = self.playlist.index()
        # 修正 2：枚举转字符串，否则 json.dumps 会抛 TypeError（参照实现同样有此隐患）
        d["status"] = d["status"].value
        d["play_mode"] = d["play_mode"].value
        return d

    def _current_info(self) -> dict:
        st = self.engine.get_state()
        return {"index": self.playlist.index(), "uri": st.current_uri, "status": st.status.value}

    def _dispatch(self, method: str, params: dict) -> object:
        if method == "__auto_next__":
            self._auto_next()
            return {"auto": True}

        if method == "play":
            if self._current is None:
                item = self.playlist.current() or self.playlist.next()
                if item:
                    self._after_load(item)
            else:
                self.engine.toggle_pause()
            return self._status()

        if method == "pause":
            self.engine.pause()
            return {"status": "paused"}

        if method == "resume":
            self.engine.play()
            return {"status": "playing"}

        if method == "stop":
            self.engine.stop()
            return {"status": "stopped"}

        if method == "next":
            item = self.playlist.next()
            if item:
                self._after_load(item)
            else:
                self.engine.stop()
            return self._current_info()

        if method == "prev":
            item = self.playlist.prev()
            if item:
                self._after_load(item)
            else:
                self.engine.stop()
            return self._current_info()

        if method == "play_index":
            idx = int(params.get("index", -1))
            if 0 <= idx < len(self.playlist):
                self._after_load(self.playlist.jump(idx))
            return self._current_info()

        if method == "seek":
            if "position_ms" in params:
                self.engine.seek(int(params["position_ms"]))
            elif "fraction" in params:
                length = self.engine.get_length() or 0
                self.engine.seek(int(float(params["fraction"]) * length))
            return {"position_ms": self.engine.get_time(),
                    "duration_ms": self.engine.get_length()}

        if method == "volume":
            v = max(0, min(100, int(params.get("value", 80))))
            self.engine.set_volume(v)
            return {"volume": v}

        if method == "mute":
            self.engine.set_mute(bool(params.get("value", True)))
            return {"mute": self.engine.get_state().mute}

        if method == "set_mode":
            mode = PlayMode(params.get("mode", "sequential"))
            self.playlist.set_mode(mode)
            self.engine.set_play_mode(mode)
            return {"mode": self.playlist.get_mode().value}

        if method == "equalizer":
            self.engine.set_equalizer(
                preset=params.get("preset"),
                bands=params.get("bands"),
            )
            return {"equalizer_on": self.engine.get_state().equalizer_on}

        if method == "add_files":
            paths = params.get("paths") or []
            items = [_make_item(str(p)) for p in paths]
            self.playlist.add(items)
            return {"added": len(items)}

        if method == "status":
            return self._status()

        if method == "playlist":
            return [{"index": i, "title": it.display_title, "radio": it.is_radio}
                    for i, it in enumerate(self.playlist.items())]

        if method == "ping":
            return {"pong": True}

        raise ValueError(f"未知方法: {method}")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7800
    player = HeadlessPlayer()
    server = RpcServer(player.execute, port=port)
    server.start()
    print(f"READY {port}", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    main()
