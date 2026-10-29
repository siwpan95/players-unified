// Playlist service: in-memory queue with play modes, ported from the Python
// engine (music_player/engine/play_mode.py + the PlaylistModel contract).
//
// It is a Cordis `Service` named `playlist` on the root context, and it owns
// the "what plays next" decision. It talks to the `player` service lazily
// (via ctx.get('player')) so there is no construction-order dependency.
//
// Auto-advance: we subscribe to the global `player/end` event. When a track
// ends, we advance the queue (replay in SINGLE, next in every other mode) and
// load the chosen track into the player. SEQUENTIAL at the last track stops
// the queue (emits `playlist/ended`) instead of looping.

import { Service } from '../core/index.js';

export const PlayMode = Object.freeze({
  SEQUENTIAL: 'sequential', // 顺序
  LOOP: 'loop',             // 列表循环
  SINGLE: 'single',         // 单曲循环
  RANDOM: 'random',         // 随机
});

export const PLAY_MODES = Object.values(PlayMode);

// ---- Pure navigation functions (ported from play_mode.py) ----
// They take the current index, queue length, mode, plus the played/history
// bookkeeping, and return the next/previous index OR null (no track to go to).

export function nextIndex(current, length, mode, played) {
  if (length <= 0) return null;
  if (current < 0) return 0;

  if (mode === PlayMode.SINGLE) return current;

  if (mode === PlayMode.RANDOM) {
    const remaining = [];
    for (let i = 0; i < length; i++) if (!played.has(i)) remaining.push(i);
    if (remaining.length === 0) {
      played.clear();
      for (let i = 0; i < length; i++) remaining.push(i);
    }
    return remaining[Math.floor(Math.random() * remaining.length)];
  }

  // SEQUENTIAL / LOOP
  const nxt = current + 1;
  if (nxt >= length) return mode === PlayMode.LOOP ? 0 : null;
  return nxt;
}

export function prevIndex(current, length, mode, history) {
  if (length <= 0) return null;
  if (current < 0) return 0;

  if (mode === PlayMode.SINGLE) return current;

  if (mode === PlayMode.RANDOM) {
    // history top is the current track; the previous one is just below it.
    if (history.length >= 2) return history[history.length - 2];
    return current;
  }

  const prev = current - 1;
  if (prev < 0) return mode === PlayMode.LOOP ? length - 1 : null;
  return prev;
}

export class PlaylistService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'playlist');
    this.ctx = ctx;
    this.items = [];          // [{ uri, path, title, ... }]
    this.currentIndex = -1;
    this.mode = config.mode || PlayMode.SEQUENTIAL;
    this._played = new Set(); // indices played at least once (random forward)
    this._history = [];       // visited indices, top = current (random backward)
    this._autoAdvance = config.autoAdvance !== false;

    // Wire auto-advance to the player's end-of-track signal.
    this._offEnd = ctx.on('player/end', () => {
      if (!this._autoAdvance) return;
      ctx.logger?.info?.('[playlist] end-of-track -> auto-advance');
      this.advance().catch((e) => ctx.logger?.error?.('auto-advance failed', e));
    });
    // clean up our bus subscription on host shutdown
    ctx.on('dispose', () => this.dispose());
  }

  // ---- mutations ----
  add(media, at) {
    if (typeof at === 'number' && at >= 0 && at <= this.items.length) {
      this.items.splice(at, 0, media);
    } else {
      this.items.push(media);
    }
    this._emitChanged();
    return this.items.length;
  }

  removeAt(index) {
    if (index < 0 || index >= this.items.length) return false;
    this.items.splice(index, 1);
    this._reindex(index);
    if (index === this.currentIndex) {
      this.currentIndex = -1;
      this.ctx.emit('playlist/current', null, -1);
    } else if (index < this.currentIndex) {
      this.currentIndex -= 1;
    }
    this._emitChanged();
    return true;
  }

  clear() {
    this.items = [];
    this.currentIndex = -1;
    this._played.clear();
    this._history = [];
    this.ctx.emit('playlist/current', null, -1);
    this._emitChanged();
  }

  setMode(mode) {
    if (!PLAY_MODES.includes(mode)) throw new TypeError('invalid PlayMode: ' + mode);
    this.mode = mode;
    this._emitChanged();
  }

  setAutoAdvance(v) { this._autoAdvance = !!v; }

  // ---- queries ----
  getList() {
    return this.items.map((m, i) => ({
      index: i,
      title: m.title,
      path: m.path,
      uri: m.uri,
      current: i === this.currentIndex,
    }));
  }

  get current() { return this.currentIndex >= 0 ? this.items[this.currentIndex] : null; }
  get length() { return this.items.length; }

  // ---- navigation ----
  async play(index = (this.currentIndex >= 0 ? this.currentIndex : 0)) {
    const player = this.ctx.get('player');
    if (!player) throw new Error('player service unavailable');
    if (index < 0 || index >= this.items.length) return null;
    this.currentIndex = index;
    this._played.add(index);
    this._history.push(index);
    const media = this.items[index];
    this.ctx.emit('playlist/current', media, index);
    await player.load(media);
    return media;
  }

  async next() {
    const idx = nextIndex(this.currentIndex, this.items.length, this.mode, this._played);
    if (idx === null) {
      this.ctx.emit('playlist/ended');
      return null;
    }
    return this.play(idx);
  }

  async prev() {
    const histForPrev = this._history.slice(0, -1); // exclude current top
    const idx = prevIndex(this.currentIndex, this.items.length, this.mode, histForPrev);
    if (idx === null) return null;
    return this.play(idx);
  }

  async advance() {
    if (this.mode === PlayMode.SINGLE && this.currentIndex >= 0) {
      return this.play(this.currentIndex); // replay same track
    }
    return this.next();
  }

  // ---- internals ----
  _reindex(removed) {
    const played = new Set();
    for (const i of this._played) {
      if (i > removed) played.add(i - 1);
      else if (i < removed) played.add(i);
    }
    this._played = played;
    this._history = this._history
      .filter((i) => i !== removed)
      .map((i) => (i > removed ? i - 1 : i));
  }

  _emitChanged() {
    this.ctx.emit('playlist/changed', this.getList(), this.currentIndex, this.mode);
  }

  dispose() {
    try { this._offEnd?.(); } catch { /* ignore */ }
  }
}

export default PlaylistService;
