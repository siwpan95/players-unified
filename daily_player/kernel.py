"""daily_player 的内核选择、启动与统一门面（Phase 4：默认内核切到 PluginPlayer）。

背景
----
Phase 2 建了 `PlayerEngine` 端口，Phase 4 的 S0/S1/S3 证明 PluginPlayer 能顶上。
本模块把"选哪个内核"这件事收成一个入口，让 `play.py` 只面对 **端口 + 能力声明**，
不再到处写 `self.player.xxx`（libVLC 专有）。

三种内核
--------
- `pluginplayer`（**默认**）：拉起 `pluginplayer.exe`，经控制通道驱动。
  画面在播放器自己的 SDL 窗口（今天无法嵌入 tk），字幕由面板自绘。
- `vlc`：保持原行为，libVLC 嵌入 tkinter frame。需要装 VLC + python-vlc。
- `auto`：**优先 pluginplayer**，找不到 exe 或起不来就回落 vlc（若可用）。

选择优先级：`--kernel` 命令行 > 配置 `~/.daily_player_cfg.json` 的 `kernel` 键 > 默认 pluginplayer。

能力差异（UI 必须知道，不能假装一样）
--------------------------------------
| 能力 | vlc | pluginplayer |
|---|---|---|
| embed（画面嵌入 tk 窗口） | ✅ | ❌（独立窗口） |
| externalFullscreen（远端窗口全屏） | ➖ 不需要 | ✅ `app.fullscreen` |
| subtitleTracks（读内嵌字幕轨） | ✅ | ✅ `player.tracks` |
| disableSubtitle（经内核关字幕） | ✅ `video_set_spu(-1)` | ❌（RPC 不接受 -1） |
| snapshot 落盘到任意目录 | ✅ | ⚠️ 受写入白名单限制 → 本模块中转 |

最后一条是本模块存在的另一个理由：PluginPlayer 的插件只能写到 `--write-dir`
白名单内（`src/core/host.cpp:539`），直接让它写"视频同目录"会静默失败。
所以 `Kernel.screenshot()` 对 pluginplayer 内核是**先落白名单目录、再复制到目标路径**。
"""

import os
import shutil
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

KERNEL_VLC = 'vlc'
KERNEL_PP = 'pluginplayer'
KERNEL_AUTO = 'auto'
DEFAULT_KERNEL = KERNEL_PP

# 内嵌字幕轨在 FFmpeg/AVMediaType 里的类型号（player.select_track 的 type 参数）
AVMEDIA_TYPE_SUBTITLE = 3

# pluginplayer.exe 的搜索顺序（第一个命中的胜出）
_EXE_ENV = 'DAILY_PLAYER_PP_EXE'
_EXE_CANDIDATES = (
    os.path.join(HERE, 'pluginplayer', 'pluginplayer.exe'),        # 随 daily_player 分发
    os.path.join(ROOT, 'pluginplayer', 'dist', 'pluginplayer.exe'),  # 本仓库构建产物
    r'G:\repos\pluginplayer\dist\pluginplayer.exe',                  # 原仓库（历史路径）
)


# ---------------------------------------------------------------- 内核选择

def find_pluginplayer_exe(extra_candidates=()):
    """按 环境变量 → 随包目录 → 仓库 dist → 历史路径 的顺序找 exe。找不到返回 None。"""
    env = (os.environ.get(_EXE_ENV) or '').strip().strip('"')
    if env and os.path.isfile(env):
        return env
    for p in list(extra_candidates) + list(_EXE_CANDIDATES):
        if p and os.path.isfile(p):
            return p
    return None


def vlc_available():
    """python-vlc 与 libVLC 运行时是否可用（import 失败即不可用）。"""
    try:
        import vlc  # noqa: F401
        return True
    except Exception:
        return False


