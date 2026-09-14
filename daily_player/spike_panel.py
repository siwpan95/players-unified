"""S1 / Phase 4 形态 A：最小 tkinter 面板，用 PluginPlayer 当内核驱动播放。

这是「以 PluginPlayer 为内核替换 libVLC」的形态 A 演示：
  - 面板（daily_player 这一端）只依赖 **PlayerEngine 端口**，不认识底层是谁；
  - 窗口是**两个**：控制面板（tkinter）+ 播放器自己的 SDL 窗口
    （PluginPlayer 目前无法把画面嵌入外部窗口 —— 详见
     docs/phase4-kernel-assessment.md 的 S2）。

刻意把**控制逻辑**（PanelController）与 **tkinter 界面**（build_ui）分开：
控制器不 import tkinter，可以在无 GUI 环境里单测（见 tests/test_spike_panel.py）。

用法
----
    # 形态 A 面板（需要图形界面）
    F:/Python314/python.exe spike_panel.py --exe <pluginplayer.exe>

    # 无 GUI 冒烟：连上播放器跑 5 秒，打印状态与字幕后退出（退出码 0 = 正常）
    F:/Python314/python.exe spike_panel.py --no-gui --attach-port 7911 --attach-token <token>
"""

import argparse
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from player_engine_rpc import (  # noqa: E402
    ControlChannel, PluginPlayerRpcEngine, RpcError,
)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_EXE = os.path.join(ROOT, 'pluginplayer', 'dist', 'pluginplayer.exe')
FALLBACK_EXE = r'G:\repos\pluginplayer\dist\pluginplayer.exe'


class PanelController:
    """面板的控制逻辑（不依赖 tkinter，可单测）。

    只通过 PlayerEngine 端口操作播放器；额外能力（字幕事件 / 截图）走
    engine 的扩展方法，UI 不直接碰 RPC。
    """

    def __init__(self, engine):
        self.engine = engine
        self.subtitle = ''
        self.lastError = None
        self.state = None

    # ---- 事件 ----
    def pump(self):
        """消化推送帧；返回本次新收到的字幕文本（无变化返回 None）。"""
        try:
            self.engine.rpc.pump(0.0)
        except RpcError as e:
            self.lastError = str(e)
            return None
        changed = None
        for ev in self.engine.takeEvents('subtitle.line'):
            text = (ev.get('data') or {}).get('text') or ''
            if text != self.subtitle:
                self.subtitle = text
                changed = text
        return changed

    # ---- 端口动作 ----
    def refresh(self):
        try:
            self.state = self.engine.getState()
            self.lastError = None
        except RpcError as e:
            self.lastError = str(e)
        return self.state

    def open_(self, uri):
        try:
            self.engine.load({'uri': uri})
            self.engine.play()
            self.lastError = None
            return True
        except RpcError as e:
            self.lastError = str(e)
            return False

    def toggle(self):
        st = self.state or self.refresh()
        try:
            if st and st.get('playing'):
                self.engine.pause()
            else:
                self.engine.play()
        except RpcError as e:
            self.lastError = str(e)
        return self.refresh()

    def seekMs(self, ms):
        try:
            self.engine.seek(ms)
        except RpcError as e:
            self.lastError = str(e)
        return self.refresh()

    def setVolume(self, v):
        try:
            self.engine.setVolume(v)
        except RpcError as e:
            self.lastError = str(e)
        return self.refresh()

    def setRate(self, r):
        try:
            self.engine.setRate(r)
        except RpcError as e:
            self.lastError = str(e)
        return self.refresh()

    def snapshot(self, out_dir):
        """截图到 out_dir。注意：该目录必须在播放器的写入白名单内
        （启动时 --write-dir，或就是 exeDir）。"""
        try:
            self.engine.snapshot(os.path.join(out_dir, 'panel.png'))
            return True
        except RpcError as e:
            self.lastError = str(e)
            return False

    def loadSubtitle(self, path):
        try:
            self.engine.loadSubtitle(path)
            return True
        except RpcError as e:
            self.lastError = str(e)
            return False


