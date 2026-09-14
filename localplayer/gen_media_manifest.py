"""
扫描 media/ 目录，生成本地打包媒体的清单 media/manifest.json。

扩展运行时无法枚举自身包内目录，因此放入新文件后需重新运行本脚本，
并刷新（reload）扩展，popup 才会列出这些文件。

用法：
    python gen_media_manifest.py
（Windows 可直接双击 gen_media_manifest.bat）
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
MEDIA_DIR = os.path.join(BASE, 'media')

# 可被播放器识别的「入口」扩展名（HLS 分片 .ts 由 .m3u8 引用，不单独列出）
ENTRY_TYPES = {
    '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video',
    '.m3u8': 'video',
    '.mp3': 'audio', '.ogg': 'audio', '.wav': 'audio',
    '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio',
}

SKIP = {'README.md', 'manifest.json', 'index.m3u8.bak'}


def main():
    items = []
    if os.path.isdir(MEDIA_DIR):
        for root, _dirs, files in os.walk(MEDIA_DIR):
            for fn in sorted(files):
                if fn in SKIP:
                    continue
                ext = os.path.splitext(fn)[1].lower()
                if ext in ('.ts',):
                    continue
                mtype = ENTRY_TYPES.get(ext)
                if not mtype:
                    continue
                rel = os.path.relpath(os.path.join(root, fn), MEDIA_DIR).replace(os.sep, '/')
                items.append({'name': fn, 'file': rel, 'type': mtype})

    out_path = os.path.join(MEDIA_DIR, 'manifest.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f'wrote {out_path}: {len(items)} media file(s)')


if __name__ == '__main__':
    main()
