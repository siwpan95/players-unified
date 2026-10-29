# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包脚本（Windows）。

把音乐播放器打包成单目录 / 单文件 exe，并内嵌 libVLC 运行时，
使最终产物在「未安装 VLC」的机器上也能直接播放全格式。

用法（在项目根目录 D:/projects/music-player 执行）：
    python -m pip install -e ".[packaging]"
    pyinstaller build.spec --clean

环境变量：
    VLC_DIR  — 指向含 libvlc.dll 与 plugins/ 的 VLC 安装目录
               （默认 E:/VLC，与本机一致；其他机器请改这里或设环境变量）

`music_player/utils/vlc_runtime.py` 已支持从 `sys._MEIPASS/vlc` 读取内嵌运行时，
本 spec 将整个 VLC 目录打进 <MEIPASS>/vlc，运行时自动被识别。
"""
from PyInstaller.utils.hooks import collect_submodules
import os

VLC_SRC = os.environ.get("VLC_DIR", r"E:/VLC")

block_cipher = None

# 把 VLC 整个目录塞进打包产物根目录下的 vlc/ 子目录
vlc_datas = []
if os.path.isdir(VLC_SRC):
    vlc_datas.append((os.path.join(VLC_SRC, "*"), "vlc"))
    print(f"[build.spec] 内嵌 VLC 运行时: {VLC_SRC}")
else:
    print(f"[build.spec] 警告: 未找到 VLC_DIR={VLC_SRC}，打包后需目标机自带 VLC")

a = Analysis(
    [os.path.join("main.py")],
    pathex=[],
    binaries=[],
    datas=vlc_datas,
    hiddenimports=[
        "music_player",
        "vlc",
        "mutagen",
        "mutagen.mp3",
        "mutagen.flac",
        "mutagen.mp4",
        "numpy",
        "PIL",
        "PIL.ImageTk",
    ] + collect_submodules("music_player"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "librosa",   # viz 可选依赖，打包默认不内置（避免体积爆炸）
        "scipy",
        "tkinter.test",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="music-player",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # 桌面 GUI，不弹黑框
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="music-player",
)
