import os, ctypes, sys

# 2026-09-23 去本地化：不再写死本机绝对路径（原路径已不存在）。
# 解析顺序：环境变量 PP_LIBASS_BIN → 本脚本同级 vendor/libass/bin → 报错并点名该设哪个变量。
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_DEFAULT_BIN = _HERE / "vendor" / "libass" / "bin"
_env = os.environ.get("PP_LIBASS_BIN", "").strip()
if _env:
    # 显式配置必须生效或明确报错——不静默回退（否则设错路径会被掩盖）
    if not Path(_env).is_dir():
        raise SystemExit(
            f"[错误] PP_LIBASS_BIN 指向的目录不存在：{_env}\n"
            f"  它是显式配置，本脚本不会静默回退到默认目录（{_DEFAULT_BIN}）。\n"
            f"  请改正该环境变量，或将其清空以使用默认目录。"
        )
    bindir = _env
elif _DEFAULT_BIN.is_dir():
    bindir = str(_DEFAULT_BIN)
else:
    raise SystemExit(
        "[错误] 找不到 libass 依赖目录（含 libass-9.dll 等 DLL 的那一层）。\n"
        f"  默认候选：{_DEFAULT_BIN}\n"
        "  可用环境变量 PP_LIBASS_BIN=<目录> 指定。"
    )
print(f"[bindir] {bindir}")
os.add_dll_directory(bindir)
os.environ["PATH"] = bindir + os.pathsep + os.environ.get("PATH", "")

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
LOAD_WITH_ALTERED_SEARCH_PATH = 0x00000008
LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR = 0x00000100

DLLS = [
    "libass-9.dll", "libbrotlicommon.dll", "libbrotlidec.dll", "libbz2-1.dll",
    "libexpat-1.dll", "libfontconfig-1.dll", "libfreetype-6.dll", "libfribidi-0.dll",
    "libglib-2.0-0.dll", "libgraphite2.dll", "libharfbuzz-0.dll", "libiconv-2.dll",
    "libintl-8.dll", "libpcre2-8-0.dll", "libpng16-16.dll", "libunibreak-7.dll",
    "zlib1.dll",
]

loaded = []
for name in DLLS:
    path = os.path.join(bindir, name)
    try:
        h = kernel32.LoadLibraryExW(path, 0, LOAD_WITH_ALTERED_SEARCH_PATH)
        if h == 0:
            err = ctypes.get_last_error()
            print(f"[FAIL] {name}: LoadLibraryExW=0  err={err} ({ctypes.FormatError(err)})")
        else:
            loaded.append(name)
            print(f"[OK]   {name}")
    except Exception as e:
        print(f"[EXC]  {name}: {e!r}")

print(f"\nloaded {len(loaded)}/{len(DLLS)}")
# now try libass init
if "libass-9.dll" in loaded:
    lib = ctypes.CDLL(os.path.join(bindir, "libass-9.dll"))
    init = lib.ass_library_init
    init.restype = ctypes.c_void_p
    init.argtypes = []
    h = init()
    print("ass_library_init ->", hex(h) if h else h)
    print("[PASS] libass runtime loadable, closure complete")
