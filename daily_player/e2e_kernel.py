"""daily_player **内核门面**的端到端探针（需要真实 pluginplayer.exe + 一段媒体）。

与 `spike_s1.py` 的分工
----------------------
- `spike_s1.py` 验证的是**控制通道协议**：握手、延迟分布、`subtitle.line`、
  进度、截图、PlayerState 契约。
- 本脚本验证的是 **`kernel.py` 这一层门面**：默认内核能不能真的选到 pluginplayer、
  进程能不能拉起来、端口方法能不能驱动播放、`getState()` 能不能报出真实进度、
  截图中转能不能落盘、能力声明与实际行为是否一致、退出能不能干净收摊。

为什么单独一个脚本
------------------
`play.py` 是 GUI，无法无人值守跑；但"默认切到 PluginPlayer 内核"这件事的**成败全在
kernel.py + 进程托管**上。本脚本把那一层单独拉出来跑，给得出「确实能播」的证据，
而不是"看起来没问题"。

跳过而非失败
------------
找不到 `pluginplayer.exe` 或媒体文件时**跳过**（退出码 0）：这是依赖本机条件的 E2E，
不是每次必跑的单测。单测请跑 `tests/test_kernel.py`。

用法::

    F:/Python314/python.exe daily_player/e2e_kernel.py [媒体文件]
    # 默认媒体：pluginplayer/dist/test_assets/sample.mp4
"""

import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'schema'))

import kernel as K                                              # noqa: E402

REPORT = os.path.join(ROOT, 'docs', 'kernel-e2e-report.json')

DEFAULT_MEDIA = (
    os.path.join(ROOT, 'pluginplayer', 'dist', 'test_assets', 'sample.mp4'),
    os.path.join(ROOT, 'pluginplayer', 'test_assets', 'sample.mp4'),
)


def find_media(argv):
    for a in argv[1:]:
        if not a.startswith('-') and os.path.isfile(a):
            return os.path.abspath(a)
    for p in DEFAULT_MEDIA:
        if os.path.isfile(p):
            return p
    return None


