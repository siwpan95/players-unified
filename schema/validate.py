"""players-unified MediaItem 最小化 JSON-Schema 校验器（纯标准库，零三方依赖）。

仅实现 schema/media-item.schema.json 实际用到的子能力：
- $ref 解析（#/definitions/...）
- type（含 ["string","null"] 这类联合类型）
- enum
- required
- properties
- items（数组元素，支持 $ref）

schema 未设 additionalProperties:false，因此允许额外字段（如 localplayer 的过渡别名
name/type/path），不影响 MediaItem 契约校验。
"""
import json
import os


SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'media-item.schema.json')


def load_schema(path=SCHEMA_PATH):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _type_ok(value, typ):
    if typ == 'string':
        return isinstance(value, str)
    if typ == 'number':
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if typ == 'integer':
        return isinstance(value, int) and not isinstance(value, bool)
    if typ == 'boolean':
        return isinstance(value, bool)
    if typ == 'array':
        return isinstance(value, list)
    if typ == 'object':
        return isinstance(value, dict)
    if typ == 'null':
        return value is None
    return False


def validate(value, schema, root=None, path=''):
    """校验 value 是否符合 schema；不符合则抛 ValueError（带路径信息）。"""
    if root is None:
        root = schema

    if '$ref' in schema:
        ref = schema['$ref']
        parts = ref.lstrip('#/').split('/')
        target = root
        for p in parts:
            target = target[p]
        return validate(value, target, root, path)

    if 'type' in schema:
        t = schema['type']
        if isinstance(t, list):
            if not any(_type_ok(value, tt) for tt in t):
                raise ValueError(f"{path or '<root>'}: 期望类型 {t}，实际 {type(value).__name__}")
        else:
            if not _type_ok(value, t):
                raise ValueError(f"{path or '<root>'}: 期望类型 {t}，实际 {type(value).__name__}")

    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(f"{path or '<root>'}: 值 {value!r} 不在 enum {schema['enum']}")

    if 'required' in schema:
        if not isinstance(value, dict):
            raise ValueError(f"{path or '<root>'}: required 需要 object，实际 {type(value).__name__}")
        for r in schema['required']:
            if r not in value:
                raise ValueError(f"{path or '<root>'}: 缺必需字段 {r}")

    if 'properties' in schema and isinstance(value, dict):
        for k, sub in schema['properties'].items():
            if k in value:
                child = f"{path}.{k}" if path else k
                validate(value[k], sub, root, child)

    if 'items' in schema and isinstance(value, list):
        for i, item in enumerate(value):
            validate(item, schema['items'], root, f"{path}[{i}]")

    return True


def validate_media_item(item, schema=None):
    """便捷函数：直接校验单个 MediaItem（按 definitions.MediaItem）。"""
    if schema is None:
        schema = load_schema()
    return validate(item, schema['definitions']['MediaItem'])