def build_ui(root, ctrl, on_quit=None):
    """搭最小面板：打开/播放/进度/音量/倍速/字幕/截图。返回 tick 函数。"""
    import tkinter as tk
    from tkinter import filedialog, ttk

    root.title('daily_player × PluginPlayer — S1 形态 A 尖峰面板')

    uri_var = tk.StringVar()
    sub_var = tk.StringVar(value=os.path.join(HERE, '_s1_out', 'spike.srt'))
    time_var = tk.StringVar(value='00:00 / 00:00')
    sub_text = tk.StringVar(value='（无字幕）')
    status = tk.StringVar(value='未连接')

    def fmt(ms):
        if ms is None:
            return '--:--'
        s = int(ms / 1000)
        return f'{s // 60:02d}:{s % 60:02d}'

    top = ttk.Frame(root, padding=8)
    top.pack(fill='x')
    ttk.Entry(top, textvariable=uri_var, width=60).pack(side='left', fill='x', expand=True)
    ttk.Button(top, text='打开…', command=lambda: uri_var.set(
        filedialog.askopenfilename() or uri_var.get())).pack(side='left', padx=4)
    ttk.Button(top, text='载入播放', command=lambda: ctrl.open_(uri_var.get())).pack(side='left')

    mid = ttk.Frame(root, padding=8)
    mid.pack(fill='x')
    ttk.Button(mid, text='播放/暂停', command=ctrl.toggle).pack(side='left')

    seek = ttk.Scale(root, from_=0, to=1000, orient='horizontal')
    seek.pack(fill='x', padx=8)
    ttk.Label(root, textvariable=time_var).pack(anchor='w', padx=8)

    vol = ttk.Scale(root, from_=0, to=100, orient='horizontal')
    vol.set(100)
    vol.pack(fill='x', padx=8)
    ttk.Label(root, text='音量').pack(anchor='w', padx=8)

    rate = ttk.Frame(root, padding=8)
    rate.pack(fill='x')
    for r in (0.5, 1.0, 1.5, 2.0):
        ttk.Button(rate, text=f'{r}x', command=lambda r=r: ctrl.setRate(r)).pack(side='left')

    subf = ttk.Frame(root, padding=8)
    subf.pack(fill='x')
    ttk.Entry(subf, textvariable=sub_var, width=50).pack(side='left', fill='x', expand=True)
    ttk.Button(subf, text='载入字幕', command=lambda: ctrl.loadSubtitle(sub_var.get())).pack(side='left')

    ttk.Label(root, textvariable=sub_text, wraplength=560,
              font=('Microsoft YaHei UI', 14)).pack(padx=8, pady=4)
    ttk.Button(root, text='截图', command=lambda: ctrl.snapshot(
        os.path.join(HERE, '_s1_out'))).pack(pady=4)
    ttk.Label(root, textvariable=status, foreground='#555').pack(anchor='w', padx=8)

    _seek_drag = {'on': False}

    def on_seek_down(_e):
        _seek_drag['on'] = True

    def on_seek_up(_e):
        _seek_drag['on'] = False
        dur = (ctrl.state or {}).get('durationMs') or 0
        if dur > 0:
            ctrl.seekMs(float(seek.get()) / 1000.0 * dur)

    seek.bind('<ButtonPress-1>', on_seek_down)
    seek.bind('<ButtonRelease-1>', on_seek_up)
    vol.configure(command=lambda v: ctrl.setVolume(float(v)))

    def tick():
        if ctrl.pump():
            sub_text.set(ctrl.subtitle or '（空行）')
        st = ctrl.refresh()
        if st:
            if not _seek_drag['on']:
                dur = st.get('durationMs') or 0
                if dur > 0:
                    seek.set(st.get('timeMs', 0) / dur * 1000.0)
            time_var.set(f"{fmt(st.get('timeMs'))} / {fmt(st.get('durationMs'))}")
            status.set('错误：' + ctrl.lastError if ctrl.lastError
                       else ('播放中' if st.get('playing') else '已暂停'))
        root.after(200, tick)      # 5Hz：控制通道每次往返约 1 帧（16.7ms），不必更快

    return tick


def launch_player(exe, port, token, out_dir):
    """拉起 --hidden 的播放器进程。返回 Popen。"""
    os.makedirs(out_dir, exist_ok=True)
    log = os.path.join(out_dir, 'panel-player.log')
    fp = open(log, 'wb')
    cmd = [exe, '--hidden', '--rpc-port', str(port), '--rpc-token', token,
           '--write-dir', out_dir, '--log-level', '2']
    print('[panel] 启动:', ' '.join(cmd))
    print('[panel] 播放器日志 →', log)
    return subprocess.Popen(cmd, cwd=os.path.dirname(exe), stdout=fp, stderr=subprocess.STDOUT), fp


def main():
    ap = argparse.ArgumentParser(description='S1 形态 A：tkinter 面板驱动 PluginPlayer')
    ap.add_argument('--exe', default=None)
    ap.add_argument('--port', type=int, default=0, help='0 = 自动选空闲端口')
    ap.add_argument('--attach-port', type=int, default=0, help='连到已有播放器（不自己拉起）')
    ap.add_argument('--attach-token', default=None)
    ap.add_argument('--out', default=os.path.join(HERE, '_s1_out'))
    ap.add_argument('--seconds', type=float, default=5.0, help='--no-gui 模式运行时长')
    ap.add_argument('--no-gui', action='store_true', help='无界面冒烟：连上后跑 --seconds 秒退出')
    args = ap.parse_args()

    proc = fp = None
    if args.attach_port:
        rpc = ControlChannel(port=args.attach_port, token=args.attach_token)
        rpc.connect()
    else:
        exe = args.exe or (DEFAULT_EXE if os.path.isfile(DEFAULT_EXE) else FALLBACK_EXE)
        if not os.path.isfile(exe):
            print('[panel] 找不到 pluginplayer.exe:', exe)
            return 2
        import socket
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        port = args.port or s.getsockname()[1]
        s.close()
        token = 'panel-tok-' + str(int(time.time())) + '-0123456789'
        proc, fp = launch_player(exe, port, token, args.out)
        rpc = ControlChannel(port=port, token=token)
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                rpc.connect()
                break
            except OSError:
                time.sleep(0.2)
        else:
            print('[panel] 控制通道未起来')
            return 2

    ctrl = PanelController(PluginPlayerRpcEngine(rpc))
    try:
        if args.no_gui:
            print('[panel] 无 GUI 冒烟 %ss …' % args.seconds)
            end = time.time() + args.seconds
            while time.time() < end:
                if ctrl.pump():
                    print('  字幕:', ctrl.subtitle)
                st = ctrl.refresh()
                if st:
                    print(f"  timeMs={st['timeMs']} dur={st['durationMs']} "
                          f"playing={st['playing']} err={ctrl.lastError}")
                time.sleep(0.5)
            print('[panel] 冒烟结束 ✅')
            return 0

        import tkinter as tk
        root = tk.Tk()
        tick = build_ui(root, ctrl)
        root.after(200, tick)
        try:
            root.mainloop()
        finally:
            try:
                rpc.call('app.quit')
            except Exception:
                pass
        return 0
    finally:
        rpc.close()
        if proc and proc.poll() is None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if fp:
            fp.close()


if __name__ == '__main__':
    sys.exit(main())
