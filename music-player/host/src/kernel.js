// VLC control kernel via the RC (remote control) TCP interface.
//
// Verified protocol (probed against E:\VLC 3.0.24):
//   * spawn: vlc --intf=dummy --extraintf=rc --rc-host=127.0.0.1:PORT --no-video --no-osd
//   * volume scale: 256 == 100%  (so 50% -> volume 128)
//   * state codes: 3 playing, 4 paused, 5 stopped, 6 ended, 7 error
//   * `get_length` / `get_time` print the value in SECONDS directly
//   * `seek <sec>` is ABSOLUTE seconds
//   * END-OF-TRACK: VLC emits `status change: ( play state: 4 ): End`
//     (the ": End" suffix distinguishes a finished track from a user pause)
//
// This module is framework-agnostic (no Cordis import) so it can be unit
// tested and reused. The Cordis Service wraps it.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const VLC_STATE = { 0: 'idle', 1: 'opening', 2: 'buffering', 3: 'playing', 4: 'paused', 5: 'stopped', 6: 'ended', 7: 'error' };
const VOLUME_FULL = 256; // VLC's "100%"

const URL_SCHEME_RE = /^(https?|rtsp|rtmp|mms|ftp):\/\//i;

export function toVlcUri(path) {
  const p = path.replace(/\\/g, '/');
  // 网络流 URL（电台/HLS）原样返回，不转 file:///
  if (URL_SCHEME_RE.test(p)) return p;
  let abs = p;
  if (!/^file:/i.test(abs)) {
    abs = 'file:///' + (p.startsWith('/') ? p.slice(1) : p);
  }
  return abs.split(/[?#]/)[0].replace(/ /g, '%20');
}

export class PlayerKernel {
  constructor({ vlcPath = 'E:/VLC/vlc.exe', rcPort = 18199, logger = console, debug = false, extraArgs = [] } = {}) {
    this.vlcPath = vlcPath;
    this.rcPort = rcPort;
    this.logger = logger;
    this.debug = debug;
    this._extraArgs = extraArgs;
    this._proc = null;
    this._client = null;
    this._buf = '';
    this._listeners = Object.create(null);
    this._state = {
      status: 'stopped',
      uri: '',
      currentTime: 0,
      duration: 0,
      volume: 80,
      muted: false,
    };
    this._prevTime = 0;
    this._endedFired = false;
    this._pollTimer = null;
    this._started = false;
    this._queue = []; // commands buffered until the RC socket is connected
    this._stopping = false;
  }

  // ---- tiny event emitter ----
  on(event, fn) { (this._listeners[event] ||= new Set()).add(fn); return () => this._listeners[event]?.delete(fn); }
  _emit(event, ...args) { for (const fn of this._listeners[event] || []) { try { fn(...args); } catch (e) { this.logger.error?.('kernel listener', e); } } }

  getState() { return { ...this._state }; }

  async start() {
    if (this._started) return;
    this._started = true;
    await this._spawnVlc();
    await this._connect();
    this._flushQueue();
    this._pollTimer = setInterval(() => this._poll(), 400);
  }

  async stopProcess() {
    this._stopping = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    try { this._send('quit'); } catch { /* ignore */ }
    try { if (this._client) this._client.destroy(); } catch { /* ignore */ }
    try { if (this._proc) this._proc.kill('SIGKILL'); } catch { /* ignore */ }
  }

  /** 用新参数重启 VLC（用于运行时切换均衡器等启动参数）。 */
  async restart(newExtraArgs = null) {
    if (newExtraArgs !== null) this._extraArgs = newExtraArgs;
    const oldProc = this._proc;
    const exited = oldProc ? new Promise((r) => oldProc.once('exit', r)) : Promise.resolve();
    await this.stopProcess();
    await exited; // 等 VLC 真正退出，避免 exit 事件误报 "exited early"
    this._started = false;
    this._stopping = false;
    this._client = null;
    this._proc = null;
    this._queue = [];
    this._buf = '';
    this._pollTimer = null;
    this._endedFired = false;
    this._lastNumber = undefined;
    await this.start();
  }

  _spawnVlc() {
    return new Promise((resolve, reject) => {
      const args = [
        '--intf=dummy', '--extraintf=rc',
        `--rc-host=127.0.0.1:${this.rcPort}`,
        '--no-video', '--no-osd',
        ...this._extraArgs,
      ];
      this.logger.info?.('spawning VLC:', this.vlcPath, args.join(' '));
      this._proc = spawn(this.vlcPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let diag = '';
      const onErr = (d) => { diag += d.toString(); };
      this._proc.stdout.on('data', onErr);
      this._proc.stderr.on('data', onErr);
      this._proc.on('exit', (code) => {
        if (this._stopping) return; // intentional shutdown
        this.logger.error?.('VLC exited early, code', code, diag.slice(-500));
        reject(new Error(`VLC exited early (code ${code}): ${diag.slice(-300)}`));
      });
      // give VLC a moment to bind the RC port
      sleep(1000).then(resolve);
    });
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const tryConnect = () => {
        const c = net.connect(this.rcPort, '127.0.0.1');
        c.on('connect', () => {
          this._client = c;
          this.logger.info?.('VLC RC connected on port', this.rcPort);
          c.on('data', (d) => this._onData(d.toString()));
          c.on('error', (e) => this.logger.error?.('RC socket error', e.message));
          resolve();
        });
        c.on('error', () => {
          c.destroy();
          if (Date.now() > deadline) reject(new Error('cannot connect to VLC RC port'));
          else setTimeout(tryConnect, 200);
        });
      };
      tryConnect();
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      if (this.debug) this.logger.info?.('RC<<', JSON.stringify(line));
      // async status-change notifications (may carry a trailing ": End" tag)
      const sc = line.match(/status change:\s*\(([^)]*)\)\s*(?::\s*(.*))?/);
      if (sc) { this._parseStatusChange(sc[1], sc[2] || ''); continue; }
      // numeric query responses (get_length / get_time) come as bare numbers
      const num = line.match(/^(\d+)$/);
      if (num) { this._lastNumber = parseInt(num[1], 10); continue; }
    }
  }

  _parseStatusChange(text, suffix = '') {
    const isEnd = /\bEnd\b/i.test(suffix);
    const st = text.match(/state:\s*(\d+)/);
    if (st) {
      const code = parseInt(st[1], 10);
      let status = VLC_STATE[code] || 'unknown';
      // VLC signals a finished track as "play state: 4" + ": End" (NOT a
      // dedicated "ended" state). Map it to 'ended' so auto-advance fires.
      if (isEnd && code === 4) status = 'ended';
      if (['playing', 'paused', 'stopped', 'ended', 'error'].includes(status)) {
        if (this._state.status !== status) {
          this._state.status = status;
          this._emit('state', this.getState());
          if ((status === 'stopped' || status === 'ended') && !this._endedFired) {
            this._endedFired = true;
            this._emit('end');
          }
        }
      }
    }
  }

  _send(cmd) {
    if (this._client && this._client.writable) this._client.write(cmd + '\n');
    else this._queue.push(cmd);
  }

  _flushQueue() {
    while (this._queue.length && this._client && this._client.writable) {
      this._client.write(this._queue.shift() + '\n');
    }
  }

  async _query(command) {
    this._lastNumber = undefined;
    this._send(command);
    // poll the parsed number for a short window
    for (let i = 0; i < 10; i++) {
      await sleep(40);
      if (this._lastNumber !== undefined) return this._lastNumber;
    }
    return undefined;
  }

  async _poll() {
    if (!this._client) return;
    const length = await this._query('get_length');
    if (typeof length === 'number') this._state.duration = length;
    const time = await this._query('get_time');
    if (typeof time === 'number') {
      this._state.currentTime = time;
      this._prevTime = time;
    }
    this._emit('position', this._state.currentTime, this._state.duration);
  }

  // ---- commands ----
  async load(uri) {
    // VLC RC quirk: `clear/add/play` does NOT restart a paused media (it stays
    // frozen). Toggle out of pause first so the reload reliably starts.
    if (this._state.status === 'paused') {
      this._send('pause'); // toggle resume
      this._state.status = 'playing';
      await sleep(120);
    }
    this._endedFired = false;
    this._state.uri = uri;
    this._state.currentTime = 0;
    this._state.duration = 0;
    this._send('clear');
    this._send('add ' + uri);
    this._send('play');
    this._state.status = 'playing';
    this._emit('state', this.getState());
  }

  play() {
    // VLC RC: `pause` is a toggle and `play` does NOT resume a paused media.
    if (this._state.status === 'paused') {
      this._send('pause'); // toggle resume
    } else {
      this._send('play');
    }
    this._state.status = 'playing';
    this._emit('state', this.getState());
  }
  pause() {
    if (this._state.status !== 'playing') return; // nothing to pause
    this._send('pause'); // toggle: playing -> paused
    this._state.status = 'paused';
    this._emit('state', this.getState());
  }
  stop() { this._send('stop'); this._endedFired = false; this._state.status = 'stopped'; this._state.currentTime = 0; this._emit('state', this.getState()); }
  seekMs(ms) { const sec = Math.max(0, ms) / 1000; this._send('seek ' + sec.toFixed(0)); this._state.currentTime = sec; }
  seekFraction(f) { if (this._state.duration > 0) this.seekMs(f * this._state.duration * 1000); }

  setVolume(vol0to100) {
    const v = Math.max(0, Math.min(100, Math.round(vol0to100)));
    this._state.volume = v;
    const vlcVol = Math.round((v / 100) * VOLUME_FULL);
    this._send('volume ' + vlcVol);
    this._emit('state', this.getState());
  }

  setMute(mute) {
    this._state.muted = !!mute;
    this._send(mute ? 'volume 0' : `volume ${Math.round((this._state.volume / 100) * VOLUME_FULL)}`);
    this._emit('state', this.getState());
  }
}

export default PlayerKernel;
