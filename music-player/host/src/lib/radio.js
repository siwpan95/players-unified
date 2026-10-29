// 网络电台 / HLS 流管理（对齐 Python music_player/library/radio_manager.py）。
//
// VLC 原生支持 .m3u8 (HLS) 与普通 HTTP 流，无需额外解码器。本模块只维护
// 电台条目与 .m3u/.m3u8 播放列表解析；单源降级（degrade）保留扩展点。

import { readFileSync } from 'node:fs';

export const MediaType = Object.freeze({
  LOCAL_FILE: 'local_file',
  DECRYPTED_CACHE: 'decrypted_cache',
  RADIO_HLS: 'radio_hls',
  RADIO_HTTP: 'radio_http',
});

export class RadioManager {
  constructor() {
    this._stations = [];
  }

  addStation(name, url, kind = 'hls') {
    const mtype = (kind === 'hls' || kind === '.m3u8') ? MediaType.RADIO_HLS : MediaType.RADIO_HTTP;
    const item = { name, path: url, item_type: mtype };
    this._stations.push(item);
    return item;
  }

  /** 解析 .m3u/.m3u8 文本（#EXTINF 名称 + URL）。 */
  parseM3u(text) {
    const items = [];
    let curName = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF')) {
        if (line.includes(',')) curName = line.slice(line.indexOf(',') + 1).trim();
      } else if (line && !line.startsWith('#')) {
        const kind = line.toLowerCase().endsWith('.m3u8') ? 'hls' : 'http';
        items.push(this.addStation(curName || line, line, kind));
        curName = null;
      }
    }
    return items;
  }

  fromM3uFile(path) {
    return this.parseM3u(readFileSync(path, 'utf8'));
  }

  list() {
    return [...this._stations];
  }

  /** 单源降级：当前返回 null（无备用源），可在此接入多 CDN 备选。 */
  degrade(_item) {
    return null;
  }
}

export default RadioManager;
