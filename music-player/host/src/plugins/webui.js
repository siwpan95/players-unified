// Web UI plugin: a zero-dependency local web app for the host.
//
// Uses only node:http (no Express) to serve the static browser UI from
// ../public and a small REST + SSE API. State is authoritative server-side
// (the Cordis services); the browser only renders and sends commands.
//
// Plugin shape (Cordis): export function webUi(ctx, config) { ... }
// It resolves the `player` and `playlist` services lazily via ctx.get().

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { playerState, displayTitle, isRadioMedia } from '../lib/contract.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function webUi(ctx, config = {}) {
  const port = config.port || 19718;
  const host = config.host || '127.0.0.1';

  const clients = new Set(); // SSE response objects

  const snapshot = () => {
    const playlist = ctx.get('playlist');
    const lyrics = ctx.get('lyrics');
    const viz = ctx.get('visualizer');
    return {
      ...playerState(ctx), // Python PlayerState 契约字段
      current: playlist ? playlist.current : null,
      playlist: playlist ? playlist.getList().map((it, i) => ({
        index: i, title: displayTitle(it), radio: isRadioMedia(it),
        current: i === playlist.currentIndex,
      })) : [],
      lyricsLoaded: lyrics ? lyrics.loaded : false,
      viz: viz ? { mode: viz.mode, durationMs: viz.durationMs } : null,
    };
  };

  const broadcast = () => {
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* ignore broken pipe */ }
    }
  };

  // Push a fresh snapshot whenever anything interesting changes.
  const events = ['player/state', 'player/position', 'player/end', 'player/current', 'playlist/changed', 'playlist/current', 'playlist/ended', 'equalizer/changed', 'lyrics/loaded', 'visualizer/ready'];
  const offs = events.map((e) => ctx.on(e, broadcast));

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  async function readBody(req) {
    let data = '';
    for await (const chunk of req) data += chunk;
    if (!data) return {};
    try { return JSON.parse(data); } catch { return {}; }
  }

  async function serveStatic(req, res, url) {
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) throw new Error('is dir');
      const buf = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // SSE live stream
    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url);
      } catch (e) {
        ctx.logger?.error?.('api error', e);
        sendJson(res, 500, { error: String(e && e.message || e) });
      }
      return;
    }

    // static assets
    await serveStatic(req, res, url);
  });

  async function handleApi(req, res, url) {
    const player = ctx.get('player');
    const playlist = ctx.get('playlist');
    if (!player || !playlist) { sendJson(res, 503, { error: 'services not ready' }); return; }

    const sp = url.searchParams;

    switch (url.pathname) {
      case '/api/status':
        sendJson(res, 200, snapshot());
        return;

      case '/api/playlist':
        sendJson(res, 200, { list: playlist.getList(), currentIndex: playlist.currentIndex, mode: playlist.mode });
        return;

      case '/api/play': {
        // no `index` param -> resume current (or start first if nothing playing)
        if (!sp.has('index')) {
          if (playlist.currentIndex >= 0) player.play();
          else if (playlist.length > 0) await playlist.play(0);
          sendJson(res, 200, { ok: true, current: playlist.currentIndex });
          return;
        }
        const index = parseInt(sp.get('index'), 10);
        const media = await playlist.play(index);
        sendJson(res, 200, { ok: !!media, current: playlist.currentIndex });
        return;
      }

      case '/api/pause':
        player.pause();
        sendJson(res, 200, { ok: true });
        return;

      case '/api/stop':
        player.stop();
        sendJson(res, 200, { ok: true });
        return;

      case '/api/next': {
        const media = await playlist.next();
        sendJson(res, 200, { ok: !!media, current: playlist.currentIndex });
        return;
      }

      case '/api/prev': {
        const media = await playlist.prev();
        sendJson(res, 200, { ok: !!media, current: playlist.currentIndex });
        return;
      }

      case '/api/seek': {
        const ms = sp.has('ms') ? parseInt(sp.get('ms'), 10) : NaN;
        const frac = sp.has('f') ? parseFloat(sp.get('f')) : NaN;
        if (!Number.isNaN(frac)) player.seekFraction(frac);
        else if (!Number.isNaN(ms)) player.seekMs(ms);
        sendJson(res, 200, { ok: true });
        return;
      }

      case '/api/volume': {
        const v = parseInt(sp.get('v'), 10);
        if (!Number.isNaN(v)) player.setVolume(v);
        sendJson(res, 200, { ok: true });
        return;
      }

      case '/api/mute': {
        const m = sp.get('m') === '1' || sp.get('m') === 'true';
        player.setMute(m);
        sendJson(res, 200, { ok: true });
        return;
      }

      case '/api/mode': {
        const m = sp.get('m');
        if (m) playlist.setMode(m);
        sendJson(res, 200, { ok: true, mode: playlist.mode });
        return;
      }

      case '/api/add': {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const items = Array.isArray(body.paths)
          ? body.paths
          : [body];
        let firstAdded = -1;
        for (const it of items) {
          if (!it || !it.path) continue;
          const media = player.constructor.mediaFromPath(it.path, it.title);
          const idx = playlist.add(media);
          if (firstAdded < 0) firstAdded = idx - 1;
        }
        // auto-play the first added track if nothing is playing yet
        if (playlist.currentIndex < 0 && firstAdded >= 0) await playlist.play(firstAdded);
        sendJson(res, 200, { ok: true, length: playlist.length, currentIndex: playlist.currentIndex });
        return;
      }

      case '/api/remove': {
        const index = parseInt(sp.get('index'), 10);
        const ok = playlist.removeAt(index);
        sendJson(res, 200, { ok });
        return;
      }

      case '/api/equalizer': {
        const eq = ctx.get('equalizer');
        if (!eq) { sendJson(res, 503, { error: 'equalizer service unavailable' }); return; }
        const preset = sp.get('preset') || undefined;
        const bandsStr = sp.get('bands');
        const bands = bandsStr ? bandsStr.split(',').map((s) => parseFloat(s.trim())) : undefined;
        const r = await eq.setEqualizer({ preset, bands });
        sendJson(res, 200, r);
        return;
      }

      case '/api/lyrics': {
        const lyrics = ctx.get('lyrics');
        if (!lyrics) { sendJson(res, 200, { loaded: false, lines: [], current: null }); return; }
        const posMs = sp.has('position_ms') ? parseInt(sp.get('position_ms'), 10) : (player.getState().currentTime * 1000);
        sendJson(res, 200, { loaded: lyrics.loaded, lines: lyrics.lines, current: lyrics.lineAt(posMs) });
        return;
      }

      case '/api/visualizer/frame': {
        const viz = ctx.get('visualizer');
        const posMs = sp.has('position_ms') ? parseInt(sp.get('position_ms'), 10) : (player.getState().currentTime * 1000);
        const frame = viz ? viz.frameAt(posMs) : null;
        sendJson(res, 200, { frame: frame ? Array.from(frame) : null, durationMs: viz ? viz.durationMs : 0 });
        return;
      }

      case '/api/radio': {
        const body = req.method === 'POST' ? await readBody(req) : {};
        if (body.m3u) {
          const { RadioManager } = await import('../lib/radio.js');
          const rm = new RadioManager();
          const items = rm.parseM3u(body.m3u);
          for (const it of items) playlist.add({ uri: it.path, path: it.path, title: it.name, item_type: it.item_type });
          sendJson(res, 200, { added: items.length });
          return;
        }
        if (body.url) {
          const kind = String(body.url).toLowerCase().endsWith('.m3u8') ? 'hls' : 'http';
          const itemType = kind === 'hls' ? 'radio_hls' : 'radio_http';
          const media = { uri: body.url, path: body.url, title: body.name || body.url, item_type: itemType };
          playlist.add(media);
          if (playlist.currentIndex < 0) await playlist.play(playlist.length - 1);
          sendJson(res, 200, { added: 1 });
          return;
        }
        sendJson(res, 400, { error: 'need url or m3u' });
        return;
      }

      case '/api/import-encrypted': {
        const svc = ctx.get('encrypted-import');
        if (!svc) { sendJson(res, 503, { error: 'encrypted-import unavailable' }); return; }
        const body = req.method === 'POST' ? await readBody(req) : {};
        if (!body.path) { sendJson(res, 400, { error: 'need path' }); return; }
        try {
          const media = svc.importEncrypted(body.path, { outputFormat: body.format || 'mp3', bitrate: body.bitrate || '320k' });
          playlist.add(media);
          if (playlist.currentIndex < 0) await playlist.play(playlist.length - 1);
          sendJson(res, 200, { ok: true, title: media.title, path: media.path });
        } catch (e) {
          sendJson(res, 500, { error: String(e && e.message || e) });
        }
        return;
      }

      default:
        sendJson(res, 404, { error: 'unknown endpoint' });
    }
  }

  server.listen(port, host, () => {
    ctx.logger?.info?.(`web UI listening on http://${host}:${port}`);
  });

  // lifecycle: close server + remove SSE listeners on dispose
  ctx.on('dispose', () => {
    for (const off of offs) off();
    for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
    clients.clear();
    server.close();
  });

  return { server, port, host };
}

export default webUi;
