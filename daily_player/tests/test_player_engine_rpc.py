"""daily_player → PluginPlayer 控制通道适配器测试（Phase 4 / S0）。

用**真实的 TCP 假控制通道**（同样的「换行分隔 JSON + 先 auth」协议，
见 pluginplayer/src/core/control.cpp）驱动真实适配器，做协议级验证：
不只是 mock 函数调用，而是连认证、分帧、事件帧跳过一起验证。

零三方依赖，用 F:/Python314/python.exe 直跑。

运行：F:/Python314/python.exe daily_player/tests/test_player_engine_rpc.py
"""
import json
import os
import socket
import sys
import threading

def _find_repo_root(start):
    cur = os.path.abspath(start)
    while True:
        if os.path.isfile(os.path.join(cur, 'schema', 'media-item.schema.json')):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            raise RuntimeError('repo root not found')
        cur = parent

ROOT = _find_repo_root(__file__)
sys.path.insert(0, os.path.join(ROOT, 'schema'))
sys.path.insert(0, os.path.join(ROOT, 'daily_player'))

from validate import validate, load_schema                    # noqa: E402
from player_engine_rpc import (                                # noqa: E402
    PluginPlayerRpcEngine, ControlChannel, RpcError, dirname,
)

SCHEMA = load_schema()
STATE_SCHEMA = SCHEMA['definitions']['PlayerState']

STATS = {'position': 12.34, 'duration': 60.0, 'speed': 1.5, 'paused': 0}


