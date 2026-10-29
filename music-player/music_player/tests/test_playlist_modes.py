from music_player.engine import MediaItem, MediaType, PlayMode
from music_player.library import PlaylistModel


def _items(n):
    return [MediaItem(name=f"s{i}", path=f"{i}.mp3", item_type=MediaType.LOCAL_FILE)
            for i in range(n)]


def test_sequential_advances_then_stops():
    pl = PlaylistModel(PlayMode.SEQUENTIAL)
    pl.add(_items(3))
    assert pl.next().name == "s0"
    assert pl.next().name == "s1"
    assert pl.next().name == "s2"
    assert pl.next() is None


def test_loop_wraps():
    pl = PlaylistModel(PlayMode.LOOP)
    pl.add(_items(2))
    assert pl.next().name == "s0"
    assert pl.next().name == "s1"
    assert pl.next().name == "s0"


def test_single_repeats_current():
    pl = PlaylistModel(PlayMode.SINGLE)
    pl.add(_items(2))
    pl.jump(1)
    assert pl.next().name == "s1"
    assert pl.next().name == "s1"


def test_random_covers_all_without_repeat():
    pl = PlaylistModel(PlayMode.RANDOM)
    items = _items(5)
    pl.add(items)
    seen = set()
    for _ in range(5):
        it = pl.next()
        assert it is not None
        seen.add(it.name)
    assert seen == {"s0", "s1", "s2", "s3", "s4"}


def test_prev_sequential():
    pl = PlaylistModel(PlayMode.SEQUENTIAL)
    pl.add(_items(3))
    pl.jump(2)
    assert pl.prev().name == "s1"
    assert pl.prev().name == "s0"


def test_remove_adjusts_index():
    pl = PlaylistModel()
    pl.add(_items(3))
    pl.jump(2)
    pl.remove(0)
    assert pl.index() == 1
    assert pl.items()[0].name == "s1"
