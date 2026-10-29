// Visualizer service: 音频可视化（离线预计算频谱/波形，对齐 Python
// viz/visualizer.py 的 API 面）。计算逻辑在 lib/visualizer.js。

import { Service } from '../core/index.js';
import { Visualizer } from '../lib/visualizer.js';

export class VisualizerService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'visualizer');
    this.ctx = ctx;
    this._mode = config.mode || 'spectrum';
    this._viz = null;
    this._path = null;
  }

  get mode() { return this._viz ? this._viz.mode : this._mode; }
  get durationMs() { return this._viz ? this._viz.durationMs : 0; }

  /** 为某路径预计算（缓存 .json）；返回是否成功。 */
  precompute(path, mode = this._mode) {
    if (!this._viz || this._viz.mode !== mode) this._viz = new Visualizer({ mode });
    this._path = path;
    const ok = this._viz.precompute(path);
    this.ctx.emit('visualizer/ready', { ok, mode: this._viz.mode, durationMs: this._viz.durationMs });
    return ok;
  }

  frameAt(positionMs) {
    return this._viz ? this._viz.frameAt(positionMs) : null;
  }
}

export default VisualizerService;
