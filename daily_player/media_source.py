"""daily_player 媒体源适配器（Phase 1：MediaItem 对齐）。

按 ARCHITECTURE.md §4/§6，把「文件夹扫描」重构为返回 MediaItem[] 的 LocalFileSource，
使 daily_player 的媒体枚举产出与 localplayer / PluginPlayer 一致的跨端契约
（schema/media-item.schema.json）。

本模块为纯结构抽取，**不改变 libVLC 的播放行为**；play.py 的既有 open_folder 流程保持不变。
后续可在 UI 层直接消费 LocalFileSource.list() 产出的 MediaItem[] 以统一播放列表结构。
"""
import os
import hashlib

VIDEO_EXTS = {'.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v'}
AUDIO_EXTS = {'.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac'}


def _kind(ext):
    if ext in VIDEO_EXTS:
        return 'video'
    if ext in AUDIO_EXTS:
        return 'audio'
    return None


def _stable_id(path):
    """路径哈希作为稳定 id（进度记忆/去重用）。"""
    return 'dp-' + hashlib.sha1(os.path.abspath(path).encode('utf-8')).hexdigest()[:16]


def media_item_for(path):
    """把单个文件路径转换为 MediaItem（无法识别扩展名则返回 None）。"""
    ext = os.path.splitext(path)[1].lower()
    kind = _kind(ext)
    if kind is None:
        return None
    name = os.path.basename(path)
    return {
        'id': _stable_id(path),
        'uri': os.path.abspath(path),
        'title': os.path.splitext(name)[0],
        'artist': None,
        'kind': kind,
        'durationMs': None,
        'source': 'local-file',
        'subtitleTracks': [],
        'thumbnail': None,
    }


class LocalFileSource:
    """本地文件/文件夹媒体源，产出 MediaItem[]。"""

    def list(self, folder, recursive=False):
        items = []
        if not folder or not os.path.isdir(folder):
            return items
        if recursive:
            for root, _dirs, files in os.walk(folder):
                for fn in files:
                    item = media_item_for(os.path.join(root, fn))
                    if item:
                        items.append(item)
        else:
            for fn in sorted(os.listdir(folder)):
                full = os.path.join(folder, fn)
                if os.path.isfile(full):
                    item = media_item_for(full)
                    if item:
                        items.append(item)
        return items


if __name__ == '__main__':
    import json
    import sys
    src = LocalFileSource()
    target = sys.argv[1] if len(sys.argv) > 1 else '.'
    print(json.dumps(src.list(target), ensure_ascii=False, indent=2))