def choose_kernel(requested, pp_exe=None, vlc_ok=None):
    """纯决策：给定请求与检出结果，返回 (内核名, 说明)。

    不启动任何进程、不 import vlc —— 便于单测。
    """
    req = (requested or DEFAULT_KERNEL).strip().lower()
    if req in ('pp', 'plugin-player', KERNEL_PP):
        req = KERNEL_PP
    elif req in ('libvlc', KERNEL_VLC):
        req = KERNEL_VLC
    elif req != KERNEL_AUTO:
        return None, f'未知内核: {requested}（可选 {KERNEL_PP} / {KERNEL_VLC} / {KERNEL_AUTO}）'

    if req == KERNEL_VLC:
        return (KERNEL_VLC, '显式指定') if vlc_ok else (None, '指定 vlc 内核，但 python-vlc/libVLC 不可用')

    # pluginplayer / auto
    if pp_exe:
        return KERNEL_PP, f'使用 {pp_exe}'
    if req == KERNEL_PP:
        return None, '未找到 pluginplayer.exe（设 DAILY_PLAYER_PP_EXE 或放到 daily_player/pluginplayer/）'
    # auto 且找不到 pp
    if vlc_ok:
        return KERNEL_VLC, '未找到 pluginplayer.exe，回落到 VLC'
    return None, '既没有 pluginplayer.exe 也没有可用的 libVLC'


def free_port():
    s = socket.socket()
    try:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]
    finally:
        s.close()


# ---------------------------------------------------------------- 进程托管

