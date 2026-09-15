"""daily_player 内核选择/门面测试（Phase 4：默认内核切到 PluginPlayer）。

零三方依赖、无 GUI、不联网、不启动真实播放器：
- 决策逻辑（choose_kernel）当纯函数测；
- exe 查找、命令行拼装、截图中转用临时目录测；
- 内核门面用假 engine 测。
"""

import os
import sys
import socket
import json
import tempfile
import threading

_DP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _DP)

import kernel as K                                     # noqa: E402


class _FakeControlServer:
    """极简控制通道服务端（TCP + 换行分隔 JSON，强制先 auth）。

    只为验证 PluginPlayerProcess.connect_engine 的接线是否正确，
    不是完整协议实现 —— 够用即可。
    """

    def __init__(self, token='dp-token-0123456789'):
        self.token = token
        self.calls = []
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(('127.0.0.1', 0))
        self._sock.listen(4)
        self.port = self._sock.getsockname()[1]
        self._stop = False
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
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
                self.calls.append((method, params))
                if method == 'auth' and params.get('token') != self.token:
                    conn.sendall((json.dumps({'id': mid, 'ok': False,
                                              'error': '令牌错误'}) + '\n').encode('utf-8'))
                    return
                authed = authed or method == 'auth'
                if not authed:
                    conn.sendall((json.dumps({'id': mid, 'ok': False,
                                              'error': '未认证'}) + '\n').encode('utf-8'))
                    continue
                conn.sendall((json.dumps({'id': mid, 'ok': True,
                                          'result': {'auth': True}}) + '\n').encode('utf-8'))
        except (OSError, ValueError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def has(self, method, params=None):
        return any(m == method and (params is None or p == params) for m, p in self.calls)

    def close(self):
        self._stop = True
        try:
            self._sock.close()
        except OSError:
            pass


def main():
    fails = []

    def check(name, cond, detail=''):
        if cond:
            print(f'  ✅ {name}' + (f' — {detail}' if detail else ''))
        else:
            fails.append(name)
            print(f'  ❌ {name}' + (f' — {detail}' if detail else ''))

    print('[test] daily_player 内核选择与门面')

    # ---------------------------------------------------------- 1. 决策矩阵
    print('\n[1] choose_kernel 决策')
    check('默认（有 pp）→ pluginplayer',
          K.choose_kernel(None, pp_exe='X:/pp.exe', vlc_ok=True)[0] == K.KERNEL_PP)
    check('默认（无 pp、有 vlc）→ 失败而非静默回落',
          K.choose_kernel(None, pp_exe=None, vlc_ok=True)[0] is None,
          str(K.choose_kernel(None, pp_exe=None, vlc_ok=True)[1]))
    check('auto（无 pp、有 vlc）→ vlc',
          K.choose_kernel('auto', pp_exe=None, vlc_ok=True)[0] == K.KERNEL_VLC)
    check('auto（无 pp、无 vlc）→ 失败',
          K.choose_kernel('auto', pp_exe=None, vlc_ok=False)[0] is None)
    check('显式 vlc 但不可用 → 失败',
          K.choose_kernel('vlc', pp_exe='X:/pp.exe', vlc_ok=False)[0] is None)
    check('显式 vlc 且可用 → vlc',
          K.choose_kernel('vlc', pp_exe='X:/pp.exe', vlc_ok=True)[0] == K.KERNEL_VLC)
    check('别名 pp → pluginplayer',
          K.choose_kernel('pp', pp_exe='X:/pp.exe', vlc_ok=False)[0] == K.KERNEL_PP)
    check('别名 libvlc → vlc',
          K.choose_kernel('libvlc', pp_exe=None, vlc_ok=True)[0] == K.KERNEL_VLC)
    bad, why = K.choose_kernel('mpv', pp_exe='X:/pp.exe', vlc_ok=True)
    check('未知内核名 → 失败并给出可选项', bad is None and 'mpv' in why, why)
    check('大小写/空格不敏感',
          K.choose_kernel('  PluginPlayer ', pp_exe='X:/pp.exe', vlc_ok=False)[0] == K.KERNEL_PP)

    # ---------------------------------------------------------- 2. exe 查找
    print('\n[2] find_pluginplayer_exe')
    with tempfile.TemporaryDirectory() as td:
        fake = os.path.join(td, 'pluginplayer.exe')
        with open(fake, 'w') as f:
            f.write('stub')
        old = os.environ.get(K._EXE_ENV)
        try:
            os.environ[K._EXE_ENV] = fake
            check('环境变量优先', K.find_pluginplayer_exe() == fake, fake)
            os.environ[K._EXE_ENV] = os.path.join(td, 'nope.exe')
            check('环境变量指向不存在的文件 → 继续找候选',
                  K.find_pluginplayer_exe(extra_candidates=[fake]) == fake)
            os.environ[K._EXE_ENV] = '"' + fake + '"'
            check('环境变量带引号也能识别', K.find_pluginplayer_exe() == fake)
        finally:
            if old is None:
                os.environ.pop(K._EXE_ENV, None)
            else:
                os.environ[K._EXE_ENV] = old

    # ---------------------------------------------------------- 3. 启动命令行
    print('\n[3] PluginPlayerProcess.build_cmd')
    with tempfile.TemporaryDirectory() as td:
        snap = os.path.join(td, 'snap')
        p = K.PluginPlayerProcess('X:/pp.exe', snap, extra_write_dirs=['D:/media'])
        cmd = p.build_cmd(7911, 'tok-0123456789abcdef')
        check('包含 --hidden（无人值守，不弹窗）', '--hidden' in cmd)
        check('端口/令牌正确传入',
              cmd[cmd.index('--rpc-port') + 1] == '7911'
              and cmd[cmd.index('--rpc-token') + 1] == 'tok-0123456789abcdef')
        check('截图目录进写入白名单',
              cmd[cmd.index('--write-dir') + 1] == snap)
        check('额外白名单目录也传入', 'D:/media' in cmd)
        check('build_cmd 会创建截图目录', os.path.isdir(snap))

    # ---------------------------------------------------------- 4. 假内核对象
    print('\n[4] 测试替身（无输出，仅为 [5]/[6] 提供假 engine）')

    class FakeRpcEngine:
        """假控制通道引擎（只实现本测试用到的方法）。"""

        def __init__(self):
            self.ops = []
            self.player = object()          # 仅用于验证 VlcKernel 不走这条路
            self.shot_n = 0

        def tracks(self):
            return {'video': [{'index': 0}],
                    'audio': [{'index': 1}],
                    # 三条轨各覆盖回落链的一级：title / lang / codec
                    'subtitle': [{'index': 2, 'codec': 'subrip', 'lang': 'chi', 'title': '简体'},
                                 {'index': 3, 'codec': 'ass', 'lang': '', 'title': ''},
                                 {'index': 4, 'codec': 'subrip', 'lang': 'eng', 'title': ''}]}

        def selectTrack(self, t, i):
            self.ops.append(('select_track', t, i))

        def setFullscreen(self, on):
            if getattr(self, 'fs_raises', False):
                raise RuntimeError('--hidden 下无可见窗口')
            self.ops.append(('fullscreen', on))

        def snapshot(self, path):
            # 忠实模仿原生 snapshot 命令：**自己**在目录里按计数器命名，
            # 计数器是每进程的（新进程从 0001 重新开始 → 会覆盖同名旧文件）。
            self.shot_n += 1
            name = 'snapshot_%04d.png' % self.shot_n
            with open(os.path.join(os.path.dirname(path), name), 'wb') as f:
                f.write(b'PNGDATA' + b'\x00' * self.shot_n)   # 每次大小都不同
            self.ops.append(('snapshot', path))

    # ---------------------------------------------------------- 5. PluginPlayer 门面
    print('\n[5] PluginPlayerKernel 能力与补差')
    with tempfile.TemporaryDirectory() as td:
        eng = FakeRpcEngine()
        k = K.PluginPlayerKernel(eng, proc=None, snapshot_dir=td)
        check('caps.embed=False（画面不在 tk 窗口）', k.caps['embed'] is False)
        check('caps.externalFullscreen=True', k.caps['externalFullscreen'] is True)
        check('caps.disableSubtitle=False（RPC 不接受 -1）',
              k.caps['disableSubtitle'] is False)
        check('attach_window 明确返回 False', k.attach_window(12345) is False)
        check('set_external_fullscreen 成功', k.set_external_fullscreen(True) is True)
        eng.fs_raises = True
        check('--hidden 下 set_external_fullscreen 返回 False（不假装成功）',
              k.set_external_fullscreen(True) is False)
        eng.fs_raises = False

        names = k.subtitle_tracks('ignored.mp4')
        check('subtitle_tracks 取 title 优先', names[0].startswith('简体'), str(names))
        check('subtitle_tracks 无 title 时回落 lang',
              names[2].startswith('eng'), str(names))
        check('subtitle_tracks 无 title/lang 时回落 codec',
              names[1].startswith('ass'), str(names))
        check('select_subtitle(0) → 真实流 index 2',
              k.select_subtitle(0) and ('select_track', 3, 2) in eng.ops, str(eng.ops[-1:]))
        check('select_subtitle(1) → 真实流 index 3',
              k.select_subtitle(1) and ('select_track', 3, 3) in eng.ops, str(eng.ops[-1:]))
        check('select_subtitle(2) → 真实流 index 4',
              k.select_subtitle(2) and ('select_track', 3, 4) in eng.ops, str(eng.ops[-1:]))
        check('select_subtitle 越界 → False', k.select_subtitle(9) is False)
        check('disable_subtitle → False（能力不支持）', k.disable_subtitle() is False)

        dest = os.path.join(td, 'out', 'movie_snapshot.png')
        got = k.screenshot(dest)
        check('screenshot 中转：落到目标路径', got == dest and os.path.isfile(dest),
              str(got))
        with open(dest, 'rb') as f:
            check('screenshot 内容正确复制', f.read().startswith(b'PNGDATA'))
        check('中转件已清理（不留垃圾）',
              not [f for f in os.listdir(td) if f.lower().endswith('.png')],
              str(os.listdir(td)))

        # 回归：新进程计数器归零，会**覆盖**上一轮留下的同名文件。
        # 只比文件名的实现会误判"没有新文件"→ 截图失败（GUI 冒烟实测踩到）。
        eng2 = FakeRpcEngine()                 # 新"进程"：计数器从 0001 重来
        k2 = K.PluginPlayerKernel(eng2, proc=None, snapshot_dir=td)
        dest2 = os.path.join(td, 'out2', 'again.png')
        # 先塞一个与将来同名的旧文件，制造"名字没变"的场景
        with open(os.path.join(td, 'snapshot_0001.png'), 'wb') as f:
            f.write(b'OLD')
        got2 = k2.screenshot(dest2)
        check('同名覆盖（计数器归零）时仍能拿到截图',
              got2 == dest2 and os.path.isfile(dest2), str(got2))
        if os.path.isfile(dest2):
            with open(dest2, 'rb') as f:
                check('拿到的是新内容而不是旧文件', f.read().startswith(b'PNGDATA'))

    # ---------------------------------------------------------- 6. VlcKernel 门面
    print('\n[6] VlcKernel 能力与补差')

    class FakeVlcMedia:
        def sub_description_get(self):
            return [b'\xe7\xae\x80\xe4\xbd\x93', 'English']

        def release(self):
            self.released = True

    class FakeVlcInstance:
        def __init__(self):
            self.media = None

        def media_new(self, path):
            self.last_path = path
            self.media = FakeVlcMedia()
            return self.media

    class FakeVlcPlayer:
        def __init__(self):
            self.spu = None
            self.hwnd = None

        def set_hwnd(self, h):
            self.hwnd = h

        def video_set_spu(self, i):
            self.spu = i

    class FakeVlcEngine:
        def __init__(self):
            self.player = FakeVlcPlayer()
            self.taken = None

        def snapshot(self, path):
            with open(path, 'wb') as f:
                f.write(b'VLC')
            self.taken = path
            return 0

    inst = FakeVlcInstance()
    ve = FakeVlcEngine()
    vk = K.VlcKernel(ve, instance=inst)
    check('caps.embed=True', vk.caps['embed'] is True)
    check('caps.externalFullscreen=False（画面在面板里，不需要）',
          vk.caps['externalFullscreen'] is False)
    check('caps.disableSubtitle=True', vk.caps['disableSubtitle'] is True)
    check('attach_window 调 set_hwnd', vk.attach_window(999) and ve.player.hwnd == 999)
    names = vk.subtitle_tracks('a.mkv')
    check('subtitle_tracks 解码 bytes 并保留 str', names == ['简体', 'English'], str(names))
    check('subtitle_tracks 释放了 media 对象', getattr(inst.media, 'released', False) is True)
    check('select_subtitle 调 video_set_spu', vk.select_subtitle(1) and ve.player.spu == 1)
    check('disable_subtitle → spu=-1', vk.disable_subtitle() and ve.player.spu == -1)
    check('set_external_fullscreen 不适用 → False', vk.set_external_fullscreen(True) is False)
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, 'shot.png')
        check('screenshot 直接落目标路径', vk.screenshot(p) == p and os.path.isfile(p))

    # ---------------------------------------------------------- 7. 快照目录
    print('\n[7] default_snapshot_dir')
    old = os.environ.get('DAILY_PLAYER_SNAP_DIR')
    try:
        os.environ['DAILY_PLAYER_SNAP_DIR'] = 'X:/snaps'
        check('环境变量可覆盖', K.default_snapshot_dir() == 'X:/snaps')
    finally:
        if old is None:
            os.environ.pop('DAILY_PLAYER_SNAP_DIR', None)
        else:
            os.environ['DAILY_PLAYER_SNAP_DIR'] = old
    check('默认落在用户目录（不污染仓库）',
          K.default_snapshot_dir().startswith(os.path.expanduser('~')))

    # ---------------------------------------------------------- 8. 门面转发
    print('\n[8] Kernel 属性转发到 engine')
    with tempfile.TemporaryDirectory() as td:
        class WithPort:
            def __init__(self):
                self.calls = []

            def play(self):
                self.calls.append('play')

            def seek(self, ms):
                self.calls.append(('seek', ms))

        eng2 = WithPort()
        k2 = K.Kernel(K.KERNEL_PP, eng2)
        k2.play()
        k2.seek(1500)
        check('端口方法经门面直达 engine', eng2.calls == ['play', ('seek', 1500)], str(eng2.calls))
        try:
            k2.noSuchThing
            check('未知属性抛 AttributeError', False, '竟然没抛')
        except AttributeError:
            check('未知属性抛 AttributeError', True)

    # ---------------------------------------------------------- 9. 控制通道接线
    print('\n[9] PluginPlayerProcess.connect_engine 接线（假控制通道）')
    srv = _FakeControlServer()
    try:
        p2 = K.PluginPlayerProcess('X:/pp.exe', tempfile.gettempdir())
        p2.port = srv.port
        p2.token = 'dp-token-0123456789'
        eng9 = p2.connect_engine()
        check('先 auth 再用令牌', srv.has('auth', {'token': 'dp-token-0123456789'}))
        check('connect_engine 订阅 app.fullscreen（否则收不到事件）',
              srv.has('topic.subscribe', {'topic': 'app.fullscreen'}))
        check('订阅清单落在 engine 上',
              eng9.subscribed == ['app.fullscreen'], str(eng9.subscribed))
        check('返回的是真实适配器（有 getState）', callable(getattr(eng9, 'getState', None)))
    finally:
        srv.close()

    if fails:
        print(f'\n[test] 断言失败 ❌: {fails}')
        return 1
    print('[test] daily_player 内核选择与门面 全部断言通过 ✅')
    return 0


if __name__ == '__main__':
    sys.exit(main())