def main(argv=None):
    argv = argv if argv is not None else sys.argv
    results = []

    def step(name, ok, detail=''):
        results.append({'step': name, 'ok': bool(ok), 'detail': str(detail)})
        print(f"  {'✅' if ok else '❌'} {name}" + (f" — {detail}" if detail else ''))
        return ok

    media = find_media(argv)
    exe = K.find_pluginplayer_exe()
    if not exe or not media:
        print('[e2e] 跳过：需要真实 pluginplayer.exe 与媒体文件')
        print(f"        exe   = {exe or '（未找到，设 DAILY_PLAYER_PP_EXE）'}")
        print(f"        media = {media or '（未找到，命令行传一个）'}")
        return 0

    print('[e2e] daily_player 内核门面端到端')
    print(f"  exe   = {exe}")
    print(f"  media = {media}")
    print('\n[1] 选择内核')
    step('find_pluginplayer_exe 命中', bool(exe), exe)
    name, why = K.choose_kernel(None, pp_exe=exe, vlc_ok=True)
    step('默认请求（不指定）→ pluginplayer，而不是回落 vlc', name == K.KERNEL_PP, why)

    k, why = K.create_kernel(K.KERNEL_PP)
    if k is None:
        step('create_kernel(pluginplayer) 成功', False, why)
        return finish(results, 1)
    step('create_kernel 成功并拉起进程', k.name == K.KERNEL_PP, why)

    try:
        print('\n[2] 能力声明与实际行为一致')
        step('caps.embed=False（画面不在 tk 窗口）', k.caps['embed'] is False)
        step('attach_window 明确返回 False', k.attach_window(0) is False)
        step('caps.externalFullscreen=True',
             k.caps['externalFullscreen'] is True)
        # --hidden 起的话没有可见窗口 → 必须**如实**返回 False，不能假装成功
        fs = k.set_external_fullscreen(True)
        step('--hidden 下全屏切换如实返回 False（不假装成功）', fs is False, f'返回 {fs}')

        print('\n[3] 经端口驱动播放')
        title = os.path.basename(media)
        k.load({'uri': media, 'id': media, 'title': title,
                'kind': 'video', 'source': 'local-file'})
        k.play()
        step('load + play 未抛异常', True)

        dur = None
        deadline = time.time() + 20
        while time.time() < deadline:
            st = k.getState()
            dur = st.get('durationMs')
            if dur:
                break
            time.sleep(0.25)
        step('内核报出真实时长（>0）', bool(dur), f'{dur} ms')

        t0 = k.getState().get('timeMs') or 0
        time.sleep(1.2)
        t1 = k.getState().get('timeMs') or 0
        step('进度真实前进', t1 > t0, f'{t0} ms → {t1} ms（+{t1 - t0}）')

        print('\n[4] PlayerState 符合契约')
        st = k.getState()
        try:
            from validate import validate, load_schema
            validate(st, load_schema()['definitions']['PlayerState'])
            step('PlayerState 通过 schema 校验', True)
        except ImportError as e:
            step('schema 校验器可用', False, str(e))
        except ValueError as e:
            step('PlayerState 通过 schema 校验', False, str(e))
        step('volume/muted 本地跟踪一致',
             isinstance(st.get('volume'), int) and 0 <= st['volume'] <= 100,
             f"volume={st.get('volume')} muted={st.get('muted')}")

        print('\n[5] 端口方法（音量/静音/倍速/跳转）')
        k.setVolume(30)
        step('setVolume(30) → getState 报 30', k.getState()['volume'] == 30)
        k.setMuted(True)
        step('setMuted(True) → getState 报 True', k.getState()['muted'] is True)
        k.setRate(1.5)
        step('setRate(1.5) → getState 报 1.5',
             abs(k.getState()['rate'] - 1.5) < 0.01, f"rate={k.getState()['rate']}")
        k.setRate(1.0)
        k.seek(1000)
        time.sleep(0.8)
        pos = k.getState()['timeMs']
        step('seek(1000) 后位置接近 1s', abs(pos - 1000) < 800, f'{pos} ms')

        print('\n[6] 字幕轨（无内嵌轨时应返回空表而不是报错）')
        tracks = k.subtitle_tracks(media)
        step('subtitle_tracks 返回列表', isinstance(tracks, list), str(tracks))
        step('越界 select_subtitle 返回 False', k.select_subtitle(9) is False)
        step('disable_subtitle 返回 False（能力不支持）',
             k.disable_subtitle() is False)

        print('\n[7] 截图（白名单中转）')
        with tempfile.TemporaryDirectory() as td:
            dest = os.path.join(td, 'sub', 'e2e_snap.png')
            got = k.screenshot(dest)
            ok_file = bool(got) and os.path.isfile(got)
            step('screenshot 落盘', ok_file, got or '（None）')
            if ok_file:
                with open(got, 'rb') as f:
                    head = f.read(8)
                step('是合法 PNG 且非空', head.startswith(b'\x89PNG') and os.path.getsize(got) > 1000,
                     f'{os.path.getsize(got)} bytes')
                step('中转落到了请求的目标路径', os.path.abspath(got) == os.path.abspath(dest),
                     f'请求 {dest}')

        code = 0 if all(r['ok'] for r in results) else 1
    finally:
        print('\n[8] 收摊')
        proc = getattr(k, 'proc', None)
        pid = getattr(proc, 'proc', None)
        k.shutdown()
        time.sleep(0.5)
        alive = pid is not None and pid.poll() is None
        step('shutdown 后子进程已退出', not alive,
             '进程仍在（孤儿）' if alive else '干净退出')
        if all(r['ok'] for r in results):
            code = 0
        else:
            code = 1
    return finish(results, code)


def finish(results, code):
    bad = [r['step'] for r in results if not r['ok']]
    try:
        os.makedirs(os.path.dirname(REPORT), exist_ok=True)
        with open(REPORT, 'w', encoding='utf-8') as f:
            json.dump({'passed': len(results) - len(bad), 'total': len(results),
                       'failed': bad, 'steps': results}, f,
                      ensure_ascii=False, indent=2)
        print(f'\n[e2e] 报告已写入 {REPORT}')
    except OSError as e:
        print(f'[e2e] 报告写入失败: {e}')
    if code == 0:
        print(f"[e2e] {len(results)} 项全部通过 ✅")
    else:
        print(f"[e2e] 失败 ❌: {bad}")
    return code


if __name__ == '__main__':
    sys.exit(main())
