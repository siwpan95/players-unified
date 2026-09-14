"""daily_player → PluginPlayer 控制通道的 PlayerEngine 适配器（Phase 4 / S0）。

把 PluginPlayer 的控制通道（TCP + 换行分隔 JSON-RPC，见
`pluginplayer/src/core/control.cpp` 与 `pluginplayer/host-js/src/player-service.mjs`）
适配成 ARCHITECTURE §3 的 `PlayerEngine` 端口，使 daily_player 的 UI 可以在
**不改动 UI 代码**的前提下，把底层引擎从 libVLC 换成 PluginPlayer（内核替换）。

与 JS 版 `pluginplayer/host-js/player-engine.mjs` 的换算保持一致：
  - `seek(ms)`      → `player.seek {seconds}`，毫秒 → 秒
  - `setVolume(v)`  → `player.volume {value}`，0..100 → 0..1
  - `setRate(r)`    → `player.speed {value}`
  - `snapshot(path)`→ `command.invoke {name:'snapshot', args:[dir]}`
                      （原生命令收的是**目录**，见 src/plugins/snapshot/plugin.cpp:196）

与 JS 版同样的取舍：
  - `volume / muted / fullscreen` 控制通道**没有 getter**（player.stats 不含这三项），
    由本适配器本地跟踪（经自身 setter 更新）。
  - `fullscreen` 控制通道没有对应的 method，无法真正切换远端窗口全屏（已知缺口）。

协议要点：连接后**第一条消息必须是 auth**，否则任何调用都会被拒。
"""

import json
import os
import socket
import threading

from player_engine import clamp_rate, clamp_volume  # 夹紧逻辑与引擎无关，复用同一份

DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 7911
DEFAULT_TOKEN_FILE = os.path.join('pluginplayer', 'dist', 'config', 'rpc-token.txt')


def dirname(p):
    """取路径的目录部分（支持 / 与 \\）。无分隔符时返回 ''。"""
    s = str(p or '')
    i = max(s.rfind('/'), s.rfind('\\'))
    return s[:i] if i >= 0 else ''


class RpcError(RuntimeError):
    """控制通道返回 ok:false，或连接 / 认证失败。"""


