"""测试夹具：用 ffmpeg 生成样本音频，用 mutagen 写入标签与封面，生成 sample.lrc。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def _ffmpeg() -> str | None:
    import shutil

    return shutil.which("ffmpeg")


def _make_audio(path: Path) -> bool:
    ff = _ffmpeg()
    if ff is None:
        pytest.skip("ffmpeg 不可用，无法生成音频夹具", allow_module_level=True)
    subprocess.run(
        [ff, "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
         "-acodec", "libmp3lame", "-b:a", "128k", str(path)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return path.exists()


def _tag_with_cover(path: Path) -> None:
    from mutagen.mp3 import MP3
    from mutagen.id3 import APIC, ID3, TIT2, TPE1

    m = MP3(str(path))
    m["TIT2"] = TIT2(encoding=3, text="Test Title")
    m["TPE1"] = TPE1(encoding=3, text="Test Artist")
    m.save()

    # 生成小封面 PNG
    from PIL import Image

    img = Image.new("RGB", (64, 64), (123, 200, 50))
    png = FIXTURES / "_cover.png"
    img.save(png)
    id3 = ID3(str(path))
    id3.add(APIC(encoding=3, mime="image/png", type=3, desc="cover", data=png.read_bytes()))
    id3.save()


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    FIXTURES.mkdir(parents=True, exist_ok=True)

    sample = FIXTURES / "sample.mp3"
    if not sample.exists():
        _make_audio(sample)

    tagged = FIXTURES / "sample_tagged.mp3"
    if not tagged.exists():
        _make_audio(tagged)
        _tag_with_cover(tagged)

    lrc = FIXTURES / "sample.lrc"
    lrc.write_text(
        "[00:01.00]line one\n[00:03.50]line two\n[00:10.00]line three\n",
        encoding="utf-8",
    )
    return FIXTURES


__all__ = ["fixtures_dir"]
