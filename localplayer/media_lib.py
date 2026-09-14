"""localplayer 媒体清单的纯逻辑构建（Phase 1：MediaItem 对齐）。

从 server.py 的 media_list() 抽出「无 Flask 依赖」的列表构建逻辑，使其可被单测直接调用
（与 PluginPlayer 的 host-js/plugins/lib/media-library-core.mjs 同一思路：纯 core + 宿主 wrapper）。
字段遵循 schema/media-item.schema.json 的 MediaItem 契约；为兼容未迁移的前端，额外附带
过渡别名 name/type/path（未来阶段移除）。
"""
import os
import hashlib

MEDIA_TYPES = {
    '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video',
    '.mp3': 'audio', '.ogg': 'audio', '.wav': 'audio',
    '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio',
}


def build_media_items(media_dir, host_url):
    """扫描 media_dir（非递归），返回 MediaItem[]（每项含规范字段 + 过渡别名）。

    host_url: 后端对外基地址（如 http://127.0.0.1:5000），用于拼接 uri。
    非 media_dir 下子目录中的文件不会被纳入（localplayer 清单为扁平列举）。
    """
    items = []
    if not media_dir or not os.path.isdir(media_dir):
        return items
    base = host_url.rstrip('/') if host_url else ''
    for fn in sorted(os.listdir(media_dir)):
        ext = os.path.splitext(fn)[1].lower()
        mtype = MEDIA_TYPES.get(ext)
        if not mtype:
            continue
        uri = base + '/media/' + fn
        items.append({
            # ---- 规范 MediaItem 字段 ----
            'id': 'lp-' + hashlib.sha1(uri.encode('utf-8')).hexdigest()[:16],
            'uri': uri,
            'title': os.path.splitext(fn)[0],
            'artist': None,
            'kind': mtype,
            'durationMs': None,
            'source': 'remote',
            'subtitleTracks': [],
            'thumbnail': None,
            # ---- 过渡别名（兼容未迁移前端，未来阶段移除）----
            'name': fn,
            'type': mtype,
            'path': uri,
        })
    return items
