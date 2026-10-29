"""VLC 运行时自动探测。

python-vlc 在 `import vlc` 时会读取 `PYTHON_VLC_LIB_PATH` / `VLC_PLUGIN_PATH`。
本机 VLC 装在 `E:\\VLC`（注册表残留仍指向已移除的 F:\\VLC）。在 import vlc 之前，
先探测已知位置并设置环境变量，避免每次手动配置。

探测顺序：
1. 已设置的 `PYTHON_VLC_LIB_PATH`（用户/启动器已指定）
2. 环境变量 `VLC_DIR`
3. 常见安装目录（E:/VLC、D:/VLC、C:/Program Files/VideoLAN/VLC ...）
4. PATH 上的 libvlc.dll
"""
from __future__ import annotations

import os
from pathlib import Path

_CANDIDATE_DIRS = [
    lambda: Path(os.environ["VLC_DIR"]) if os.environ.get("VLC_DIR") else None,
    Path("E:/VLC"),
    Path("D:/VLC"),
    Path("C:/Program Files/VideoLAN/VLC"),
    Path("C:/Program Files (x86)/VideoLAN/VLC"),
    Path(os.path.expandvars("%LOCALAPPDATA%/VideoLAN/VLC")),
    # PyInstaller 单文件打包后，libVLC 随包解压到 _MEIPASS
    lambda: (Path(sys._MEIPASS) if getattr(sys, "_MEIPASS", "") else None),
]


def _candidate_dirs():
    dirs = []
    for gen in _CANDIDATE_DIRS:
        try:
            d = gen() if callable(gen) else gen
        except Exception:
            d = None
        if d:
            dirs.append(Path(d))
    # PATH 上的 libvlc.dll
    import shutil
    on_path = shutil.which("libvlc.dll")
    if on_path:
        dirs.append(Path(on_path).parent)
    return dirs


def ensure_vlc_env() -> bool:
    """在 import vlc 之前调用。找到 libvlc.dll 则设置环境变量并返回 True。"""
    existing = os.environ.get("PYTHON_VLC_LIB_PATH")
    if existing and os.path.exists(existing):
        return True
    for d in _candidate_dirs():
        lib = d / "libvlc.dll"
        plugins = d / "plugins"
        if lib.exists():
            os.environ["PYTHON_VLC_LIB_PATH"] = str(lib)
            if plugins.exists() and not os.environ.get("VLC_PLUGIN_PATH"):
                os.environ["VLC_PLUGIN_PATH"] = str(plugins)
            return True
    return False


def vlc_missing_message() -> str:
    return (
        "未找到 VLC 运行时（libvlc.dll）。\n"
        "请安装 VLC：https://www.videolan.org/vlc/ ，\n"
        "或在启动前设置环境变量 VLC_DIR 指向含 libvlc.dll 的目录。"
    )


__all__ = ["ensure_vlc_env", "vlc_missing_message"]
