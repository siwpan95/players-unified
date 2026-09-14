import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import vlc, threading, time, os, re, json

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
    def __init__(self, root):
        self.root = root
        self.root.title("日常视频播放器")
        self.cfg_file = os.path.join(os.path.expanduser("~"), ".daily_player_cfg.json")
        self.load_config()
        self.root.geometry(self.cfg.get("geometry", "1100x680"))
        
        self.vlc = vlc.Instance()
        if self.vlc is None:
            raise RuntimeError("无法初始化 VLC 实例")
        self.player = self.vlc.media_player_new()
        self.is_fullscreen = False
        self.tray_icon = None

        # 主题系统
        self.themes = {
            "dark": {"bg": "#121212", "fg": "white", "btn_bg": "#2a2a2a", "accent": "#3a5a3a"},
            "light": {"bg": "#f0f0f0", "fg": "black", "btn_bg": "#e0e0e0", "accent": "#4CAF50"},
        }
        self.current_theme = self.cfg.get("theme", "dark")

        self.playlist, self.index, self.subs = [], 0, []
        self.video_exts = ('.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v')
        self.current_sub_id = -1  # -1 = 外部字幕, 其他 = VLC字幕轨道

        self.build_ui()
        self.bind_shortcuts()
        threading.Thread(target=self.updater, daemon=True).start()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

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
        self.video = tk.Frame(self.root, bg="black", cursor="hand2")
        self.video.pack(fill=tk.BOTH, expand=True)
        self.video.bind("<Double-Button-1>", self.toggle_fullscreen)
        self.video.bind("<MouseWheel>", self.on_wheel)

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
        self.volume = ttk.Scale(ctrl, from_=0, to=100, command=lambda v: self.player.audio_set_volume(int(float(v))))
        self.volume.set(self.cfg.get("volume", 80))
        self.volume.pack(side=tk.LEFT)

        self.speed = ttk.Combobox(ctrl, values=["0.25", "0.5", "0.75", "1.0", "1.25", "1.5", "2.0", "3.0"], width=5)
        self.speed.set("1.0")
        self.speed.pack(side=tk.LEFT, padx=10)
        self.speed.bind("<<ComboboxSelected>>", lambda e: self.player.set_rate(float(self.speed.get())))

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

    def volume_up(self):
        v = min(100, self.volume.get() + 5)
        self.volume.set(v)
        self.player.audio_set_volume(int(v))

    def volume_down(self):
        v = max(0, self.volume.get() - 5)
        self.volume.set(v)
        self.player.audio_set_volume(int(v))

    def open_files(self):
        files = list(filedialog.askopenfilenames())
        if files:
            self.playlist.extend(files)
            if not self.player.get_media():
                self.load(0)
            self.update_sub_tracks()

    def open_folder(self):
        folder = filedialog.askdirectory()
        if folder:
            videos = [os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(self.video_exts)]
            if videos:
                self.playlist.extend(videos)
                if not self.player.get_media():
                    self.load(len(self.playlist) - len(videos))
                self.update_sub_tracks()

    def update_sub_tracks(self):
        tracks = ["关闭", "外部字幕(.srt)"]
        if self.playlist:
            media = self.vlc.media_new(self.playlist[self.index])
            track_list = media.sub_description_get()
            if track_list:
                for t in track_list:
                    tracks.append(f"轨道: {t.decode('utf-8', errors='ignore')}" if isinstance(t, bytes) else f"轨道: {t}")
            media.release()
        self.sub_track["values"] = tracks

    def change_subtrack(self, event):
        idx = self.sub_track.current()
        if idx == 0:
            self.current_sub_id = -2  # 关闭所有字幕
            self.subs = []
            self.player.video_set_spu(-1)
        elif idx == 1:
            self.current_sub_id = -1  # 外部字幕
            if self.playlist:
                srt_path = os.path.splitext(self.playlist[self.index])[0] + ".srt"
                self.subs = parse_srt(srt_path) if os.path.exists(srt_path) else []
        else:
            self.current_sub_id = idx - 2  # VLC 内嵌字幕轨道
            self.subs = []
            self.player.video_set_spu(self.current_sub_id)

    def load(self, i):
        self.index = i
        media = self.vlc.media_new(self.playlist[i])
        self.player.set_media(media)
        self.root.update()
        self.player.set_hwnd(int(self.video.winfo_id())) if os.name == "nt" else self.player.set_xwindow(int(self.video.winfo_id()))
        
        # 外部字幕
        srt_path = os.path.splitext(self.playlist[i])[0] + ".srt"
        self.subs = parse_srt(srt_path) if os.path.exists(srt_path) else []
        
        self.update_sub_tracks()
        
        # 恢复播放位置
        last = self.cfg.get(f"pos_{self.playlist[i]}", 0)
        if last > 0:
            self.player.play()
            time.sleep(0.5)
            self.player.set_time(int(last * 1000))
        
        self.player.play()
        self.play_btn.config(text="⏸", bg="#3a5a3a")

    def play_pause(self):
        if not self.playlist:
            return
        state = self.player.get_state()
        if state == vlc.State.PLAYING:
            self.player.pause()
            self.play_btn.config(text="▶", bg="#2a2a2a")
            self.status_label.config(text="⏸ 已暂停", fg="orange")
        else:
            self.player.play()
            self.play_btn.config(text="⏸", bg="#3a5a3a")
            self.status_label.config(text="▶ 播放中", fg="green")
        self.root.after(1500, lambda: self.status_label.config(text=""))

    def play(self): 
        if self.playlist: 
            self.player.play()
            self.play_btn.config(text="⏸", bg="#3a5a3a")
            self.status_label.config(text="▶ 播放中", fg="green")
            self.root.after(1500, lambda: self.status_label.config(text=""))

    def pause(self): 
        if self.playlist: 
            self.player.pause()
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
            t = self.player.get_time() + 10000
            length = self.player.get_length()
            self.player.set_time(min(t, length))
            self.show_time_tip("+10s")

    def rewind(self):
        if self.playlist:
            t = self.player.get_time() - 10000
            self.player.set_time(max(t, 0))
            self.show_time_tip("-10s")

    def show_time_tip(self, text):
        self.status_label.config(text=text, fg="cyan")
        self.root.after(500, lambda: self.status_label.config(text=""))

    def toggle_fullscreen(self, event=None):
        self.is_fullscreen = not self.is_fullscreen
        self.root.attributes("-fullscreen", self.is_fullscreen)
        if not self.is_fullscreen:
            self.root.geometry("1100x680")

    def exit_fullscreen(self):
        self.is_fullscreen = False
        self.root.attributes("-fullscreen", False)
        self.root.geometry("1100x680")

    def screenshot(self):
        if not self.playlist:
            self.status_label.config(text="请先打开视频！", fg="red")
            self.root.after(2000, lambda: self.status_label.config(text=""))
            return
        folder = os.path.dirname(self.playlist[self.index]) or "."
        name = os.path.splitext(os.path.basename(self.playlist[self.index]))[0]
        path = os.path.join(folder, f"{name}_snapshot.png")
        self.player.video_take_snapshot(0, path, 0, 0)
        self.status_label.config(text=f"截图已保存", fg="cyan")
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
            elif idx < self.index:
                self.index -= 1
        except:
            pass

    def save_current_pos(self):
        if self.playlist and self.player.get_length() > 0:
            pos = self.player.get_time() / 1000 / (self.player.get_length() / 1000)
            self.cfg[f"pos_{self.playlist[self.index]}"] = pos

    def seek_video(self, event):
        length = self.player.get_length()
        if length > 0:
            pos = self.progress.get() / 1000
            self.player.set_time(int(pos * length))

    def updater(self):
        while True:
            try:
                self.root.after(100, self._update_ui)
            except:
                pass
            time.sleep(0.1)

    def _update_ui(self):
        t = self.player.get_time() / 1000
        self.sub_label.config(text=next((txt for s, e, txt in self.subs if s <= t <= e), ""))

        length = self.player.get_length()
        if length > 0:
            self.progress.set(int(self.player.get_time() / length * 1000))
            ct = int(t)
            lt = int(length / 1000)
            self.time_label.config(text=f"{ct//3600:02d}:{(ct%3600)//60:02d}:{ct%60:02d} / {lt//3600:02d}:{(lt%3600)//60:02d}:{lt%60:02d}")


if __name__ == "__main__":
    root = tk.Tk()
    DailyPlayer(root)
    root.mainloop()
