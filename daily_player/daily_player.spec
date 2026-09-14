# -*- mode: python ; coding: utf-8 -*-
# daily_player 发行版 spec（onedir + 64 位 VLC 平铺）
a = Analysis(
    ['G:/repos/daily_player/play.py'],
    pathex=['G:/repos/daily_player'],
    binaries=[],
    datas=[
        ('G:/Temp/rebuild/vlc64/vlc-3.0.21/libvlc.dll', '.'),
        ('G:/Temp/rebuild/vlc64/vlc-3.0.21/libvlccore.dll', '.'),
        ('G:/Temp/rebuild/vlc64/vlc-3.0.21/plugins', 'plugins'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['G:/Temp/rebuild/rthook_vlc.py'],
    excludes=['torch','cupy','dask','jax','jaxlib','ndonnx','sparse','sqlalchemy','matplotlib','IPython','Cython','setuptools','traitlets','jedi','pygments','yt_dlp','playwright','botocore','boto3','transformers','tokenizers','pyarrow','llvmlite','numba','scipy','sklearn','scikit-learn','imageio','imageio_ffmpeg','tensorflow','keras','moviepy','sympy','statsmodels','nltk','networkx','PyQt5','PyQt6','PySide2','PySide6','pymongo','bson'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name='daily_player',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    contents_directory='.',
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='daily_player')
