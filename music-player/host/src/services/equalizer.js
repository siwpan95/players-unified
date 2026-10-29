// Equalizer service: 10-band equalizer preset + custom bands, ported from
// Python (music_player/engine/equalizer.py + PlayerEngine.set_equalizer).
//
// VLC 3.0's RC interface has NO runtime equalizer command — the only way to
// set bands is via startup flags (`--audio-filter equalizer --equalizer-bands
// "..."`). So applying means restarting VLC with those flags (delegated to the
// `player` service) and restoring the playback position/state.
//
// The pure preset/clamp/resolve logic lives in src/lib/equalizer.js (aligned
// byte-for-byte with the Python side for A/B parity).

import { Service } from '../core/index.js';
import { resolve, DEFAULT_PRESET, getPresetBands } from '../lib/equalizer.js';

export class EqualizerService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'equalizer');
    this.ctx = ctx;
    this._on = false;
    this._preset = null;       // 预设名（无自定义 bands 时）
    this._bands = null;        // 实际 10 段增益（生效中）；null = 关闭
  }

  get on() { return this._on; }
  get preset() { return this._preset; }
  get bands() { return this._bands ? [...this._bands] : null; }

  /** 应用均衡器：preset 名或自定义 bands；两者皆空则关闭。 */
  async setEqualizer({ preset = null, bands = null } = {}) {
    const resolved = resolve(preset, bands);
    if (resolved === null) {
      this._on = false;
      this._preset = null;
      this._bands = null;
    } else {
      this._on = true;
      this._preset = bands ? null : (preset || DEFAULT_PRESET);
      this._bands = resolved;
    }
    const player = this.ctx.get('player');
    if (player) await player.restartWithEqualizer(this._bands);
    this.ctx.emit('equalizer/changed', { on: this._on, preset: this._preset, bands: this._bands });
    return { equalizer_on: this._on };
  }

  /** 便捷：按预设名设置。 */
  setPreset(name) { return this.setEqualizer({ preset: name }); }

  /** 便捷：关闭。 */
  disable() { return this.setEqualizer({ preset: null, bands: null }); }

  /** 仅供 RPC/契约层读取：当前 10 段（关闭时返回 flat）。 */
  currentBands() { return this._bands ? [...this._bands] : getPresetBands(DEFAULT_PRESET); }
}

export default EqualizerService;