class FakeControlServer:
    """最小控制通道服务端：TCP + 换行分隔 JSON，强制先 auth。"""

    def __init__(self, token='tok', stats=None):
        self.token = token
        self.stats = stats or dict(STATS)
        self.calls = []
        self.push_event = None          # 若设置，每次响应前先推一帧事件
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(('127.0.0.1', 0))
        self._sock.listen(8)
        self.port = self._sock.getsockname()[1]
        self._stop = False
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while not self._stop:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        buf = b''
        authed = False
        try:
            while True:
                while b'\n' not in buf:
                    chunk = conn.recv(4096)
                    if not chunk:
                        return
                    buf += chunk
                line, _, buf = buf.partition(b'\n')
                if not line.strip():
                    continue
                msg = json.loads(line.decode('utf-8'))
                mid, method = msg.get('id'), msg.get('method')
                params = msg.get('params') or {}

                if self.push_event:
                    conn.sendall((json.dumps(self.push_event) + '\n').encode('utf-8'))

                if method == 'auth':
                    # 与其它 method 保持一致，统一记为 (method, params)
                    self.calls.append(('auth', params))
                    if params.get('token') == self.token:
                        authed = True
                        self._ok(conn, mid, {'authed': True})
                    else:
                        self._err(conn, mid, '令牌错误')
                        return
                elif not authed:
                    self._err(conn, mid, '未认证：请先发送 auth')
                else:
                    self.calls.append((method, params))
                    self._ok(conn, mid, self._result(method))
        except (OSError, ValueError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _ok(self, conn, mid, result):
        conn.sendall((json.dumps({'id': mid, 'ok': True, 'result': result}) + '\n').encode('utf-8'))

    def _err(self, conn, mid, error):
        conn.sendall((json.dumps({'id': mid, 'ok': False, 'error': error}) + '\n').encode('utf-8'))

    def _result(self, method):
        if method == 'player.stats':
            return self.stats
        if method == 'player.open':
            return {'opened': True}
        if method in ('player.play', 'player.pause', 'player.stop', 'player.toggle'):
            return {'paused': 0, 'position': 0.0}
        if method == 'command.invoke':
            return 0
        return {}

    def has(self, method, params=None):
        for m, p in self.calls:
            if m == method and (params is None or p == params):
                return True
        return False

    def close(self):
        self._stop = True
        try:
            self._sock.close()
        except OSError:
            pass


def assert_state_schema(st):
    validate(st, STATE_SCHEMA)
    assert set(st) == {'playing', 'timeMs', 'durationMs', 'rate', 'volume',
                       'muted', 'fullscreen'}, f"PlayerState 字段集不符: {sorted(st)}"
    assert isinstance(st['playing'], bool)
    assert isinstance(st['timeMs'], int)
    assert st['durationMs'] is None or isinstance(st['durationMs'], int)
    assert 0 <= st['volume'] <= 100


def main():
    # ---- 纯函数 ----
    assert dirname(r'C:\media\shot.png') == r'C:\media', 'dirname 应处理反斜杠'
    assert dirname('/media/shot.png') == '/media', 'dirname 应处理正斜杠'
    assert dirname('shot.png') == '', '无分隔符时 dirname 为空'

    # ---- 主流程：真实 TCP ----
    srv = FakeControlServer(token='tok-123')
    try:
        eng = PluginPlayerRpcEngine.connect(host='127.0.0.1', port=srv.port, token='tok-123')
        assert srv.has('auth', {'token': 'tok-123'}), 'connect() 应先用正确令牌 auth'

        item = {'id': 'x', 'uri': r'C:\media\movie.mkv', 'title': 'movie',
                'kind': 'video', 'source': 'local-file'}
        eng.load(item)
        assert srv.has('player.open', {'path': item['uri']}), 'load 应发 player.open(uri)'

        eng.play()
        eng.pause()
        assert srv.has('player.play') and srv.has('player.pause')

        # 毫秒 → 秒
        eng.seek(1500)
        assert srv.has('player.seek', {'seconds': 1.5}), 'seek(1500ms) 应换算为 seconds=1.5'
        eng.seek(-5)
        assert srv.has('player.seek', {'seconds': 0.0}), '负偏移应夹到 0'

        # 倍速夹紧
        eng.setRate(5)
        assert srv.has('player.speed', {'value': 3.0}), 'setRate(5) 应夹到 3.0'
        eng.setRate(0.1)
        assert srv.has('player.speed', {'value': 0.25}), 'setRate(0.1) 应夹到 0.25'

        # 音量 0..100 → 0..1
        eng.setVolume(150)
        assert srv.has('player.volume', {'value': 1.0}), 'setVolume(150) 应夹到 1.0'
        eng.setVolume(42)
        assert srv.has('player.volume', {'value': 0.42}), 'setVolume(42) → 0.42'
        eng.setMuted(True)
        assert srv.has('player.mute', {'value': True}), 'setMuted(True) → mute(True)'

        # 截图 → 原生 snapshot 命令（收目录）
        eng.snapshot(r'C:\media\shot.png')
        assert srv.has('command.invoke', {'name': 'snapshot', 'args': [r'C:\media']}), \
            'snapshot 应调 command.invoke(snapshot, [dir])'

        # getState：由 stats 映射 + 本地跟踪的 volume/muted
        st = eng.getState()
        assert_state_schema(st)
        assert st['playing'] is True, 'paused=0 → playing true'
        assert st['timeMs'] == 12340, f"timeMs 应为 12340，实际 {st['timeMs']}"
        assert st['durationMs'] == 60000, f"durationMs 应为 60000，实际 {st['durationMs']}"
        assert st['rate'] == 1.5, 'rate 应取 stats.speed'
        assert st['volume'] == 42, 'volume 应取本地跟踪值'
        assert st['muted'] is True, 'muted 应取本地跟踪值'
        assert st['fullscreen'] is False, 'fullscreen 默认 False（RPC 无对应能力）'

        # 额外能力
        eng.stop()
        assert srv.has('player.stop')
        eng.selectTrack(2, 1)
        assert srv.has('player.select_track', {'type': 2, 'index': 1})
        eng.invoke('subtitle.load', [r'C:\media\a.srt'])
        assert srv.has('command.invoke', {'name': 'subtitle.load', 'args': [r'C:\media\a.srt']})
    finally:
        srv.close()

    # ---- 事件帧干扰：响应前插一帧 event，调用仍应正确返回 ----
    srv2 = FakeControlServer(token='t')
    srv2.push_event = {'event': 'player/media.opened', 'data': {'path': 'x'}}
    try:
        eng2 = PluginPlayerRpcEngine.connect(port=srv2.port, token='t')
        st2 = eng2.getState()          # 事件帧应被跳过，仍能拿到 stats 响应
        assert_state_schema(st2)
        assert st2['timeMs'] == 12340, '事件帧不应干扰请求-响应匹配'
    finally:
        srv2.close()

    # ---- 错误令牌：应抛 RpcError ----
    srv3 = FakeControlServer(token='right')
    try:
        raised = False
        try:
            PluginPlayerRpcEngine.connect(port=srv3.port, token='wrong')
        except RpcError:
            raised = True
        assert raised, '错误令牌应抛 RpcError'
    finally:
        srv3.close()

    # ---- duration=0 → durationMs=None；paused=1 → playing=False ----
    srv4 = FakeControlServer(token='t', stats={'position': 0, 'duration': 0, 'speed': 0, 'paused': 1})
    try:
        st4 = PluginPlayerRpcEngine.connect(port=srv4.port, token='t').getState()
        assert_state_schema(st4)
        assert st4['playing'] is False, 'paused=1 → playing false'
        assert st4['durationMs'] is None, 'duration=0 → durationMs None'
        assert st4['rate'] == 1.0, 'speed<=0 → rate 回落 1.0'
        assert st4['volume'] == 100, '未 setVolume 时默认 100'
    finally:
        srv4.close()

    print("[test] daily_player → PluginPlayer 控制通道适配器 全部断言通过 ✅  PlayerState 符合 schema")
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except AssertionError as e:
        print(f"[test] 断言失败 ❌  {e}")
        sys.exit(1)
    except RpcError as e:
        print(f"[test] 控制通道错误 ❌  {e}")
        sys.exit(1)
    except ValueError as e:
        print(f"[test] schema 校验失败 ❌  {e}")
        sys.exit(1)
