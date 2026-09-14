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
        self.authed = False

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

    def call(self, method, params=None):
        """发起一次调用，返回结果；ok:false 抛 RpcError。"""
        if not self.sock:
            raise RpcError('未连接到控制通道（先用 connect()，或确认播放器带 --rpc-port 启动）')
        mid = self._next_id
        self._next_id += 1
        self._send({'id': mid, 'method': method, 'params': params or {}})

        while True:
            line = self._read_line().strip()
            if not line:
                continue
            try:
                msg = json.loads(line.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                continue
            # 服务端主动推送的事件帧：与本次调用无关，跳过
            if 'event' in msg:
                continue
            if msg.get('id') != mid:
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
        """经原生 snapshot 命令落盘（该命令收的是目录）。"""
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

    def tracks(self):
        """返回 {video:[...], audio:[...], subtitle:[...]}。"""
        return self.rpc.call('player.tracks')

    def selectTrack(self, type_, index):
        return self.rpc.call('player.select_track', {'type': int(type_), 'index': int(index)})

    def invoke(self, name, args=None):
        return self.rpc.call('command.invoke', {'name': name, 'args': args or []})
