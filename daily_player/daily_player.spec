# -*- mode: python ; coding: utf-8 -*-
# daily_player 发行版 spec（onedir + 64 位 VLC 平铺）
#
# VLC 运行时目录解析（去本地化）：原写法钉死在本机临时构建目录里（该目录已删除），
# 现在按「环境变量 -> 可推导默认 -> fail-loud」解析：
#   1) 环境变量 DAILY_PLAYER_VLC_DIR，指向含 libvlc.dll / libvlccore.dll / plugins 的那一层
#   2) <spec 同级>/vlc64、<spec 同级>/vendor/vlc64，以及展开后的 <spec 同级>/vlc64/vlc-*
#   3) 注册表 HKLM\SOFTWARE\VideoLAN\VLC 的 InstallDir
#   4) %ProgramFiles%\VideoLAN\VLC、%ProgramFiles(x86)%\VideoLAN\VLC、PATH 里 vlc.exe 的同级目录
# 全部落空就直接报错并点名该设哪个环境变量（不再静默产出缺运行时的包）。
import os
import glob
import shutil

_VLC_ENV = 'DAILY_PLAYER_VLC_DIR'


def _vlc_candidates():
    cands = []
    env = (os.environ.get(_VLC_ENV) or '').strip().strip('"')
    if env:
        cands.append(env)
    cands.append(os.path.join(SPECPATH, 'vlc64'))
    cands.append(os.path.join(SPECPATH, 'vendor', 'vlc64'))
    cands += sorted(glob.glob(os.path.join(SPECPATH, 'vlc64', 'vlc-*')))
    try:
        import winreg
        for key in (r'SOFTWARE\VideoLAN\VLC', r'SOFTWARE\WOW6432Node\VideoLAN\VLC'):
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key) as k:
                    cands.append(winreg.QueryValueEx(k, 'InstallDir')[0])
            except OSError:
                pass
    except ImportError:
        pass
    for var in ('ProgramFiles', 'ProgramFiles(x86)'):
        base = os.environ.get(var)
        if base:
            cands.append(os.path.join(base, 'VideoLAN', 'VLC'))
    exe = shutil.which('vlc.exe')
    if exe:
        cands.append(os.path.dirname(exe))
    return [c for c in cands if c]


def _resolve_vlc_root():
    tried = _vlc_candidates()
    for p in tried:
        if os.path.isfile(os.path.join(p, 'libvlc.dll')):
            return os.path.abspath(p), tried
    raise SystemExit(
        '[daily_player.spec] 找不到 64 位 VLC 运行时（候选目录下都没有 libvlc.dll）。\n'
        '  已试候选：\n' + '\n'.join('    - ' + t for t in tried) + '\n'
        '  请设置环境变量 ' + _VLC_ENV + ' 指向 VLC 目录（含 libvlc.dll 的那一层），例如：\n'
        '    set ' + _VLC_ENV + '=<VLC 安装目录>\n'
        '  然后重新运行 pyinstaller daily_player.spec'
    )


VLC_ROOT, _VLC_TRIED = _resolve_vlc_root()

# runtime hook：原文件随那个已删除的临时构建目录一起丢失（全盘已搜不到 rthook_vlc.py）。
# 解析：环境变量 DAILY_PLAYER_VLC_RTHOOK -> <spec 同级>/rthook_vlc.py -> 明确告警并跳过。
_RTHOOK_ENV = 'DAILY_PLAYER_VLC_RTHOOK'
_rthook = (os.environ.get(_RTHOOK_ENV) or '').strip().strip('"')
if not _rthook:
    _c = os.path.join(SPECPATH, 'rthook_vlc.py')
    _rthook = _c if os.path.isfile(_c) else ''
if not _rthook:
    print('[daily_player.spec] 警告：未找到 rthook_vlc.py（原文件已随本机临时构建目录丢失），'
          '本次构建不带 VLC runtime hook；可用环境变量 ' + _RTHOOK_ENV + ' 指定。')

a = Analysis(
    ['G:/repos/daily_player/play.py'],
    pathex=['G:/repos/daily_player'],
    binaries=[],
    datas=[
        (os.path.join(VLC_ROOT, 'libvlc.dll'), '.'),
        (os.path.join(VLC_ROOT, 'libvlccore.dll'), '.'),
        (os.path.join(VLC_ROOT, 'plugins'), 'plugins'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=([_rthook] if _rthook else []),
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
