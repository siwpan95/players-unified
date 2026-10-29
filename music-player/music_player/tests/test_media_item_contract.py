from music_player.engine import MediaItem, MediaType


def test_local_file_not_radio():
    it = MediaItem(name="x", path="a.mp3", item_type=MediaType.LOCAL_FILE)
    assert not it.is_radio
    assert it.display_title == "x"


def test_radio_flag():
    it = MediaItem(name="R", path="http://h/live.m3u8", item_type=MediaType.RADIO_HLS)
    assert it.is_radio


def test_display_with_artist():
    it = MediaItem(name="x", path="a.mp3", item_type=MediaType.LOCAL_FILE,
                   metadata={"artist": "A", "title": "T"})
    assert it.display_title == "A - T"


def test_decrypted_keeps_source():
    it = MediaItem(name="n", path="cache/x.mp3", item_type=MediaType.DECRYPTED_CACHE,
                   source_path="orig.ncm")
    assert it.source_path == "orig.ncm"
