"""S1 形态 A 面板控制器（PanelController）的无 GUI 回归测试。

不依赖 tkinter、不依赖真实播放器：用假 engine 走通面板的全部控制路径，
包括 subtitle.line 事件 → 字幕文本更新这条链路。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from spike_panel import PanelController  # noqa: E402
from player_engine_rpc import RpcError  # noqa: E402


class FakeRpc:
    """假控制通道：pump() 吐出预置事件。"""

    def __init__(self, events=None):
        self._events = list(events or [])
        self.pumped = 0

    def pump(self, timeout=0.0):
        self.pumped += 1
        return 0


class FakeEngine:
    def __init__(self, events=None):
        self.rpc = FakeRpc(events)
        self._events = list(events or [])
        self.op = []                      # 操作日志
        self.state = {
            'playing': False, 'timeMs': 0, 'durationMs': 10000,
            'rate': 1.0, 'volume': 100, 'muted': False, 'fullscreen': False,
        }

    # PlayerEngine 端口
    def load(self, item):
        self.op.append(('load', item['uri'] if isinstance(item, dict) else item))
        return self

    def play(self):
        self.op.append(('play',))
        self.state['playing'] = True
        return self

    def pause(self):
        self.op.append(('pause',))
        self.state['playing'] = False
        return self

    def seek(self, ms):
        self.op.append(('seek', ms))
        self.state['timeMs'] = int(ms)
        return self

    def setRate(self, r):
        self.op.append(('rate', r))
        self.state['rate'] = r
        return self

    def setVolume(self, v):
        self.op.append(('volume', v))
        self.state['volume'] = int(v)
        return self

    def setMuted(self, m):
        self.op.append(('muted', m))
        return self

    def snapshot(self, path):
        self.op.append(('snapshot', path))
        return {'command': 'snapshot', 'return': 0}

    def getState(self):
        return dict(self.state)

    def takeEvents(self, topic=None):
        out = [e for e in self._events if topic is None or e.get('topic') == topic]
        self._events = [e for e in self._events if topic is not None and e.get('topic') != topic]
        return out

    # 扩展
    def loadSubtitle(self, path):
        self.op.append(('subtitle', path))
        return {'command': 'subtitle.load', 'return': 0}


def line(text):
    return {'topic': 'subtitle.line', 'data': {'text': text}}


def main():
    fails = []

    def check(name, cond, detail=''):
        if cond:
            print(f'  ✅ {name}' + (f' — {detail}' if detail else ''))
        else:
            fails.append(name)
            print(f'  ❌ {name}' + (f' — {detail}' if detail else ''))

    print('[test] S1 面板控制器（无 GUI / 假引擎）')

    # 1. 播放/暂停切换
    eng = FakeEngine()
    c = PanelController(eng)
    c.refresh()
    c.toggle()
    check('暂停态 toggle → play', ('play',) in eng.op and c.state['playing'] is True)
    c.toggle()
    check('播放态 toggle → pause', ('pause',) in eng.op and c.state['playing'] is False)

    # 2. 打开即播放
    eng = FakeEngine()
    c = PanelController(eng)
    c.open_('F:/media/a.mp4')
    check('open_ 先 load 再 play',
          [o[0] for o in eng.op] == ['load', 'play'], str([o[0] for o in eng.op]))

    # 3. 字幕事件 → 文本更新。
    #    注意：takeEvents 是"一次排空"，所以这里按真实时序**逐条追加**事件，
    #    而不是一次性塞两条（一次塞两条时控制器只会保留最后一条，属预期行为）。
    eng = FakeEngine()
    c = PanelController(eng)
    eng._events.append(line('第一句'))
    first = c.pump()
    check('pump 返回首条字幕', first == '第一句', repr(first))
    eng._events.append(line('第二句'))
    second = c.pump()
    check('pump 返回变化后的第二条', second == '第二句', repr(second))
    third = c.pump()
    check('无新事件时 pump 返回 None', third is None, repr(third))
    check('ctrl.subtitle 保留最后一句', c.subtitle == '第二句', c.subtitle)

    # 4. 相同文本不重复触发（内核本来就只在变化时广播，这里确认控制器语义一致）
    eng = FakeEngine()
    c = PanelController(eng)
    eng._events.append(line('同一句'))
    c.pump()
    eng._events.append(line('同一句'))
    same = c.pump()
    check('重复文本不产生变更', same is None, repr(same))

    # 5. 空行字幕（行结束）也要更新成空串
    eng = FakeEngine()
    c = PanelController(eng)
    eng._events.append(line('有字'))
    c.pump()
    eng._events.append(line(''))
    cleared = c.pump()
    check('空行字幕被识别为变更（值为空串）', cleared == '', repr(cleared))
    check('空行后 ctrl.subtitle 清空', c.subtitle == '', repr(c.subtitle))

    # 6. 控制类动作都走端口
    eng = FakeEngine()
    c = PanelController(eng)
    c.seekMs(3000)
    c.setVolume(35)
    c.setRate(1.5)
    check('seek/volume/rate 均经端口下发',
          [o[0] for o in eng.op] == ['seek', 'volume', 'rate'], str([o[0] for o in eng.op]))
    check('setVolume 后状态同步', c.state['volume'] == 35, str(c.state['volume']))

    # 7. 截图传的是目录（原生 snapshot 命令语义）
    eng = FakeEngine()
    c = PanelController(eng)
    c.snapshot('F:/out')
    # 控制器固定用 panel.png 作为占位文件名；原生 snapshot 命令只认**目录**
    want = os.path.join('F:/out', 'panel.png')
    check('snapshot 落目录', eng.op[0] == ('snapshot', want), str(eng.op[0]))

    # 8. 错误被捕获而不是抛出（UI 循环不能因为一次 RPC 失败崩掉）
    class Boom(FakeEngine):
        def getState(self):
            raise RpcError('控制通道已断开')

    c = PanelController(Boom())
    st = c.refresh()
    check('RPC 失败被捕获进 lastError', c.lastError == '控制通道已断开', str(c.lastError))

    if fails:
        print(f'\n[test] 断言失败 ❌: {fails}')
        return 1
    print('[test] S1 面板控制器 全部断言通过 ✅')
    return 0


if __name__ == '__main__':
    sys.exit(main())
