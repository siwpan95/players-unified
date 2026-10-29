"""localplayer MediaItem schema 断言测试（P0-2）。

直接调用真实代码路径 media_lib.build_media_items()（server.py 的 /api/list 即调用它），
校验其产出符合 schema/media-item.schema.json 的 MediaItem 契约。零三方依赖，用 F:\\Python314 直跑。

运行：python localplayer/tests/test_media_lib.py
"""
import os
import re
import sys
import tempfile

# ---- 定位仓库根（含 schema/media-item.schema.json）----
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
sys.path.insert(0, os.path.join(ROOT, 'localplayer'))

from validate import validate, load_schema   # noqa: E402
from media_lib import build_media_items       # noqa: E402

SCHEMA = load_schema()
ITEM_SCHEMA = SCHEMA['definitions']['MediaItem']
ID_RE = re.compile(r'^lp-[0-9a-f]{16}$')


def assert_item(it):
    validate(it, ITEM_SCHEMA)              # 不符则抛 ValueError
    assert ID_RE.match(it['id']), f"id 格式不符: {it['id']!r}"
    assert it['uri'].startswith('http'), f"uri 应为 http(s) URL: {it['uri']!r}"
    assert '/media/' in it['uri'], f"uri 应指向 /media/：{it['uri']!r}"
    assert it['source'] == 'remote', f"source 应为 remote: {it['source']!r}"
    assert it['kind'] in ('audio', 'video'), f"kind 越界: {it['kind']!r}"
    assert it['subtitleTracks'] == [], "subtitleTracks 应为空数组"
    assert it['artist'] is None and it['durationMs'] is None and it['thumbnail'] is None
    # 过渡别名（兼容未迁移前端）应随规范字段正确发出
    assert {'name', 'type', 'path'} <= set(it), "缺过渡别名 name/type/path"
    assert it['path'] == it['uri'], "别名 path 应等于 uri"


def _seed(d):
    files = {
        'movie A.mp4': None, 'song B.mp3': None, 'clip.mkv': None,
        'audio.wav': None, 'notes.txt': None, 'ignored.png': None,
    }
    for fn in files:
        with open(os.path.join(d, fn), 'w', encoding='utf-8') as f:
            f.write('x')
    sub = os.path.join(d, 'sub')
    os.makedirs(sub)
    with open(os.path.join(sub, 'deep.flac'), 'w', encoding='utf-8') as f:
        f.write('x')


def main():
    host = 'http://127.0.0.1:5000'
    with tempfile.TemporaryDirectory() as d:
        _seed(d)

        items = build_media_items(d, host)
        # localplayer 清单为扁平（非递归）：4 项（mp4/mkv/mp3/wav）
        assert len(items) == 4, f"扁平列举应 4 项，实际 {len(items)}"
        for it in items:
            assert_item(it)
            assert it['name'].endswith(('.mp4', '.mkv', '.mp3', '.wav'))

        # 子目录文件不应被纳入（证明非递归约束，Phase 3 启动器需注意）
        uris = [it['uri'] for it in items]
        assert not any('sub/' in u or 'deep.flac' in u for u in uris), "不应扫描子目录"

        # 稳定 id
        again = build_media_items(d, host)
        assert [i['id'] for i in items] == [i['id'] for i in again], "id 不稳定"
        # 去重
        assert len(set(i['id'] for i in items)) == len(items), "id 有重复"

        # 空目录返回空
        with tempfile.TemporaryDirectory() as empty:
            assert build_media_items(empty, host) == []

    print("[test] localplayer MediaItem[] 全部断言通过 ✅  符合 schema/media-item.schema.json")
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except AssertionError as e:
        print(f"[test] 断言失败 ❌  {e}")
        sys.exit(1)
    except ValueError as e:
        print(f"[test] schema 校验失败 ❌  {e}")
        sys.exit(1)
