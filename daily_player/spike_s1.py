"""S1 / Phase 4 形态 A 尖峰：用 PluginPlayer 控制通道驱动一次真实播放（无人值守）。

目的：把「以 PluginPlayer 为内核换掉 libVLC」从纸面结论变成**实测数据**。
脚本会真的拉起 `pluginplayer.exe`（`--hidden`，不弹窗），连上控制通道，
逐项测量并把结果写成 JSON 报告。

测量项
------
1. 连接与认证：auth → ping，取 ABI 版本
2. RPC 延迟：ping / player.stats 各 N 次，统计 avg / p50 / p95 / max（毫秒）
3. 打开与进度：player.open → play → 轮询 stats，position 是否单调前进
4. 字幕链路：topic.subscribe(subtitle.line) → subtitle.load → 统计非空字幕事件
5. 截图链路：command.invoke(snapshot) → 是否真的落盘 PNG（含写入白名单验证）
6. 控制类：seek / speed / volume / mute / pause 的往返正确性
7. 端口契约：getState() 是否符合 schema/media-item.schema.json 的 PlayerState
8. S3 全屏：`app.fullscreen` 真实切换 + `app.fullscreen` 事件 + `--hidden` 下明确失败

用法
----
    F:/Python314/python.exe spike_s1.py                 # 用默认路径跑
    F:/Python314/python.exe spike_s1.py --exe <path> --media <path> --sub <path>
    F:/Python314/python.exe spike_s1.py --keep          # 跑完不退出播放器（人工观察）

退出码：0 = 全部通过；1 = 有断言失败；2 = 环境不具备（找不到 exe / 媒体）。
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from player_engine_rpc import ControlChannel, PluginPlayerRpcEngine, RpcError  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 默认路径：players-unified 的 .gitignore 排除了 dist/，构建产物在原仓库
DEFAULT_EXE = os.path.join(ROOT, 'pluginplayer', 'dist', 'pluginplayer.exe')
FALLBACK_EXE = r'G:\repos\pluginplayer\dist\pluginplayer.exe'
DEFAULT_MEDIA = r'G:\repos\pluginplayer\dist\test_assets\sample.mp4'
DEFAULT_SUB = r'G:\repos\pluginplayer\dist\selftest_out\selftest_sub.srt'


def percentile(sorted_vals, p):
    """最近秩百分位（p 取 0..100）。"""
    if not sorted_vals:
        return 0.0
    k = max(0, min(len(sorted_vals) - 1, int(round((p / 100.0) * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_port(port, deadline=40.0):
    """等控制通道开始 accept。

    冷启动要加载 11 个插件 + 1.6MB 字体，实测首次可达 10s 以上，
    所以默认留 40s（历史坑：给 15s 时误判成"端口没起来"）。
    """
    """等控制通道开始 accept。返回是否等到。"""
    end = time.time() + deadline
    while time.time() < end:
        try:
            c = socket.create_connection(('127.0.0.1', port), timeout=0.5)
            c.close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


class Spike:
    def __init__(self, args):
        self.args = args
        self.results = {}
        self.failures = []
        self.proc = None
        self.rpc = None
        self.engine = None
        self.subtitle_events = []

    # ---- 断言 ----
    def check(self, name, ok, detail=''):
        self.results[name] = {'ok': bool(ok), 'detail': detail}
        mark = '✅' if ok else '❌'
        print(f'  {mark} {name}' + (f' — {detail}' if detail else ''))
        if not ok:
            self.failures.append(f'{name}: {detail}')
        return ok

    # ---- 生命周期 ----
    def start_player(self):
        exe = self.args.exe
        port = self.args.port or free_port()
        # 令牌必须 >= 16 字符（main.cpp:249），否则启动即 exit 2
        token = 's1spike-' + str(int(time.time())) + '-' + os.path.basename(__file__)
        os.makedirs(self.args.out, exist_ok=True)
        cmd = [
            exe,
            '--hidden',                       # 不显示窗口：无人值守
            '--no-audio',                     # 尖峰环境不占音频设备
            '--rpc-port', str(port),
            '--rpc-token', token,
            '--write-dir', self.args.out,     # 插件写入白名单（默认只允许 exeDir）
            '--log-level', '2',
        ]
        # stdout 必须重定向到**文件**而不是 PIPE：播放器启动日志远超 4KB，
        # 用 PIPE 且无人读取时进程会阻塞在写日志上（实测卡在"插件 #2"，
        # 表现为控制通道永远起不来）。这是本尖峰踩到的第一个坑。
        os.makedirs(self.args.out, exist_ok=True)
        self.log_path = os.path.join(self.args.out, 'player.log')
        self.log_fp = open(self.log_path, 'wb')
        print(f'[S1] 启动: {" ".join(cmd)}')
        print(f'[S1] 播放器日志 → {self.log_path}')
        self.proc = subprocess.Popen(
            cmd, cwd=os.path.dirname(exe),
            stdout=self.log_fp, stderr=subprocess.STDOUT)

        if not wait_port(port):
            self.proc.kill()
            try:
                self.log_fp.close()
            except Exception:
                pass
            with open(self.log_path, 'r', encoding='utf-8', errors='replace') as f:
                out = f.read()[-1500:]
            print(f'[S1] 控制通道端口 {port} 未起来。播放器日志尾部:\n{out}')
            return None, None

        rpc = ControlChannel(port=port, token=token, timeout=self.args.timeout)
        rpc.connect()
        self.port, self.token = port, token
        return rpc, PluginPlayerRpcEngine(rpc)

    def stop_player(self):
        if self.rpc:
            try:
                self.rpc.call('app.quit')
            except RpcError:
                pass
            self.rpc.close()
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        try:
            self.log_fp.close()
        except Exception:
            pass

    # ---- 各测量项 ----
    def measure_handshake(self):
        print('\n[1] 连接与认证')
        res = self.rpc.call('ping')
        self.check('auth + ping 通过', bool(res and res.get('pong')),
                   f'abi={res.get("abi")} app={res.get("app")}')
        self.results['abi'] = res.get('abi') if res else None

    def measure_latency(self, n):
        print(f'\n[2] RPC 往返延迟（各 {n} 次）')
        for method in ('ping', 'player.stats'):
            samples = []
            for _ in range(n):
                t0 = time.perf_counter()
                try:
                    self.rpc.call(method)
                except RpcError as e:
                    self.check(f'{method} 延迟采样', False, str(e))
                    return
                samples.append((time.perf_counter() - t0) * 1000.0)
            s = sorted(samples)
            stat = {
                'n': n,
                'avgMs': round(sum(s) / len(s), 3),
                'p50Ms': round(percentile(s, 50), 3),
                'p95Ms': round(percentile(s, 95), 3),
                'maxMs': round(s[-1], 3),
                'minMs': round(s[0], 3),
            }
            self.results[f'latency.{method}'] = stat
            print(f'  ⏱ {method}: avg={stat["avgMs"]}ms '
                  f'p50={stat["p50Ms"]}ms p95={stat["p95Ms"]}ms max={stat["maxMs"]}ms')
            # 本地回环上的控制类调用，p95 超过 200ms 就说明有排队/阻塞
            self.check(f'{method} p95 < 200ms', stat['p95Ms'] < 200,
                       f'p95={stat["p95Ms"]}ms')

    def measure_playback(self):
        print('\n[3] 打开媒体与进度推进')
        self.engine.load({'uri': self.args.media})
        info = self.engine.info()
        self.results['mediaInfo'] = info
        self.check('player.open 成功', bool(info and info.get('duration')),
                   f'{info.get("width")}x{info.get("height")} '
                   f'{info.get("video_codec")} dur={info.get("duration")}s')

        self.engine.play()
        time.sleep(0.4)
        positions = []
        for _ in range(6):
            self.rpc.pump(0.05)          # 顺带消化事件帧
            st = self.rpc.call('player.stats')
            positions.append(round(float(st.get('position') or 0), 3))
            time.sleep(0.3)
        self.results['positions'] = positions
        advanced = any(positions[i + 1] > positions[i] for i in range(len(positions) - 1))
        self.check('播放进度推进', advanced, f'samples={positions}')

    def measure_controls(self):
        print('\n[4] 控制类往返')
        self.engine.seek(1000)
        time.sleep(0.25)
        st = self.rpc.call('player.stats')
        pos = float(st.get('position') or 0)
        self.check('seek(1000ms) 落到 ~1s', 0.5 <= pos <= 2.0, f'position={pos:.3f}s')

        self.engine.setRate(1.5)
        st = self.rpc.call('player.stats')
        self.check('setRate(1.5) 生效', abs(float(st.get('speed') or 0) - 1.5) < 0.01,
                   f'speed={st.get("speed")}')
        self.engine.setRate(1.0)

        self.engine.setVolume(42)
        st = self.rpc.call('player.stats')
        vol = self.engine.getState().get('volume')
        self.check('setVolume(42) 本地跟踪', vol == 42, f'volume={vol}')
        self.engine.setMuted(True)
        self.check('setMuted(True) 本地跟踪', self.engine.getState().get('muted') is True)

    def measure_subtitle(self):
        print('\n[5] 字幕链路（subtitle.line 事件）')
        self.rpc.takeEvents()
        self.rpc.subscribe('subtitle.line')
        self.rpc.onEvent(lambda ev: self.subtitle_events.append(ev)
                         if ev.get('topic') == 'subtitle.line' else None)
        try:
            self.engine.loadSubtitle(self.args.sub)
            loaded = True
        except RpcError as e:
            loaded = False
            self.check('subtitle.load 调用', False, str(e))
        if loaded:
            self.engine.play()
            deadline = time.time() + 4.0
            while time.time() < deadline:
                self.rpc.pump(0.05)
                time.sleep(0.05)
            lines = [e for e in self.subtitle_events
                     if (e.get('data') or {}).get('text')]
            self.results['subtitleEvents'] = {
                'total': len(self.subtitle_events),
                'nonEmpty': len(lines),
                'sample': (lines[0]['data']['text'][:60] if lines else None),
            }
            self.check('收到非空 subtitle.line', len(lines) > 0,
                       f'共 {len(self.subtitle_events)} 帧，非空 {len(lines)} 条'
                       + (f'，首条="{(lines[0]["data"]["text"])[:40]}"' if lines else ''))

    def measure_snapshot(self):
        print('\n[6] 截图链路（写入白名单验证）')
        before = set(f for f in os.listdir(self.args.out)
                     if f.lower().startswith('snapshot_'))
        try:
            self.engine.snapshot(os.path.join(self.args.out, 'spike.png'))
            time.sleep(0.6)
        except RpcError as e:
            self.check('snapshot 命令', False, str(e))
            return
        after = set(f for f in os.listdir(self.args.out)
                    if f.lower().startswith('snapshot_'))
        new = sorted(after - before)
        size = 0
        if new:
            size = os.path.getsize(os.path.join(self.args.out, new[0]))
        self.results['snapshot'] = {'newFiles': new, 'bytes': size}
        self.check('截图落盘（--write-dir 生效）', bool(new) and size > 0,
                   f'新文件={new} 大小={size}B')

    def measure_fullscreen(self):
        """S3：验证 `app.fullscreen` 真的能切，且 --hidden 下明确失败。"""
        print('\n[8] S3 全屏（app.fullscreen）')

        # 8a. 当前实例是 --hidden：没有可见窗口，必须**明确失败**而不是假装成功
        try:
            self.engine.setFullscreen(True)
            self.check('--hidden 下 setFullscreen 应失败', False, '竟然返回成功')
        except RpcError as e:
            self.check('--hidden 下 setFullscreen 明确失败', '全屏' in str(e), str(e))

        # 8b. 另起一个**可见窗口**实例，验证真的能切 + 能收到 app.fullscreen 事件。
        #     这一步会短暂弹出一个 320x200 的窗口（验证完立即 app.quit）。
        port = free_port()
        token = 's3-full-' + str(int(time.time())) + '-0123456789'
        logp = os.path.join(self.args.out, 'player-visible.log')
        fp = open(logp, 'wb')
        cmd = [self.args.exe, '--size', '320x200',
               '--rpc-port', str(port), '--rpc-token', token,
               '--write-dir', self.args.out, '--log-level', '2']
        proc = subprocess.Popen(cmd, cwd=os.path.dirname(self.args.exe),
                                stdout=fp, stderr=subprocess.STDOUT)
        rpc = None
        try:
            if not wait_port(port):
                self.check('可见窗口实例控制通道', False, f'端口 {port} 未起来，日志见 {logp}')
                return
            rpc = ControlChannel(port=port, token=token, timeout=self.args.timeout)
            rpc.connect()
            eng = PluginPlayerRpcEngine(rpc)
            try:
                rpc.subscribe('app.fullscreen')

                r = rpc.call('app.fullscreen', {'value': 1}) or {}
                self.check('可见窗口 app.fullscreen(value=1)', r.get('fullscreen') == 1, str(r))

                got, end = [], time.time() + 2.0
                while time.time() < end and not got:
                    rpc.pump(0.05)
                    got = rpc.takeEvents('app.fullscreen')
                    if not got:
                        time.sleep(0.05)
                self.check('收到 app.fullscreen 事件',
                           bool(got) and (got[0].get('data') or {}).get('fullscreen') == 1,
                           str(got[:1]))

                r = rpc.call('app.fullscreen', {'value': 0}) or {}
                self.check('app.fullscreen(value=0) 退出全屏', r.get('fullscreen') == 0, str(r))

                # 走适配器（而不是裸 RPC）：setFullscreen → getState 应反映真实状态
                eng.setFullscreen(True)
                st = eng.getState()
                self.check('引擎 setFullscreen → getState.fullscreen=True',
                           st.get('fullscreen') is True, str(st.get('fullscreen')))
                eng.setFullscreen(False)
                self.check('引擎 setFullscreen(False) → getState.fullscreen=False',
                           eng.getState().get('fullscreen') is False)

                rpc.call('app.quit')
            finally:
                rpc.close()
        finally:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            fp.close()

    def measure_contract(self):
        print('\n[7] getState() 是否符合 PlayerState schema')
        sys.path.insert(0, os.path.join(ROOT, 'schema'))
        try:
            from validate import validate  # noqa
        except Exception as e:
            self.check('加载 schema 校验器', False, str(e))
            return
        schema_path = os.path.join(ROOT, 'schema', 'media-item.schema.json')
        with open(schema_path, 'r', encoding='utf-8') as f:
            schema = json.load(f)
        st = self.engine.getState()
        try:
            validate(st, schema['definitions']['PlayerState'], schema, 'PlayerState')
            self.check('PlayerState 符合 schema', True, str(st))
        except ValueError as e:                 # validate() 失败即抛，带路径
            self.check('PlayerState 符合 schema', False, f'{e} | state={st}')
        self.results['playerState'] = st

    # ---- 主流程 ----
    def run(self):
        t0 = time.time()
        self.rpc, self.engine = self.start_player()
        if self.rpc is None:
            return 2
        try:
            self.measure_handshake()
            self.measure_latency(self.args.samples)
            self.measure_playback()
            self.measure_controls()
            self.measure_subtitle()
            self.measure_snapshot()
            self.measure_contract()
            self.measure_fullscreen()
        finally:
            self.results['elapsedSec'] = round(time.time() - t0, 2)
            if not self.args.keep:
                self.stop_player()
            else:
                print('\n[S1] --keep：保留播放器进程，PID =', self.proc.pid)

        self.results['failures'] = self.failures
        self.results['passed'] = not self.failures
        self.results['env'] = {
            'exe': self.args.exe,
            'media': self.args.media,
            'port': self.port,
            'outDir': self.args.out,
        }
        return 0 if not self.failures else 1


def main():
    ap = argparse.ArgumentParser(description='PluginPlayer 内核替换 S1 尖峰（无人值守）')
    ap.add_argument('--exe', default=None, help='pluginplayer.exe 路径')
    ap.add_argument('--media', default=DEFAULT_MEDIA)
    ap.add_argument('--sub', default=DEFAULT_SUB)
    ap.add_argument('--out', default=os.path.join(HERE, '_s1_out'))
    ap.add_argument('--port', type=int, default=0, help='0 = 自动选空闲端口')
    ap.add_argument('--samples', type=int, default=30, help='延迟采样次数')
    ap.add_argument('--timeout', type=float, default=5.0)
    ap.add_argument('--keep', action='store_true', help='跑完不退出播放器')
    ap.add_argument('--report', default=os.path.join(ROOT, 'docs', 's1-spike-report.json'))
    args = ap.parse_args()

    if not args.exe:
        args.exe = DEFAULT_EXE if os.path.isfile(DEFAULT_EXE) else FALLBACK_EXE
    if not os.path.isfile(args.exe):
        print(f'[S1] 找不到 pluginplayer.exe：{args.exe}')
        print('     （players-unified 的 .gitignore 排除了 dist/，构建产物在原仓库）')
        return 2
    for label, p in (('媒体', args.media), ('字幕', args.sub)):
        if not os.path.isfile(p):
            print(f'[S1] 找不到{label}文件：{p}')
            return 2

    spike = Spike(args)
    code = spike.run()
    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, 'w', encoding='utf-8') as f:
        json.dump(spike.results, f, ensure_ascii=False, indent=2)
    print(f'\n[S1] 报告已写入: {args.report}')
    if spike.failures:
        print('[S1] 失败项:')
        for x in spike.failures:
            print('   -', x)
    else:
        print('[S1] 全部通过 ✅')
    return code


if __name__ == '__main__':
    sys.exit(main())
