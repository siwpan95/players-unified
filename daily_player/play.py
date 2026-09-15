"""daily_player —— 日常视频播放器（tkinter UI）。

内核可换（Phase 4）：默认 **PluginPlayer**，找不到就回落 **libVLC**。
UI 只依赖 `PlayerEngine` 端口 + 能力声明，不直接碰任何内核专有 API —— 见 `kernel.py`。

用法:
    python play.py                       # 默认内核（PluginPlayer，回落 VLC）
    python play.py <媒体文件>             # 直接载入播放（统一启动器深链用）
    python play.py --kernel=vlc          # 强制 libVLC
    python play.py --kernel=auto         # 有 PluginPlayer 就用，没有才回落
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import threading, time, os, re, json, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 内核：默认 PluginPlayer（Phase 4）。找不到时回落到 libVLC，见 kernel.py。
# 注意：**这里不再 import vlc** —— VLC 变成可选依赖，装了才用得上。
from kernel import create_kernel, KERNEL_PP  # noqa: E402

# 系统托盘支持（可选）
try:
    import pystray
    from PIL import Image, ImageDraw
    HAS_TRAY = True
except ImportError:
    HAS_TRAY = False

def parse_srt(path):
    with open(path, encoding="utf-8", errors="ignore") as f:
        content = f.read()
    subs = []
    for b in re.split(r'\n\s*\n', content.strip()):
        lines = b.strip().splitlines()
        if len(lines) >= 3:
            times = re.findall(r'\d{2}:\d{2}:\d{2},\d{3}', lines[1])
            if len(times) == 2:
                def to_sec(t):
                    parts = t.replace(',', '.').split(':')[::-1]
                    return sum(float(x) * y for x, y in zip(parts, [1, 60, 3600]))
                subs.append((to_sec(times[0]), to_sec(times[1]), lines[2]))
    return subs


class DailyPlayer:
    def __init__(self, root, kernel_request=None):
        self.root = root
        self.root.title("日常视频播放器")
        self.cfg_file = os.path.join(os.path.expanduser("~"), ".daily_player_cfg.json")
        self.load_config()
        self.root.geometry(self.cfg.get("geometry", "1100x680"))

        self.is_fullscreen = False
        self.tray_icon = None
        self.has_media = False

        # 主题系统
        self.themes = {
            "dark": {"bg": "#121212", "fg": "white", "btn_bg": "#2a2a2a", "accent": "#3a5a3a"},
            "light": {"bg": "#f0f0f0", "fg": "black", "btn_bg": "#e0e0e0", "accent": "#4CAF50"},
        }
        self.current_theme = self.cfg.get("theme", "dark")

        self.playlist, self.index, self.subs = [], 0, []
        self.video_exts = ('.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v')
        self.current_sub_id = -1  # -1 = 外部字幕, 其他 = 内核内嵌字幕轨

        # 画面容器必须先建起来：VLC 内核需要它的 hwnd 才能嵌入
        # （PluginPlayer 内核用不上，但保持同一套布局代码）。
        self.video = tk.Frame(self.root, bg="black", cursor="hand2")
        self.video.pack(fill=tk.BOTH, expand=True)
        self.root.update()

        self.kernel = self.init_kernel(kernel_request)
        if self.kernel is None:
            raise SystemExit("没有可用的播放内核")

        self.build_ui()
        self.bind_shortcuts()
        threading.Thread(target=self.updater, daemon=True).start()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def init_kernel(self, requested=None):
        """创建播放内核。默认 PluginPlayer；失败时提示并可回落到 VLC（见 kernel.py）。"""
        req = requested or self.cfg.get("kernel")
        k, why = create_kernel(req, cfg=self.cfg)
        if k is None:
            messagebox.showerror(
                "无法启动播放器",
                why + "\n\n· 用 PluginPlayer：把 pluginplayer.exe 放到 daily_player/pluginplayer/，"
                      "或设环境变量 DAILY_PLAYER_PP_EXE 指向它。\n"
                      "· 用 VLC：pip install python-vlc 并装好 VLC，然后加 --kernel=vlc。")
            self.root.destroy()
            return None
        self.cfg["kernel"] = k.name
        self.kernel_note = why
        print(f"[kernel] {k.name} — {why}")
        return k

    def load_config(self):
        try:
            with open(self.cfg_file, 'r') as f:
                self.cfg = json.load(f)
        except:
            self.cfg = {"volume": 80, "last_pos": 0, "last_file": "", "geometry": "1100x680"}

    def save_config(self):
        self.cfg["volume"] = self.volume.get()
        self.cfg["geometry"] = self.root.geometry()
        try:
            with open(self.cfg_file, 'w') as f:
                json.dump(self.cfg, f)
        except:
            pass

    def on_close(self):
        self.save_config()
        if self.tray_icon:
            try:
                self.tray_icon.stop()
            except:
                pass
        try:
            self.kernel.shutdown()      # PluginPlayer 内核：收掉子进程，别留孤儿
        except Exception:
            pass
        self.root.destroy()

    def get_color(self, key):
        return self.themes[self.current_theme][key]

    def apply_theme(self):
        c = self.get_color
        self.root.configure(bg=c("bg"))
        for child in self.root.winfo_children():
            try:
                child.configure(bg=c("bg"))
            except:
                pass

    def toggle_theme(self):
        self.current_theme = "light" if self.current_theme == "dark" else "dark"
        self.cfg["theme"] = self.current_theme
        self.save_config()
        self.apply_theme()

    def minimize_to_tray(self):
        if not HAS_TRAY:
            messagebox.showinfo("提示", "需要安装 pystray 和 Pillow：\npip install pystray Pillow")
            return
        self.root.withdraw()
        icon_img = Image.new('RGB', (64, 64), color='#1e1e1e')
        draw = ImageDraw.Draw(icon_img)
        draw.ellipse((12, 12, 52, 52), fill='#4a9eff')
        draw.polygon([(26, 22), (26, 42), (42, 32)], fill='white')
        menu = pystray.Menu(
            pystray.MenuItem("显示窗口", lambda: self.root.after(0, self.root.deiconify)),
            pystray.MenuItem("退出", lambda: self.root.after(0, self.on_close)),
        )
        self.tray_icon = pystray.Icon("daily_player", icon_img, "日常视频播放器", menu)
        threading.Thread(target=self.tray_icon.run, daemon=True).start()

    def build_ui(self):
        self.video.bind("<Double-Button-1>", self.toggle_fullscreen)
        self.video.bind("<MouseWheel>", self.on_wheel)

        # PluginPlayer 内核无法把画面嵌进 tk 窗口（见 kernel.py 能力表）：
        # 画面在播放器自己的窗口里，这里只保留字幕层并给出提示，不装作有画面。
        if not self.kernel.caps.get('embed'):
            tk.Label(self.video, fg="#888", bg="black",
                     font=("Microsoft YaHei", 12), justify="center",
                     text="画面在 PluginPlayer 窗口\n（本内核不支持把画面嵌入此窗口）"
                     ).place(relx=0.5, rely=0.45, anchor="center")

        self.sub_label = tk.Label(self.video, fg="white", bg="black", font=("Microsoft YaHei", 18), wraplength=900)
        self.sub_label.place(relx=0.5, rely=0.92, anchor="center")

        # 进度条和时间
        progress_frame = tk.Frame(self.root, bg="#121212")
        progress_frame.pack(fill=tk.X, padx=10)
        
        self.time_label = tk.Label(progress_frame, text="00:00:00 / 00:00:00", fg="white", bg="#121212", font=("Consolas", 10))
        self.time_label.pack(side=tk.LEFT)
        
        self.progress = ttk.Scale(progress_frame, from_=0, to=1000)
        self.progress.pack(fill=tk.X, padx=10, expand=True)
        self.progress.bind("<ButtonRelease-1>", self.seek_video)
        self.progress.bind("<B1-Motion>", self.seek_video)
        self.progress.bind("<MouseWheel>", self.on_progress_wheel)

        self.status_label = tk.Label(self.root, text="", fg="yellow", bg="#121212", font=("Microsoft YaHei", 10))
        self.status_label.pack()

        # 控制栏
        ctrl = tk.Frame(self.root, bg="#1e1e1e")
        ctrl.pack(fill=tk.X, pady=5)

        tk.Button(ctrl, text="⏮", command=self.prev, bg="#2a2a2a", fg="white", width=4).pack(side=tk.LEFT, padx=2)
        tk.Button(ctrl, text="⏪", command=self.rewind, bg="#2a2a2a", fg="white", width=4).pack(side=tk.LEFT, padx=2)
        self.play_btn = tk.Button(ctrl, text="▶", command=self.play_pause, bg="#2a2a2a", fg="white", width=4)
        self.play_btn.pack(side=tk.LEFT, padx=2)
        tk.Button(ctrl, text="⏩", command=self.forward, bg="#2a2a2a", fg="white", width=4).pack(side=tk.LEFT, padx=2)
        tk.Button(ctrl, text="⏭", command=self.next, bg="#2a2a2a", fg="white", width=4).pack(side=tk.LEFT, padx=2)

        tk.Label(ctrl, text="🔊", fg="white", bg="#1e1e1e").pack(side=tk.LEFT, padx=5)
        self.volume = ttk.Scale(ctrl, from_=0, to=100, command=self.on_volume)
        self.volume.set(self.cfg.get("volume", 80))
        self.volume.pack(side=tk.LEFT)

        self.speed = ttk.Combobox(ctrl, values=["0.25", "0.5", "0.75", "1.0", "1.25", "1.5", "2.0", "3.0"], width=5)
        self.speed.set("1.0")
        self.speed.pack(side=tk.LEFT, padx=10)
        self.speed.bind("<<ComboboxSelected>>",
                        lambda e: self.kernel.setRate(float(self.speed.get())))

        # 字幕选择
        self.sub_track = ttk.Combobox(ctrl, values=["关闭", "外部字幕(.srt)"], width=12, state="readonly")
        self.sub_track.set("外部字幕(.srt)")
        self.sub_track.pack(side=tk.LEFT, padx=10)
        self.sub_track.bind("<<ComboboxSelected>>", self.change_subtrack)

        tk.Button(ctrl, text="⛶", command=self.toggle_fullscreen, bg="#2a2a2a", fg="white", width=3).pack(side=tk.RIGHT, padx=2)
        tk.Button(ctrl, text="🌓", command=self.toggle_theme, bg="#2a2a2a", fg="white", width=3).pack(side=tk.RIGHT, padx=2)
        tk.Button(ctrl, text="📋", command=self.show_playlist, bg="#2a2a2a", fg="white", width=3).pack(side=tk.RIGHT, padx=2)
        tk.Button(ctrl, text="📸", command=self.screenshot, bg="#2a2a2a", fg="white").pack(side=tk.RIGHT, padx=2)
        tk.Button(ctrl, text="📁", command=self.open_folder, bg="#2a2a2a", fg="white").pack(side=tk.RIGHT, padx=2)
        tk.Button(ctrl, text="📂", command=self.open_files, bg="#2a2a2a", fg="white").pack(side=tk.RIGHT, padx=2)
        if HAS_TRAY:
            tk.Button(ctrl, text="➖", command=self.minimize_to_tray, bg="#2a2a2a", fg="white", width=3).pack(side=tk.RIGHT, padx=2)

    def bind_shortcuts(self):
        self.root.bind("<space>", lambda e: self.pause())
        self.root.bind("<Left>", lambda e: self.rewind())
        self.root.bind("<Right>", lambda e: self.forward())
        self.root.bind("<Up>", lambda e: self.volume_up())
        self.root.bind("<Down>", lambda e: self.volume_down())
        self.root.bind("<Return>", lambda e: self.toggle_fullscreen(e))
        self.root.bind("<Escape>", lambda e: self.exit_fullscreen())
        self.root.bind("f", lambda e: self.toggle_fullscreen(e))
        self.root.bind("F", lambda e: self.toggle_fullscreen(e))
        self.root.bind("<F11>", lambda e: self.toggle_fullscreen(e))
        self.root.bind("t", lambda e: self.toggle_theme())
        self.root.bind("T", lambda e: self.toggle_theme())

    def on_wheel(self, event):
        if event.delta > 0:
            self.volume_up()
        else:
            self.volume_down()

    def on_progress_wheel(self, event):
        if event.delta > 0:
            self.forward()
        else:
            self.rewind()

    def on_volume(self, v):
        """音量条回调（内核无关，走 PlayerEngine.setVolume）。"""
        self.kernel.setVolume(int(float(v)))

    def volume_up(self):
        v = min(100, self.volume.get() + 5)
        self.volume.set(v)
        self.kernel.setVolume(int(v))

    def volume_down(self):
        v = max(0, self.volume.get() - 5)
        self.volume.set(v)
        self.kernel.setVolume(int(v))

    def open_files(self):
        files = list(filedialog.askopenfilenames())
        if files:
            self.playlist.extend(files)
            if not self.has_media:
                self.load(0)
            self.update_sub_tracks()

    def open_folder(self):
        folder = filedialog.askdirectory()
        if folder:
            videos = [os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(self.video_exts)]
            if videos:
                self.playlist.extend(videos)
                if not self.has_media:
                    self.load(len(self.playlist) - len(videos))
                self.update_sub_tracks()

    def update_sub_tracks(self):
        """重建字幕轨下拉框：前两项固定，内嵌轨由内核提供（能力不同，见 kernel.py）。"""
        tracks = ["关闭", "外部字幕(.srt)"]
        if self.playlist:
            for name in self.kernel.subtitle_tracks(self.playlist[self.index]):
                tracks.append(f"轨道: {name}")
        if not self.kernel.caps.get('disableSubtitle'):
            # 该内核无法经控制通道关闭内嵌字幕轨（select_track 不接受 -1）
            tracks[0] = "关闭（仅面板字幕）"
        self.sub_track["values"] = tracks

    def change_subtrack(self, event):
        idx = self.sub_track.current()
        if idx == 0:
            self.current_sub_id = -2  # 关闭所有字幕
            self.subs = []
            if not self.kernel.disable_subtitle():
                self.status_label.config(text="该内核无法关闭内嵌字幕轨（仅关闭面板字幕）", fg="orange")
                self.root.after(2000, lambda: self.status_label.config(text=""))
        elif idx == 1:
            self.current_sub_id = -1  # 外部字幕（面板自绘，内核无关）
            if self.playlist:
                srt_path = os.path.splitext(self.playlist[self.index])[0] + ".srt"
                self.subs = parse_srt(srt_path) if os.path.exists(srt_path) else []
        else:
            self.current_sub_id = idx - 2  # 内嵌字幕轨
            self.subs = []
            if not self.kernel.select_subtitle(self.current_sub_id):
                self.status_label.config(text="切换内嵌字幕轨失败", fg="red")
                self.root.after(2000, lambda: self.status_label.config(text=""))

    def load(self, i):
        self.index = i
        self.root.update()
        # 只有支持嵌入的内核才需要把画面挂进 tk 窗口
        if self.kernel.caps.get('embed'):
            self.kernel.attach_window(self.video.winfo_id())

        uri = self.playlist[i]
        self.kernel.load({'uri': uri, 'id': uri, 'title': os.path.basename(uri),
                          'kind': 'video', 'source': 'local-file'})
        self.has_media = True

        # 外部字幕（面板自绘，与内核无关）
        srt_path = os.path.splitext(uri)[0] + ".srt"
        self.subs = parse_srt(srt_path) if os.path.exists(srt_path) else []

        self.kernel.play()
        self.update_sub_tracks()
        # 内核打开文件是异步的：首帧前 tracks() 可能还是空的（RPC 下尤其明显），
        # 所以稍后再刷一次字幕轨列表，否则下拉框里看不到内嵌轨。
        if self.kernel.caps.get('subtitleTracks'):
            self.root.after(800, self.update_sub_tracks)

        # 恢复播放位置：等内核把时长报上来再 seek（RPC 首帧前 duration 还是 0）
        last = self.cfg.get(f"pos_{uri}", 0)
        if last > 0:
            self.root.after(500, lambda: self.kernel.seek(int(last * 1000)))

        self.play_btn.config(text="⏸", bg="#3a5a3a")

    def play_pause(self):
        if not self.playlist:
            return
        st = self.kernel.getState()
        if st.get('playing'):
            self.kernel.pause()
            self.play_btn.config(text="▶", bg="#2a2a2a")
            self.status_label.config(text="⏸ 已暂停", fg="orange")
        else:
            self.kernel.play()
            self.play_btn.config(text="⏸", bg="#3a5a3a")
            self.status_label.config(text="▶ 播放中", fg="green")
        self.root.after(1500, lambda: self.status_label.config(text=""))

    def play(self): 
        if self.playlist: 
            self.kernel.play()
            self.play_btn.config(text="⏸", bg="#3a5a3a")
            self.status_label.config(text="▶ 播放中", fg="green")
            self.root.after(1500, lambda: self.status_label.config(text=""))

    def pause(self): 
        if self.playlist: 
            self.kernel.pause()
            self.play_btn.config(text="▶", bg="#2a2a2a")
            self.status_label.config(text="⏸ 已暂停", fg="orange")
            self.root.after(1500, lambda: self.status_label.config(text=""))

    def prev(self): 
        if self.playlist: 
            self.save_current_pos()
            self.load(max(0, self.index - 1))

    def next(self): 
        if self.playlist: 
            self.save_current_pos()
            self.load(min(len(self.playlist) - 1, self.index + 1))

    def forward(self):
        if self.playlist:
            st = self.kernel.getState()
            t = st.get('timeMs', 0) + 10000
            dur = st.get('durationMs')
            self.kernel.seek(min(t, dur) if dur else t)
            self.show_time_tip("+10s")

    def rewind(self):
        if self.playlist:
            t = self.kernel.getState().get('timeMs', 0) - 10000
            self.kernel.seek(max(t, 0))
            self.show_time_tip("-10s")

    def show_time_tip(self, text):
        self.status_label.config(text=text, fg="cyan")
        self.root.after(500, lambda: self.status_label.config(text=""))

    def toggle_fullscreen(self, event=None):
        """面板全屏 + （若内核画面在独立窗口）同步让那个窗口也全屏。

        两个内核的语义不同，不能只做一半：
          - vlc：画面嵌在面板里 → 面板全屏就够了；
          - pluginplayer：画面在播放器自己的 SDL 窗口 → 必须额外调 app.fullscreen。
        """
        self.is_fullscreen = not self.is_fullscreen
        self.root.attributes("-fullscreen", self.is_fullscreen)
        if not self.is_fullscreen:
            self.root.geometry("1100x680")
        if self.kernel.caps.get('externalFullscreen'):
            if not self.kernel.set_external_fullscreen(self.is_fullscreen):
                self.show_time_tip("播放器窗口全屏切换失败（可能以 --hidden 启动）")

    def exit_fullscreen(self):
        self.is_fullscreen = False
        self.root.attributes("-fullscreen", False)
        self.root.geometry("1100x680")
        if self.kernel.caps.get('externalFullscreen'):
            self.kernel.set_external_fullscreen(False)

    def screenshot(self):
        if not self.playlist:
            self.status_label.config(text="请先打开视频！", fg="red")
            self.root.after(2000, lambda: self.status_label.config(text=""))
            return
        folder = os.path.dirname(self.playlist[self.index]) or "."
        name = os.path.splitext(os.path.basename(self.playlist[self.index]))[0]
        path = os.path.join(folder, f"{name}_snapshot.png")
        got = self.kernel.screenshot(path)
        if not got:
            self.status_label.config(text="截图失败", fg="red")
        elif got != path:
            self.status_label.config(text=f"截图已保存到 {got}（目标目录不在写入白名单）", fg="orange")
        else:
            self.status_label.config(text="截图已保存", fg="cyan")
        self.root.after(2000, lambda: self.status_label.config(text=""))

    def show_playlist(self):
        if not self.playlist:
            self.status_label.config(text="播放列表为空", fg="yellow")
            self.root.after(2000, lambda: self.status_label.config(text=""))
            return
        
        win = tk.Toplevel(self.root)
        win.title("播放列表")
        win.geometry("400x300")
        win.configure(bg="#1e1e1e")
        
        frame = tk.Frame(win, bg="#1e1e1e")
        frame.pack(fill=tk.BOTH, expand=True)
        
        scrollbar = tk.Scrollbar(frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        self.listbox = tk.Listbox(frame, bg="#2a2a2a", fg="white", font=("Microsoft YaHei", 10), yscrollcommand=scrollbar.set)
        self.listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.config(command=self.listbox.yview)
        
        for idx, path in enumerate(self.playlist):
            name = os.path.basename(path)
            mark = "▶ " if idx == self.index else "   "
            self.listbox.insert(tk.END, f"{mark}{idx+1}. {name}")
        
        self.listbox.bind("<Double-Button-1>", lambda e: self.play_selected(win))
        self.listbox.bind("<Delete>", lambda e: self.remove_selected())
        
        tk.Button(win, text="播放选中", command=lambda: self.play_selected(win), bg="#2a2a2a", fg="white").pack(pady=5)
        tk.Button(win, text="删除选中", command=lambda: self.remove_selected(), bg="#2a2a2a", fg="white").pack(pady=5)

    def play_selected(self, win):
        try:
            idx = self.listbox.curselection()[0]
            win.destroy()
            self.save_current_pos()
            self.load(idx)
        except:
            pass

    def remove_selected(self):
        try:
            idx = self.listbox.curselection()[0]
            self.listbox.delete(idx)
            del self.playlist[idx]
            if idx == self.index:
                if self.playlist:
                    self.load(max(0, idx - 1))
                else:
                    self.index = 0
                    self.has_media = False
            elif idx < self.index:
                self.index -= 1
        except:
            pass

    def save_current_pos(self):
        """记录播放进度（0..1）。未知时长时不动 —— 两个内核都靠 getState 拿时长。"""
        if not (self.playlist and self.has_media):
            return
        try:
            st = self.kernel.getState()
        except Exception:
            return
        dur = st.get('durationMs')
        if dur:
            self.cfg[f"pos_{self.playlist[self.index]}"] = st.get('timeMs', 0) / dur

    def seek_video(self, event):
        st = self.kernel.getState()
        dur = st.get('durationMs')
        if dur:
            self.kernel.seek(int(self.progress.get() / 1000 * dur))

    def updater(self):
        while True:
            try:
                self.root.after(100, self._update_ui)
            except:
                pass
            time.sleep(0.1)

    def _update_ui(self):
        try:
            st = self.kernel.getState()
        except Exception:
            return                       # 内核进程没了 / 连接断了：别让 UI 线程崩掉

        t = st.get('timeMs', 0) / 1000
        self.sub_label.config(text=next((txt for s, e, txt in self.subs if s <= t <= e), ""))

        dur = st.get('durationMs')
        if dur:
            self.progress.set(int(st.get('timeMs', 0) / dur * 1000))
            ct = int(t)
            lt = int(dur / 1000)
            self.time_label.config(text=f"{ct//3600:02d}:{(ct%3600)//60:02d}:{ct%60:02d} / {lt//3600:02d}:{(lt%3600)//60:02d}:{lt%60:02d}")


def parse_args(argv):
    """极简参数解析（零第三方依赖）：`[媒体文件] [--kernel=NAME]`。"""
    kernel = None
    media = None
    for a in argv[1:]:
        if a.startswith('--kernel='):
            kernel = a.split('=', 1)[1].strip() or None
        elif a in ('-h', '--help'):
            print(__doc__ or '')
            print('用法: python play.py [媒体文件] [--kernel=pluginplayer|vlc|auto]')
            raise SystemExit(0)
        elif not a.startswith('-') and media is None:
            media = a
    return media, kernel


if __name__ == "__main__":
    media, kernel_req = parse_args(sys.argv)
    root = tk.Tk()
    try:
        app = DailyPlayer(root, kernel_request=kernel_req)
    except SystemExit:
        sys.exit(1)                      # 没有可用内核（init_kernel 已弹过错误框）
    if media:
        p = os.path.abspath(media)
        if os.path.isfile(p):
            app.playlist.append(p)
            app.load(0)
    try:
        root.mainloop()
    finally:
        app.kernel.shutdown()            # 收掉 PluginPlayer 子进程
