// Lyrics service: LRC 歌词加载与当前行定位（对齐 Python ui/lyrics_panel 的
// 数据侧；解析逻辑在 lib/lrc.js）。
//
// 只为本地媒体按「同名 .lrc」加载歌词（电台流无歌词）。纯逻辑 + 文件读取，
// 不依赖 VLC。

import { Service } from '../core/index.js';
import { existsSync } from 'node:fs';
import { LrcParser } from '../lib/lrc.js';
import { isRadioMedia } from '../lib/contract.js';

export class LyricsService extends Service {
  constructor(ctx) {
    super(ctx, 'lyrics');
    this.ctx = ctx;
    this._parser = null;
    this._path = null;
  }

  /** 为媒体加载同名 .lrc；成功返回 true。 */
  loadForMedia(media) {
    this._parser = null;
    this._path = media ? media.path : null;
    if (!media || !media.path || isRadioMedia(media)) return false;
    const lrcPath = media.path.replace(/\.[^.]+$/, '.lrc');
    if (!existsSync(lrcPath)) return false;
    try {
      this._parser = new LrcParser({ path: lrcPath });
      this.ctx.emit('lyrics/loaded', this.lines.length);
      return true;
    } catch {
      this._parser = null;
      return false;
    }
  }

  loadText(text) {
    this._parser = new LrcParser({ text });
    this._path = null;
    return true;
  }

  get loaded() { return this._parser !== null; }

  get lines() {
    return this._parser ? this._parser.lines.map(([time, text]) => ({ time, text })) : [];
  }

  /** 返回 position_ms 处的当前行 {index,time,text}；无则 null。 */
  lineAt(positionMs) {
    if (!this._parser) return null;
    const idx = this._parser.lineAt(positionMs);
    if (idx < 0) return null;
    return { index: idx, time: this._parser.lines[idx][0], text: this._parser.lines[idx][1] };
  }
}

export default LyricsService;
