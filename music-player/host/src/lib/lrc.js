// LRC 歌词解析（对齐 Python music_player/metadata/lrc_parser.py）。
//
// 纯逻辑、零依赖、框架无关，便于单测与 A/B 对拍。
// 时间标签 `[mm:ss.xx]` / `[mm:ss.xxx]` → (ms, 文本)，支持二分定位当前行。

import { readFileSync } from 'node:fs';

const LINE_TAG_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

function toMs(mm, ss, frac) {
  const f = (frac || '0').padEnd(3, '0').slice(0, 3);
  return parseInt(mm, 10) * 60000 + parseInt(ss, 10) * 1000 + (parseInt(f, 10) || 0);
}

export class LrcParser {
  static parse(text) {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
      const tags = [...raw.matchAll(LINE_TAG_RE)];
      if (tags.length === 0) continue;
      const content = raw.replace(LINE_TAG_RE, '').trim();
      for (const m of tags) {
        lines.push([toMs(m[1], m[2], m[3]), content]);
      }
    }
    lines.sort((a, b) => a[0] - b[0]);
    return lines;
  }

  static parseFile(path) {
    return LrcParser.parse(readFileSync(path, 'utf8'));
  }

  constructor({ path = null, text = null } = {}) {
    if (path) this.lines = LrcParser.parseFile(path);
    else if (text != null) this.lines = LrcParser.parse(text);
    else this.lines = [];
  }

  /** 返回最后一个 time <= position_ms 的行索引；无则 -1。 */
  lineAt(positionMs) {
    let lo = 0;
    let hi = this.lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.lines[mid][0] <= positionMs) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }
}

export default LrcParser;
