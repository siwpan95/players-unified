"""主窗口：装配 PlayerEngine + PlaylistModel + 各 UI 面板，串联播放流程。"""
from __future__ import annotations

import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from ..engine import PlayMode, PlaybackStatus, PlayerEngine
from ..engine.media_item import MediaItem
from ..library import PlaylistModel, RadioManager, import_encrypted, EncryptedImportError, scan_paths
from ..metadata import LrcParser, MetadataCache
from ..utils.dragdrop import DragDropHandler
from ..utils.paths import app_cache_dir
from ..utils.threads import run_worker
from ..viz import Visualizer
from .controls import ControlsPanel
from .equalizer_panel import EqualizerPanel
from .lyrics_panel import LyricsPanel
from .now_playing import NowPlayingPanel
from .playlist_panel import PlaylistPanel
from .radio_panel import RadioPanel
from .visualizer_panel import VisualizerPanel

_ENCRYPTED_EXTS = (
    ".ncm", ".qmc", ".qmc0", ".qmc3", ".qmcflac", ".mflac", ".mgg",
    ".kgm", ".kgma", ".kwm", ".xm", ".mg3d", ".tm", ".vpr",
)


class MusicPlayerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        root.title("音乐播放器 · Python + VLC")
        root.geometry("960x600")

        self.engine = PlayerEngine()
        self.playlist = PlaylistModel()
        self.metadata = MetadataCache(str(app_cache_dir()))
        self.radio = RadioManager()
        self.viz = Visualizer(mode="spectrum")
        self.lrc = None
        self._viz_ready = False
        self._current: MediaItem | None = None
        self.equalizer = EqualizerPanel(self)
        self._rpc = None

        self._build_menu()
        self._build_layout()
        self._wire_engine()
        self._wire_dragdrop()
        self._start_poll()
        root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ---------------- 布局 ----------------
    def _build_menu(self) -> None:
        menubar = tk.Menu(self.root)
        file_menu = tk.Menu(menubar, tearoff=0)
        file_menu.add_command(label="添加文件", command=self.add_files)
        file_menu.add_command(label="添加文件夹", command=self.add_folder)
        file_menu.add_command(label="导入加密音乐 (.ncm 等)", command=self.import_encrypted_flow)
        file_menu.add_separator()
        file_menu.add_command(label="退出", command=self._on_close)
        menubar.add_cascade(label="文件", menu=file_menu)

        tools_menu = tk.Menu(menubar, tearoff=0)
        tools_menu.add_command(label="均衡器…", command=self.open_equalizer)
        tools_menu.add_command(label="开启 RPC 控制", command=self.start_rpc)
        tools_menu.add_command(label="关闭 RPC 控制", command=self.stop_rpc)
        menubar.add_cascade(label="工具", menu=tools_menu)

        mode_menu = tk.Menu(menubar, tearoff=0)
        for mode in (PlayMode.SEQUENTIAL, PlayMode.LOOP, PlayMode.SINGLE, PlayMode.RANDOM):
            label = {PlayMode.SEQUENTIAL: "顺序", PlayMode.LOOP: "列表循环",
                     PlayMode.SINGLE: "单曲循环", PlayMode.RANDOM: "随机"}[mode]
            mode_menu.add_command(label=label, command=lambda m=mode: self.set_mode(m))
        menubar.add_cascade(label="播放模式", menu=mode_menu)

        self.root.config(menu=menubar)

    def _build_layout(self) -> None:
        main = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        main.pack(fill=tk.BOTH, expand=True, padx=6, pady=6)

        # 左：播放列表
        left = ttk.Frame(main)
        self.playlist_panel = PlaylistPanel(left, self)
        self.playlist_panel.frame.pack(fill=tk.BOTH, expand=True)
        main.add(left, weight=1)

        # 中：正在播放 + 可视化
        center = ttk.Frame(main)
        self.now_playing = NowPlayingPanel(center, self)
        self.now_playing.frame.pack(fill=tk.X)
        self.visualizer_panel = VisualizerPanel(center, self)
        self.visualizer_panel.frame.pack(fill=tk.BOTH, expand=True)
        main.add(center, weight=2)

        # 右：歌词 + 电台
        right = ttk.Frame(main)
        self.lyrics_panel = LyricsPanel(right, self)
        self.lyrics_panel.frame.pack(fill=tk.BOTH, expand=True, side=tk.TOP)
        self.radio_panel = RadioPanel(right, self)
        self.radio_panel.frame.pack(fill=tk.X, side=tk.BOTTOM)
        main.add(right, weight=1)

        # 底：控制
        self.controls = ControlsPanel(self.root, self)
        self.controls.frame.pack(fill=tk.X, padx=6, pady=(0, 6))
        self.controls.set_mode(self.playlist.get_mode())

    # ---------------- 引擎接线 ----------------
    def _wire_engine(self) -> None:
        self.engine.on_state_changed(lambda s: self.root.after(0, self._on_state, s))
        self.engine.on_position(lambda p, l: self.root.after(0, self._on_position, p, l))
        self.engine.on_end_reached(lambda: self.root.after(0, self._auto_next))
        self.engine.on_error(lambda m: self.root.after(0, self._on_error, m))
        # 初始音量
        self.engine.set_volume(80)

    def _wire_dragdrop(self) -> None:
        self._dropper = DragDropHandler(self.root, self._on_drop)
        self._dropper.enable()

    # ---------------- 播放控制 ----------------
    def play_index(self, index: int) -> None:
        item = self.playlist.jump(index)
        if item:
            self._after_load(item)

    def play_media_item(self, item: MediaItem) -> None:
        idx = None
        for i, it in enumerate(self.playlist.items()):
            if it is item or it.path == item.path:
                idx = i
                break
        if idx is None:
            self.playlist.add_item(item)
            idx = len(self.playlist) - 1
        self.play_index(idx)

    def _after_load(self, item: MediaItem) -> None:
        self._current = item
        if not item.is_radio and not item.metadata:
            item.metadata = self.metadata.get(item)
            self.metadata.fetch_cover(item)
        self.engine.load(item)
        self.engine.play()
        self.now_playing.set_current(item)
        self.playlist_panel.refresh()
        self.controls.set_playing(True)
        self._load_lyrics(item)
        self._viz_ready = False
        if not item.is_radio:
            run_worker(self.viz.precompute, item.path,
                       callback=lambda ok: self.root.after(0, setattr, self, "_viz_ready", bool(ok)))

    def toggle_play(self) -> None:
        if self._current is None:
            item = self.playlist.current() or self.playlist.next()
            if item:
                self._after_load(item)
            return
        self.engine.toggle_pause()

    def stop(self) -> None:
        self.engine.stop()
        self.controls.set_playing(False)

    def next(self) -> None:
        item = self.playlist.next()
        if item:
            self._after_load(item)
        else:
            self.stop()

    def prev(self) -> None:
        item = self.playlist.prev()
        if item:
            self._after_load(item)
        else:
            self.stop()

    def seek(self, ms: int) -> None:
        self.engine.seek(ms)

    def set_volume(self, v: int) -> None:
        self.engine.set_volume(v)

    def set_mode(self, mode: PlayMode) -> None:
        self.playlist.set_mode(mode)
        self.engine.set_play_mode(mode)
        self.controls.set_mode(mode)

    def cycle_mode(self) -> None:
        order = [PlayMode.SEQUENTIAL, PlayMode.LOOP, PlayMode.SINGLE, PlayMode.RANDOM]
        cur = self.playlist.get_mode()
        nxt = order[(order.index(cur) + 1) % len(order)]
        self.set_mode(nxt)

    # ---------------- 均衡器 ----------------
    def open_equalizer(self) -> None:
        self.equalizer.open()

    # ---------------- 导入 ----------------
    def add_files(self) -> None:
        paths = filedialog.askopenfilenames(
            filetypes=[("音频", "*.mp3 *.flac *.ogg *.wav *.m4a *.aac *.opus *.ape *.wma"), ("全部", "*.*")]
        )
        if paths:
            self.playlist.add(scan_paths(paths))
            self.playlist_panel.refresh()

    def add_folder(self) -> None:
        folder = filedialog.askdirectory()
        if folder:
            self.playlist.add(scan_paths([folder]))
            self.playlist_panel.refresh()

    def import_encrypted_flow(self) -> None:
        ok = messagebox.askyesno(
            "合规确认",
            "加密音乐导入仅可用于解密【你本人已购买或合法拥有】的文件。\n"
            "是否继续？（仅解密本人所有的内容）",
        )
        if not ok:
            return
        paths = filedialog.askopenfilenames(
            title="选择加密音乐文件",
            filetypes=[("加密音乐", " ".join("*" + e for e in _ENCRYPTED_EXTS)), ("全部", "*.*")],
        )
        if not paths:
            return

        def work():
            added = 0
            errs = []
            for p in paths:
                try:
                    item = import_encrypted(p)
                    self.playlist.add_item(item)
                    added += 1
                except EncryptedImportError as e:
                    errs.append(f"{Path(p).name}: {e}")
                except Exception as e:  # noqa: BLE001
                    errs.append(f"{Path(p).name}: {e}")
            self.root.after(0, lambda: self._on_import_done(added, errs))

        run_worker(work)

    def _on_import_done(self, added: int, errs: list) -> None:
        self.playlist_panel.refresh()
        if errs:
            messagebox.showwarning("导入完成（含错误）",
                                   f"成功 {added} 个。\n" + "\n".join(errs[:10]))
        else:
            messagebox.showinfo("导入完成", f"成功导入 {added} 个加密文件。")

    # ---------------- 回调 ----------------
    def _on_state(self, state) -> None:
        self.controls.set_playing(state.status == PlaybackStatus.PLAYING)

    def _on_position(self, pos: int, length: int) -> None:
        self.now_playing.update_progress(pos, length)

    def _auto_next(self) -> None:
        item = self.playlist.next()
        if item:
            self._after_load(item)
        else:
            self.stop()

    def _on_error(self, msg: str) -> None:
        self.status(msg) if hasattr(self, "status") else None
        messagebox.showerror("播放错误", msg)

    def _load_lyrics(self, item: MediaItem) -> None:
        if item.is_radio:
            self.lrc = None
            self.lyrics_panel.set_lyrics([])
            return
        lrc_path = Path(item.path).with_suffix(".lrc")
        if lrc_path.exists():
            self.lrc = LrcParser(path=str(lrc_path))
            self.lyrics_panel.set_lyrics(self.lrc.lines)
        else:
            self.lrc = None
            self.lyrics_panel.set_lyrics([])

    # ---------------- 无头 RPC 控制 ----------------
    def start_rpc(self, port: int = 7700) -> None:
        from ..engine.rpc_bridge import RpcServer

        if self._rpc is not None:
            return
        self._rpc = RpcServer(self._rpc_dispatch, port=port)
        self._rpc.start()

    def stop_rpc(self) -> None:
        if self._rpc is not None:
            self._rpc.stop()
            self._rpc = None

    def _rpc_dispatch(self, method: str, params: dict) -> object:
        """在 UI 主线程执行命令并返回结果（供 RpcServer 线程回调）。

        通过 root.after(0, ...) 把执行切回主线程，并用 Future 取回结果。
        """
        import concurrent.futures

        fut: concurrent.futures.Future = concurrent.futures.Future()

        def execute() -> None:
            try:
                fut.set_result(self._rpc_execute(method, params))
            except Exception as e:  # noqa: BLE001
                fut.set_exception(e)

        self.root.after(0, execute)
        return fut.result(timeout=5)

    def _rpc_execute(self, method: str, params: dict) -> object:
        if method == "play":
            if self._current is None:
                item = self.playlist.current() or self.playlist.next()
                if item:
                    self._after_load(item)
            else:
                self.engine.toggle_pause()
            return self.engine.get_state().snapshot().__dict__
        if method == "pause":
            self.engine.pause()
            return {"status": "paused"}
        if method == "resume":
            self.engine.play()
            return {"status": "playing"}
        if method == "stop":
            self.stop()
            return {"status": "stopped"}
        if method == "next":
            self.next()
            return self._rpc_current()
        if method == "prev":
            self.prev()
            return self._rpc_current()
        if method == "play_index":
            idx = int(params.get("index", -1))
            if 0 <= idx < len(self.playlist):
                self.play_index(idx)
            return self._rpc_current()
        if method == "seek":
            if "position_ms" in params:
                self.seek(int(params["position_ms"]))
            elif "fraction" in params:
                length = self.engine.get_length() or 0
                self.seek(int(float(params["fraction"]) * length))
            return {"position_ms": self.engine.get_time(),
                    "duration_ms": self.engine.get_length()}
        if method == "volume":
            v = max(0, min(100, int(params.get("value", 80))))
            self.set_volume(v)
            return {"volume": v}
        if method == "mute":
            self.engine.set_mute(bool(params.get("value", True)))
            return {"mute": self.engine.get_state().mute}
        if method == "set_mode":
            from ..engine.player_state import PlayMode
            self.set_mode(PlayMode(params.get("mode", "sequential")))
            return {"mode": self.playlist.get_mode().value}
        if method == "equalizer":
            self.engine.set_equalizer(
                preset=params.get("preset"),
                bands=params.get("bands"),
            )
            return {"equalizer_on": self.engine.get_state().equalizer_on}
        if method == "add_files":
            paths = params.get("paths") or []
            items = scan_paths([str(p) for p in paths])
            self.playlist.add(items)
            self.playlist_panel.refresh()
            return {"added": len(items)}
        if method == "status":
            return self.engine.get_state().snapshot().__dict__
        if method == "playlist":
            return [{"index": i, "title": it.display_title, "radio": it.is_radio}
                    for i, it in enumerate(self.playlist.items())]
        if method == "ping":
            return {"pong": True}
        raise ValueError(f"未知方法: {method}")

    def _rpc_current(self) -> dict:
        st = self.engine.get_state()
        return {"index": st.current_index, "uri": st.current_uri,
                "status": st.status.value}

    # ---------------- 拖放 ----------------
    def _on_drop(self, paths: list) -> None:
        items = scan_paths([str(p) for p in paths])
        if items:
            self.playlist.add(items)
            self.playlist_panel.refresh()

    # ---------------- 轮询刷新 ----------------
    def _start_poll(self) -> None:
        self._poll()

    def _poll(self) -> None:
        try:
            pos = self.engine.get_time()
            length = self.engine.get_length()
            self.now_playing.update_progress(pos, length)
            if self.lrc is not None:
                self.lyrics_panel.update(pos)
            if self._viz_ready:
                self.visualizer_panel.render(pos)
        except Exception:
            pass
        self.root.after(250, self._poll)

    def _on_close(self) -> None:
        try:
            self.stop_rpc()
        except Exception:
            pass
        try:
            self.equalizer.close()
        except Exception:
            pass
        try:
            self._dropper.disable()
        except Exception:
            pass
        try:
            self.engine.release()
        except Exception:
            pass
        self.root.destroy()


__all__ = ["MusicPlayerApp"]
