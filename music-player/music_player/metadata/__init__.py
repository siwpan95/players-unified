"""元数据：mutagen 标签/封面读取、LRC 歌词解析。"""
from .metadata_cache import MetadataCache
from .cover import extract_cover
from .lrc_parser import LrcParser

__all__ = ["MetadataCache", "extract_cover", "LrcParser"]
