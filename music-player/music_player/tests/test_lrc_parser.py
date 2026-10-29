from music_player.metadata import LrcParser

LRC = "[00:01.00]line one\n[00:03.50]line two\n[00:10.00]line three\n"


def test_parse_counts_and_offsets():
    lines = LrcParser.parse(LRC)
    assert len(lines) == 3
    assert lines[0] == (1000, "line one")
    assert lines[1] == (3500, "line two")
    assert lines[2] == (10000, "line three")


def test_parse_multiple_tags_per_line():
    lines = LrcParser.parse("[00:00.00][00:05.00]repeat\n")
    assert len(lines) == 2


def test_line_at_binary_search():
    p = LrcParser(text=LRC)
    assert p.line_at(0) == -1   # 首行之前无歌词
    assert p.line_at(1000) == 0
    assert p.line_at(2000) == 0
    assert p.line_at(3500) == 1
    assert p.line_at(9000) == 1
    assert p.line_at(10000) == 2
    assert p.line_at(999999) == 2
