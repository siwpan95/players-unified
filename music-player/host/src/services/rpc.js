// RPC service: 无头 JSON-RPC 2.0 控制桥（对齐 Python engine/rpc_bridge.py 的
// 协议 + ui/app_window.py 的 `_rpc_execute` 命令面与返回契约）。
//
// 协议：TCP，每行一个 JSON 请求，响应每行一个 JSON（与 Python 侧完全一致），
// 使 A/B 对拍脚本可复用同一份 transcript（只换端口）。
//
//   --> {"jsonrpc":"2.0","method":"status","params":{},"id":1}
//   <-- {"jsonrpc":"2.0","result":{...},"id":1}
//
// 方法：play/pause/resume/stop/next/prev/play_index/seek/volume/mute/
//       set_mode/equalizer/add_files/status/playlist/ping

import net from 'node:net';
import { Service } from '../core/index.js';
import { playerState, displayTitle, isRadioMedia } from '../lib/contract.js';

export class RpcService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'rpc');
    this.ctx = ctx;
    this.host = config.host || '127.0.0.1';
    this.port = config.port || 7700;
    this._server = net.createServer((socket) => this._handle(socket));
    this._server.listen(this.port, this.host, () => {
      ctx.logger?.info?.(`JSON-RPC listening on ${this.host}:${this.port}`);
    });
    ctx.on('dispose', () => { try { this._server.close(); } catch { /* ignore */ } });
  }

  _handle(socket) {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let resp;
        try {
          const req = JSON.parse(line);
          if (typeof req !== 'object' || req === null || Array.isArray(req)) throw new Error('请求不是 JSON 对象');
          const method = req.method;
          const params = (req.params && typeof req.params === 'object' && !Array.isArray(req.params)) ? req.params : {};
          const id = req.id;
          this._execute(method, params).then(
            (result) => socket.write(JSON.stringify({ jsonrpc: '2.0', result, id }) + '\n'),
            (e) => socket.write(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: String(e && e.message || e) }, id }) + '\n'),
          );
        } catch (e) {
          resp = { jsonrpc: '2.0', error: { code: -32700, message: `parse error: ${e && e.message || e}` } };
          socket.write(JSON.stringify(resp) + '\n');
        }
      }
    });
  }

  async _execute(method, params) {
    const player = this.ctx.get('player');
    const playlist = this.ctx.get('playlist');
    switch (method) {
      case 'ping': return { pong: true };

      case 'play': {
        if (!playlist.current) {
          const media = await playlist.play(playlist.currentIndex >= 0 ? playlist.currentIndex : 0);
          if (!media) break;
        } else {
          // toggle_pause（对齐 Python：playing -> pause，否则 play）
          if (player.getState().status === 'playing') player.pause();
          else player.play();
        }
        return playerState(this.ctx);
      }

      case 'pause': player.pause(); return { status: 'paused' };
      case 'resume': player.play(); return { status: 'playing' };
      case 'stop': player.stop(); return { status: 'stopped' };

      case 'next': { await playlist.next(); return this._current(); }
      case 'prev': { await playlist.prev(); return this._current(); }

      case 'play_index': {
        const idx = parseInt(params.index ?? -1, 10);
        if (idx >= 0 && idx < playlist.length) await playlist.play(idx);
        return this._current();
      }

      case 'seek': {
        if (params.position_ms != null) {
          player.seekMs(parseInt(params.position_ms, 10));
        } else if (params.fraction != null) {
          const lenMs = (player.getState().duration || 0) * 1000;
          player.seekMs(Math.round(parseFloat(params.fraction) * lenMs));
        }
        const st = player.getState();
        return { position_ms: Math.round(st.currentTime * 1000), duration_ms: Math.round(st.duration * 1000) };
      }

      case 'volume': {
        const v = Math.max(0, Math.min(100, parseInt(params.value ?? 80, 10)));
        player.setVolume(v);
        return { volume: v };
      }

      case 'mute': {
        player.setMute(!!(params.value ?? true));
        return { mute: player.getState().muted };
      }

      case 'set_mode': {
        playlist.setMode(params.mode || 'sequential');
        return { mode: playlist.mode };
      }

      case 'equalizer': {
        const eq = this.ctx.get('equalizer');
        if (eq) {
          const r = await eq.setEqualizer({ preset: params.preset, bands: params.bands });
          return r; // { equalizer_on }
        }
        return { equalizer_on: false };
      }

      case 'add_files': {
        const paths = params.paths || [];
        const items = [];
        for (const p of paths) items.push(player.constructor.mediaFromPath(String(p)));
        for (const it of items) playlist.add(it);
        return { added: items.length };
      }

      case 'status': return playerState(this.ctx);

      case 'playlist': {
        return playlist.getList().map((it, i) => ({ index: i, title: displayTitle(it), radio: isRadioMedia(it) }));
      }

      default: throw new Error(`未知方法: ${method}`);
    }
    return playerState(this.ctx);
  }

  _current() {
    const player = this.ctx.get('player');
    const playlist = this.ctx.get('playlist');
    const ps = player.getState();
    const status = ps.status === 'ended' ? 'stopped' : ps.status;
    return { index: playlist.currentIndex, uri: ps.uri || '', status };
  }
}

export default RpcService;