class ControlChannel:
    """PluginPlayer 控制通道的最小客户端（阻塞式请求-响应）。

    单连接复用；读取时会跳过服务端主动推来的事件帧（带 `event` 字段），
    只取与当前请求 id 匹配的响应。
    """

    def __init__(self, host=DEFAULT_HOST, port=DEFAULT_PORT, token=None,
                 token_file=None, timeout=5.0):
        self.host = host
        self.port = port
        self.token = token
        self.token_file = token_file
        self.timeout = timeout
        self.sock = None
        self._buf = b''
        self._next_id = 1
        self._next_id_lock = threading.Lock()
        self.authed = False
        self.events = []          # 已收到的事件帧 [{'topic':..., 'data':...}]
        self._handlers = []       # 事件回调（onEvent 注册）
        self._events_lock = threading.Lock()
        self._last = None         # _handle_line 解析出的响应帧

    # ---- 令牌解析：显式 token > 环境变量 > 令牌文件 ----
    def resolve_token(self):
        if self.token:
            return str(self.token).strip()
        env = (os.environ.get('PP_RPC_TOKEN') or '').strip()
        if env:
            return env
        path = self.token_file or DEFAULT_TOKEN_FILE
        if not os.path.isabs(path):
            # 相对路径按仓库根解析
            root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            path = os.path.join(root, path)
        with open(path, 'r', encoding='utf-8') as f:
            return f.read().strip()

    def connect(self):
        if self.sock:
            return self
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.sock.settimeout(self.timeout)
        result = self.call('auth', {'token': self.resolve_token()})
        self.authed = bool(result)
        return self

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None
        self.authed = False

    # ---- 底层收发 ----
    def _send(self, obj):
        self.sock.sendall((json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8'))

    def _read_line(self):
        """读一整行（以 \\n 结尾），返回 bytes（不含换行）；超时抛 RpcError。"""
        while b'\n' not in self._buf:
            try:
                chunk = self.sock.recv(4096)
            except socket.timeout:
                raise RpcError('控制通道读取超时')
            if not chunk:
                raise RpcError('控制通道已断开')
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b'\n')
        return line

    # ---- 事件（服务端主动推送 {"event":"<topic>","data":{...}}）----
    def _handle_line(self, line):
        """消化一帧。事件帧 → 入队并返回 True；响应帧 → 存 self._last 返回 False。"""
        line = (line or b'').strip()
        if not line:
            return False
        try:
            msg = json.loads(line.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(msg, dict):
            return False
        if 'event' in msg:
            ev = {'topic': msg.get('event'), 'data': msg.get('data')}
            with self._events_lock:
                self.events.append(ev)
            for h in list(self._handlers):
                try:
                    h(ev)
                except Exception:
                    pass          # 回调异常不能影响收包
            return True
        self._last = msg
        return False

    def subscribe(self, topic='*'):
        """订阅主题。'*' 表示全部（服务端实现：'*' 会清空过滤表 → 收全部）。"""
        return self.call('topic.subscribe', {'topic': topic})

    def pump(self, timeout=0.0):
        """把已到达的帧消化掉（不等待响应）。timeout=0 时非阻塞。

        返回本次收到的事件数。用于 UI 主循环里取 subtitle.line 之类的推送。
        """
        if not self.sock:
            return 0
        n = 0
        old = self.sock.gettimeout()
        try:
            self.sock.settimeout(timeout if timeout and timeout > 0 else 0.0)
            while True:
                line = None
                if b'\n' in self._buf:
                    line, _, self._buf = self._buf.partition(b'\n')
                else:
                    try:
                        chunk = self.sock.recv(65536)
                    except (socket.timeout, BlockingIOError, OSError):
                        break
                    if not chunk:
                        break
                    self._buf += chunk
                    continue
                if self._handle_line(line):
                    n += 1
        finally:
            self.sock.settimeout(old)
        return n

    def onEvent(self, handler):
        """注册事件回调；返回一个可调用的注销函数。"""
        self._handlers.append(handler)

        def _un():
            try:
                self._handlers.remove(handler)
            except ValueError:
                pass
        return _un

    def takeEvents(self, topic=None):
        """取走并清空已缓存的事件（可按 topic 过滤）。"""
        with self._events_lock:
            out = [e for e in self.events if topic is None or e.get('topic') == topic]
            self.events = [e for e in self.events if topic is not None and e.get('topic') != topic]
        return out

    def call(self, method, params=None):
        """发起一次调用，返回结果；ok:false 抛 RpcError。"""
        if not self.sock:
            raise RpcError('未连接到控制通道（先用 connect()，或确认播放器带 --rpc-port 启动）')
        with self._next_id_lock:
            mid = self._next_id
            self._next_id += 1
        self._send({'id': mid, 'method': method, 'params': params or {}})

        while True:
            if self._handle_line(self._read_line()):
                continue                      # 事件帧：与本调用无关，已入队
            msg = self._last
            if not msg or msg.get('id') != mid:
                continue
            if not msg.get('ok'):
                raise RpcError(msg.get('error') or f'{method} 失败')
            return msg.get('result')


class PluginPlayerRpcEngine:
    """把控制通道适配成 PlayerEngine（与 VlcPlayerEngine 同一端口）。"""

    def __init__(self, rpc):
        self.rpc = rpc
        self._volume = 100
        self._muted = False
        self._fullscreen = False

    @classmethod
    def connect(cls, host=DEFAULT_HOST, port=DEFAULT_PORT, token=None, token_file=None):
        rpc = ControlChannel(host=host, port=port, token=token, token_file=token_file)
        rpc.connect()
        return cls(rpc)

    # ---- PlayerEngine 端口 ----
    def load(self, item):
        uri = item['uri'] if isinstance(item, dict) else str(item)
        self.rpc.call('player.open', {'path': uri})
        return self

    def play(self):
        self.rpc.call('player.play')
        return self

    def pause(self):
        self.rpc.call('player.pause')
        return self

    def seek(self, ms):
        try:
            n = float(ms)
        except (TypeError, ValueError):
            n = 0.0
        if n != n:
            n = 0.0
        self.rpc.call('player.seek', {'seconds': max(0.0, n) / 1000.0})
        return self

    def setRate(self, rate):
        self.rpc.call('player.speed', {'value': clamp_rate(rate)})
        return self

    def setVolume(self, vol):
        self._volume = clamp_volume(vol)
        self.rpc.call('player.volume', {'value': self._volume / 100.0})
        return self

    def setMuted(self, muted):
        self._muted = bool(muted)
        self.rpc.call('player.mute', {'value': self._muted})
        return self

    def snapshot(self, path):
        """经原生 snapshot 命令落盘（该命令收的是目录，文件名为 snapshot_0001.png 递增）。

        **写入白名单（S1 实测确认）**：宿主只允许插件写到 exeDir，
        写到别处会被 `Host::isWriteAllowed` 拒（host.cpp:539）。
        要写到播放器目录之外，启动时必须显式加 `--write-dir <DIR>`。
        """
        d = dirname(path)
        return self.rpc.call('command.invoke',
                             {'name': 'snapshot', 'args': [d] if d else []})

    def getState(self):
        st = self.rpc.call('player.stats') or {}
        try:
            pos = float(st.get('position') or 0)
        except (TypeError, ValueError):
            pos = 0.0
        try:
            dur = float(st.get('duration') or 0)
        except (TypeError, ValueError):
            dur = 0.0
        try:
            rate = float(st.get('speed') or 0)
        except (TypeError, ValueError):
            rate = 0.0
        return {
            'playing': not bool(st.get('paused')),
            'timeMs': int(round(pos * 1000)),
            'durationMs': int(round(dur * 1000)) if dur > 0 else None,
            'rate': rate if rate > 0 else 1.0,
            'volume': self._volume,      # 控制通道无 getter → 本地跟踪
            'muted': self._muted,
            'fullscreen': self._fullscreen,
        }

    # ---- PluginPlayer 额外能力（端口之外的便利方法）----
    def stop(self):
        self.rpc.call('player.stop')
        return self

    def info(self):
        """player.info：容器/编解码/分辨率/时长等。"""
        return self.rpc.call('player.info')

    def tracks(self):
        """返回 {video:[...], audio:[...], subtitle:[...]}。"""
        return self.rpc.call('player.tracks')

    def loadSubtitle(self, path):
        """外挂字幕：走 subtitles 插件的 subtitle.load 命令（内核真正加载）。

        加载后内核会在每帧算当前行并广播 `subtitle.line` 事件
        （app.cpp:943-955），外部 UI 订阅该主题即可自己画字幕。
        """
        return self.rpc.call('command.invoke',
                             {'name': 'subtitle.load', 'args': [str(path)]})

    def takeEvents(self, topic=None):
        """取走并清空已缓存的事件（可按 topic 过滤），见 ControlChannel.takeEvents。"""
        return self.rpc.takeEvents(topic)

    def selectTrack(self, type_, index):
        return self.rpc.call('player.select_track', {'type': int(type_), 'index': int(index)})

    def invoke(self, name, args=None):
        return self.rpc.call('command.invoke', {'name': name, 'args': args or []})
