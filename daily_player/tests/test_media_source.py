"""daily_player MediaItem schema 断言测试（P0-2）。

直接调用真实代码路径 LocalFileSource.list() / media_item_for()，校验其产出符合
schema/media-item.schema.json 的 MediaItem 契约。零三方依赖，用 F:\\Python314 直跑。

运行：F:/Python314/python.exe daily_player/tests/test_media_source.py
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
sys.path.insert(0, os.path.join(ROOT, 'daily_player'))

from validate import validate, load_schema          # noqa: E402
from media_source import LocalFileSource, media_item_for  # noqa: E402

SCHEMA = load_schema()
ITEM_SCHEMA = SCHEMA['definitions']['MediaItem']
ID_RE = re.compile(r'^dp-[0-9a-f]{16}$')


def assert_item(it):
    validate(it, ITEM_SCHEMA)              # 不符则抛 ValueError
    assert ID_RE.match(it['id']), f"id 格式不符: {it['id']!r}"
    assert os.path.isabs(it['uri']), f"uri 非绝对路径: {it['uri']!r}"
    assert it['source'] == 'local-file', f"source 应为 local-file: {it['source']!r}"
    assert it['kind'] in ('audio', 'video'), f"kind 越界: {it['kind']!r}"
    assert it['subtitleTracks'] == [], "subtitleTracks 应为空数组"
    assert it['artist'] is None and it['durationMs'] is None and it['thumbnail'] is None


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
    src = LocalFileSource()
    with tempfile.TemporaryDirectory() as d:
        _seed(d)

        recursive = src.list(d, recursive=True)
        assert len(recursive) == 5, f"递归应 5 项（mp4/mkv/mp3/wav/flac），实际 {len(recursive)}"
        for it in recursive:
            assert_item(it)

        flat = src.list(d, recursive=False)
        assert len(flat) == 4, f"非递归应 4 项（不含 sub/），实际 {len(flat)}"
        for it in flat:
            assert_item(it)

        # 稳定 id：同输入两次结果一致
        again = src.list(d, recursive=True)
        assert [i['id'] for i in recursive] == [i['id'] for i in again], "id 不稳定"
        # 去重：id 唯一
        assert len(set(i['id'] for i in recursive)) == len(recursive), "id 有重复"

        # 未知扩展名应被 media_item_for 过滤为 None
        assert media_item_for(os.path.join(d, 'weird.xyz')) is None

        # 非目录入参返回空
        assert src.list(os.path.join(d, 'notes.txt')) == []

    print("[test] daily_player MediaItem[] 全部断言通过 ✅  符合 schema/media-item.schema.json")
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
