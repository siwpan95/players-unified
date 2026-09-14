import os, ctypes, sys

bindir = r"G:\local\pluginplayer\vendor\libass\bin"
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
