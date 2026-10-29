from pathlib import Path

from music_player.engine import MediaItem, MediaType
from music_player.metadata import MetadataCache
from music_player.utils.paths import app_cache_dir


def test_metadata_and_cover(fixtures_dir):
    item = MediaItem(name="tagged", path=str(fixtures_dir / "sample_tagged.mp3"),
                     item_type=MediaType.LOCAL_FILE)
    cache = MetadataCache(str(app_cache_dir()))
    info = cache.get(item)
    assert info.get("title") == "Test Title"
    assert info.get("artist") == "Test Artist"
    assert info.get("duration_ms", 0) > 0

    cover = cache.fetch_cover(item)
    assert cover and Path(cover).exists()
