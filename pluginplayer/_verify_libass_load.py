import os, ctypes, sys

# 2026-09-23 去本地化：不再写死本机绝对路径（原路径已不存在）。
# 解析顺序：环境变量 PP_LIBASS_BIN → 本脚本同级 vendor/libass/bin → 报错并点名该设哪个变量。
from pathlib import Path

_HERE = Path(__file__).resolve().parent
# 运行时闭包目录候选：本目录下的 dist/（本仓自建产物）→ 上级仓的 dist/
_RUNTIME_CANDS = [_HERE / "dist", _HERE.parent / "dist"]
_RUNTIME_BIN = next((d for d in _RUNTIME_CANDS if (d / "libass-9.dll").is_file()), _RUNTIME_CANDS[0])
_LINKTIME_BIN = _HERE / "vendor" / "libass" / "bin"   # 链接期依赖（include/lib + 部分 DLL，不含 MinGW 运行时三件套）

_env = os.environ.get("PP_LIBASS_BIN", "").strip()
if _env:
    # 显式配置必须生效或明确报错——不静默回退（否则设错路径会被掩盖）
    if not Path(_env).is_dir():
        raise SystemExit(
            f"[错误] PP_LIBASS_BIN 指向的目录不存在：{_env}\n"
            f"  它是显式配置，本脚本不会静默回退到其它目录。\n"
            f"  请改正该环境变量，或将其清空以使用自动探测（优先 {_RUNTIME_BIN}）。"
        )
    bindir, why = _env, "环境变量 PP_LIBASS_BIN"
elif _RUNTIME_BIN.is_dir() and (_RUNTIME_BIN / "libass-9.dll").is_file():
    bindir, why = str(_RUNTIME_BIN), "构建产物 dist/（运行时闭包）"
elif (_LINKTIME_BIN / "libass-9.dll").is_file():
    bindir, why = str(_LINKTIME_BIN), "vendor/libass/bin（链接期依赖，可能缺 MinGW 运行时三件套）"
else:
    raise SystemExit(
        "[错误] 找不到 libass 依赖目录（含 libass-9.dll 的那一层）。\n"
        f"  已尝试：{_RUNTIME_BIN}（运行时闭包）、{_LINKTIME_BIN}（链接期）\n"
        "  可先 `python build.py` 生成 dist/，或用环境变量 PP_LIBASS_BIN=<目录> 指定。"
    )
print(f"[bindir] {bindir}   （{why}）")
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
    # MinGW 运行时三件套（libass-9.dll 的传递依赖；缺失即整条加载链失败，故显式列出）
    "libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll",
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
if len(loaded) < len(DLLS):
    print("提示：若失败较多，说明该目录只提供链接期依赖（缺 MinGW 运行时 libgcc/libstdc++/libwinpthread）；"
          f"运行时闭包在 {_RUNTIME_BIN}（先跑 python build.py 生成）。")
    # 不能只打印提示就返回 0：退出码必须反映失败，否则冒烟/CI 会假绿。
    raise SystemExit(1)
if "libass-9.dll" not in loaded:
    print("[FAIL] libass-9.dll 未能加载，闭包不完整")
    raise SystemExit(1)
# now try libass init
lib = ctypes.CDLL(os.path.join(bindir, "libass-9.dll"))
init = lib.ass_library_init
init.restype = ctypes.c_void_p
init.argtypes = []
h = init()
print("ass_library_init ->", hex(h) if h else h)
if not h:
    print("[FAIL] ass_library_init 返回 NULL，libass 运行时不可用")
    raise SystemExit(1)
print("[PASS] libass runtime loadable, closure complete")
raise SystemExit(0)