class PluginPlayerProcess:
    """拉起并托管一个 pluginplayer 进程（无人值守：--hidden + 控制通道）。"""

    def __init__(self, exe, snapshot_dir, extra_write_dirs=(), timeout=5.0, wait_port_sec=40.0):
        self.exe = exe
        self.snapshot_dir = snapshot_dir
        self.extra_write_dirs = list(extra_write_dirs)
        self.timeout = timeout
        self.wait_port_sec = wait_port_sec
        self.proc = None
        self.log_fp = None
        self.log_path = None
        self.port = None
        self.token = None

    # 纯函数，便于单测
    def build_cmd(self, port, token):
        os.makedirs(self.snapshot_dir, exist_ok=True)
        cmd = [self.exe, '--hidden',
               '--rpc-port', str(port),
               '--rpc-token', token,
               '--write-dir', self.snapshot_dir,
               '--log-level', '2']
        for d in self.extra_write_dirs:
            cmd += ['--write-dir', d]
        return cmd

    def start(self):
        """启动进程并连接控制通道；返回 PluginPlayerRpcEngine。失败时清理并抛 RuntimeError。"""
        self.port = free_port()
        # 令牌必须 >= 16 字符（src/core/main.cpp:249）
        self.token = 'dp-' + str(int(time.time())) + '-' + os.path.basename(__file__)
        cmd = self.build_cmd(self.port, self.token)

        self.log_path = os.path.join(self.snapshot_dir, 'pluginplayer.log')
        self.log_fp = open(self.log_path, 'wb')     # 不能用 PIPE：>4KB 日志会把播放器堵死
        self.proc = subprocess.Popen(cmd, cwd=os.path.dirname(self.exe) or None,
                                     stdout=self.log_fp, stderr=subprocess.STDOUT)
        try:
            if not self._wait_port():
                raise RuntimeError(f'控制通道端口 {self.port} 未起来（日志: {self.log_path}）')
            return self.connect_engine()
        except Exception:
            self.shutdown()
            raise

    def connect_engine(self):
        """连上已就绪的控制通道并完成事件订阅。

        与"拉起进程"拆开是为了可单测：测试只要把 `port` 指向一个假服务端即可，
        不需要真的能跑 pluginplayer.exe。
        """
        from player_engine_rpc import ControlChannel, PluginPlayerRpcEngine

        rpc = ControlChannel(port=self.port, token=self.token, timeout=self.timeout)
        rpc.connect()
        eng = PluginPlayerRpcEngine(rpc)
        # 控制通道默认**不推**任何事件：不订阅就拿不到 app.fullscreen，
        # 面板的全屏状态会跟播放器窗口脱节（实测坑，见 docs/phase4 §10）。
        eng.subscribeDefaults()
        return eng

    def _wait_port(self):
        end = time.time() + self.wait_port_sec
        while time.time() < end:
            if self.proc and self.proc.poll() is not None:
                return False
            try:
                c = socket.create_connection(('127.0.0.1', self.port), timeout=0.5)
                c.close()
                return True
            except OSError:
                time.sleep(0.1)
        return False

    def shutdown(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.proc = None
        if self.log_fp:
            try:
                self.log_fp.close()
            except Exception:
                pass
            self.log_fp = None


# ---------------------------------------------------------------- 内核门面

class Kernel:
    """统一内核句柄：PlayerEngine + 能力声明 + 内核专属补差。

    play.py 只跟这个对象打交道。端口内的方法（play/pause/seek/...）直接转发 engine；
    端口外的差异（嵌入、字幕轨、远端全屏、截图落盘）由这里显式声明能力或补差实现。
    """

    def __init__(self, name, engine, proc=None, snapshot_dir=None, caps=None):
        self.name = name
        self.engine = engine
        self.proc = proc
        self.snapshot_dir = snapshot_dir
        base = {'embed': False, 'externalFullscreen': False,
                'subtitleTracks': False, 'disableSubtitle': False}
        base.update(caps or {})
        self.caps = base

    # ---- 端口直通 ----
    def __getattr__(self, item):
        """未定义的属性转发给 engine（load/play/pause/seek/setRate/setVolume/...）。"""
        engine = self.__dict__.get('engine')
        if engine is not None and hasattr(engine, item):
            return getattr(engine, item)
        raise AttributeError(item)

    # ---- 窗口 ----
    def attach_window(self, hwnd):
        """把画面挂到 tk 窗口。不支持的内核返回 False（UI 据此给出提示）。"""
        return False

    def set_external_fullscreen(self, on):
        """切换**独立窗口**的全屏（tk 自己的全屏由 UI 处理）。不支持返回 False。"""
        return False

    # ---- 字幕轨 ----
    def subtitle_tracks(self, media_path):
        """返回内嵌字幕轨的显示名列表（不含"关闭/外部字幕"两项）。"""
        return []

    def select_subtitle(self, index):
        """切换内嵌字幕轨。index 为 subtitle_tracks() 的下标。"""
        return False

    def disable_subtitle(self):
        """经内核关闭字幕。不支持返回 False（UI 只能清掉自己画的字幕）。"""
        return False

    # ---- 截图 ----
    def screenshot(self, dest_path):
        """截图到 dest_path，返回实际落盘路径；失败返回 None。"""
        return None

    # ---- 生命周期 ----
    def shutdown(self):
        if self.proc:
            self.proc.shutdown()


class VlcKernel(Kernel):
    def __init__(self, engine, instance=None):
        super().__init__(KERNEL_VLC, engine,
                         caps={'embed': True, 'externalFullscreen': False,
                               'subtitleTracks': True, 'disableSubtitle': True})
        self.instance = instance

    def attach_window(self, hwnd):
        try:
            if os.name == 'nt':
                self.engine.player.set_hwnd(int(hwnd))
            else:
                self.engine.player.set_xwindow(int(hwnd))
            return True
        except Exception:
            return False

    def subtitle_tracks(self, media_path):
        if not self.instance or not media_path:
            return []
        try:
            media = self.instance.media_new(media_path)
            got = media.sub_description_get() or []
            out = []
            for t in got:
                out.append(t.decode('utf-8', errors='ignore') if isinstance(t, bytes) else str(t))
            media.release()
            return out
        except Exception:
            return []

    def select_subtitle(self, index):
        try:
            self.engine.player.video_set_spu(int(index))
            return True
        except Exception:
            return False

    def disable_subtitle(self):
        return self.select_subtitle(-1)

    def screenshot(self, dest_path):
        try:
            self.engine.snapshot(dest_path)
            return dest_path if os.path.isfile(dest_path) else None
        except Exception:
            return None


def _scan_pngs(d):
    """列出目录里的 png → {文件名: (mtime_ns, 大小)}。

    为什么不能只比文件名：snapshot 插件的计数器是**每进程**的，新起一次播放器
    又从 `snapshot_0001.png` 开始，会**覆盖**上一轮留在白名单目录里的同名文件
    （实测：第二次截图时"没有新文件"→ 误报失败）。所以必须比 mtime+大小。
    """
    out = {}
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for f in names:
        if not f.lower().endswith('.png'):
            continue
        try:
            st = os.stat(os.path.join(d, f))
        except OSError:
            continue
        out[f] = (st.st_mtime_ns, st.st_size)
    return out


class PluginPlayerKernel(Kernel):
    def __init__(self, engine, proc, snapshot_dir):
        super().__init__(KERNEL_PP, engine, proc=proc, snapshot_dir=snapshot_dir,
                         caps={'embed': False, 'externalFullscreen': True,
                               'subtitleTracks': True, 'disableSubtitle': False})
        self._sub_index = []      # subtitle_tracks() 返回顺序 → 真实流 index

    def set_external_fullscreen(self, on):
        try:
            self.engine.setFullscreen(bool(on))
            return True
        except Exception:
            return False

    def subtitle_tracks(self, media_path):
        try:
            tr = self.engine.tracks() or {}
        except Exception:
            return []
        subs = tr.get('subtitle') or []
        self._sub_index = []
        names = []
        for t in subs:
            if not isinstance(t, dict):
                continue
            self._sub_index.append(t.get('index'))
            label = t.get('title') or t.get('lang') or t.get('codec') or '字幕'
            names.append(f"{label}（{t.get('codec', '?')}）")
        return names

    def select_subtitle(self, index):
        try:
            real = self._sub_index[int(index)]
        except (IndexError, ValueError, TypeError):
            return False
        try:
            self.engine.selectTrack(AVMEDIA_TYPE_SUBTITLE, real)
            return True
        except Exception:
            return False

    def screenshot(self, dest_path):
        """先落白名单目录，再复制到目标路径 —— 绕开插件写入白名单。

        插件只认 `--write-dir` 里的目录（`src/core/host.cpp:539`），且文件名由它
        自己按 `snapshot_NNNN.png` 递增生成，调用方给的路径对它没有意义。
        所以这里是"丢一张到白名单目录 → 找出那一张 → 复制到用户要的位置"。
        """
        d = self.snapshot_dir
        if not d:
            return None
        os.makedirs(d, exist_ok=True)
        before = _scan_pngs(d)
        try:
            self.engine.snapshot(os.path.join(d, 'daily.png'))
        except Exception:
            return None
        src = None
        for _ in range(30):                     # 最多等 3s 让文件落盘
            time.sleep(0.1)
            now = _scan_pngs(d)
            changed = [f for f, sig in now.items() if before.get(f) != sig]
            if changed:
                # 多张同时变 → 取最新的那张
                src = os.path.join(d, max(changed, key=lambda f: now[f][0]))
                break
        if not src:
            return None
        try:
            os.makedirs(os.path.dirname(os.path.abspath(dest_path)) or '.', exist_ok=True)
            shutil.copyfile(src, dest_path)
        except OSError:
            # 复制不过去就如实返回白名单里的原件，别谎报成功
            return src
        try:
            os.remove(src)      # 中转件是内部产物，别在用户目录里积垃圾（每张几 MB）
        except OSError:
            pass
        return dest_path


# ---------------------------------------------------------------- 工厂

def default_snapshot_dir():
    """截图白名单目录（pluginplayer 内核用）。放在用户目录下，避免污染仓库。"""
    base = os.environ.get('DAILY_PLAYER_SNAP_DIR')
    if base:
        return base
    return os.path.join(os.path.expanduser('~'), '.daily_player_snapshots')


def create_kernel(requested=DEFAULT_KERNEL, cfg=None, video_frame_id=None):
    """按请求创建内核。返回 (Kernel, 说明字符串)；失败返回 (None, 原因)。

    不抛异常 —— 调用方（UI）拿到 (None, 原因) 后提示用户即可。
    """
    cfg = cfg or {}
    req = requested or cfg.get('kernel') or DEFAULT_KERNEL
    pp_exe = find_pluginplayer_exe()
    vlc_ok = vlc_available()
    name, why = choose_kernel(req, pp_exe=pp_exe, vlc_ok=vlc_ok)
    if name is None:
        return None, why

    if name == KERNEL_VLC:
        try:
            import vlc
            instance = vlc.Instance()
            if instance is None:
                return None, 'vlc.Instance() 返回 None'
            player = instance.media_player_new()
        except Exception as e:
            return None, f'初始化 libVLC 失败: {e}'
        from player_engine import VlcPlayerEngine
        eng = VlcPlayerEngine(instance, player)
        k = VlcKernel(eng, instance=instance)
        if video_frame_id is not None:
            k.attach_window(video_frame_id)
        return k, why

    # pluginplayer
    snap = default_snapshot_dir()
    proc = PluginPlayerProcess(pp_exe, snap)
    try:
        eng = proc.start()
    except Exception as e:
        return None, f'启动 pluginplayer 失败: {e}'
    return PluginPlayerKernel(eng, proc, snap), why
