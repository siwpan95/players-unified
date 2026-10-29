// 音频可视化（对齐 Python music_player/viz/visualizer.py）。
//
// 零依赖、框架无关：用 ffmpeg 抽 16-bit PCM → 纯 JS 做波形 RMS 包络或
// 频谱（手写 radix-2 FFT，对齐 numpy rfft 的 bins 结构与 log1p 归一）。
// 注意：FFT 浮点与 numpy 存在实现级精度差异，A/B 对拍时 spectrum 只比对
// 结构（帧数/bins/归一范围），waveform RMS 与 duration_ms 可精确比对。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

function findFfmpeg() {
  const env = process.env.FFMPEG_BIN;
  if (env && existsSync(env)) return env;
  const known = ['E:/ffmpeg/bin/ffmpeg.exe', 'D:/ffmpeg/bin/ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe'];
  for (const p of known) if (existsSync(p)) return p;
  return 'ffmpeg'; // 回退到 PATH
}

function defaultCacheDir() {
  const base = process.env.MUSIC_PLAYER_CACHE
    || path.resolve(process.cwd(), 'cache');
  return path.join(base, 'viz');
}

// ---- 纯函数（可单测） ----
export function hanning(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** radix-2 FFT，返回 [outRe, outIm]（长度 n=2^k）。 */
export function fft(re, im) {
  const n = re.length;
  const rev = new Int32Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    rev[i] = j;
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
  }
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let i = 0; i < n; i++) { outRe[i] = re[rev[i]]; outIm[i] = im[rev[i]]; }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const vRe = outRe[b] * curRe - outIm[b] * curIm;
        const vIm = outRe[b] * curIm + outIm[b] * curRe;
        outRe[b] = outRe[a] - vRe; outIm[b] = outIm[a] - vIm;
        outRe[a] += vRe; outIm[a] += vIm;
        const nwRe = curRe * wRe - curIm * wIm;
        const nwIm = curRe * wIm + curIm * wRe;
        curRe = nwRe; curIm = nwIm;
      }
    }
  }
  return [outRe, outIm];
}

/** 波形：每 hop 取一段 RMS 包络。 */
export function waveformEnvelope(samples, nFft, hop) {
  const n = Math.max(1, Math.floor((samples.length - nFft) / hop));
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < nFft; j++) {
      const v = samples[i * hop + j];
      sum += v * v;
    }
    env[i] = Math.sqrt(sum / nFft + 1e-12);
  }
  return env;
}

/** 频谱：hanning 窗口 + rfft 幅度 + log1p 归一。返回 (n_frames, n_bins)。 */
export function spectrumFrames(samples, nFft, hop) {
  const n = Math.max(1, Math.floor((samples.length - nFft) / hop));
  const bins = nFft / 2 + 1;
  const window = hanning(nFft);
  const mag = new Float32Array(n * bins);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < nFft; j++) { re[j] = samples[i * hop + j] * window[j]; im[j] = 0; }
    const [or, oi] = fft(re, im);
    for (let b = 0; b < bins; b++) {
      mag[i * bins + b] = Math.hypot(or[b], oi[b]);
    }
  }
  // log1p + 归一
  let mn = Infinity;
  let mx = -Infinity;
  const total = mag.length;
  for (let i = 0; i < total; i++) {
    const v = Math.log1p(mag[i]);
    mag[i] = v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const denom = mx - mn + 1e-9;
  for (let i = 0; i < total; i++) mag[i] = (mag[i] - mn) / denom;
  return { frames: mag, n, bins };
}

export class Visualizer {
  constructor({ mode = 'spectrum', sr = 22050, nFft = 1024, hop = 512, cacheDir = null } = {}) {
    this.mode = mode;
    this.sr = sr;
    this.nFft = nFft;
    this.hop = hop;
    this._frames = null;   // waveform: Float32Array(n); spectrum: Float32Array(n*bins)
    this._bins = 0;
    this._durationMs = 0;
    this._cacheDir = cacheDir || defaultCacheDir();
  }

  get durationMs() { return this._durationMs; }

  precompute(srcPath) {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return false;
    const key = `${createHash('md5').update(srcPath).digest('hex').slice(0, 8)}_${statSync(srcPath).size}_${this.mode}`;
    const cacheFile = path.join(this._cacheDir, `${key}.json`);
    if (existsSync(cacheFile)) {
      try {
        const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
        this._frames = Float32Array.from(data.frames);
        this._bins = data.bins || 1;
        this._durationMs = data.duration_ms;
        return true;
      } catch { /* fall through to recompute */ }
    }

    const res = spawnSync(ffmpeg, ['-y', '-i', srcPath, '-ac', '1', '-ar', String(this.sr), '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 });
    if (res.status !== 0 || !res.stdout || res.stdout.length === 0) return false;
    const raw = new Int16Array(res.stdout.buffer, res.stdout.byteOffset, Math.floor(res.stdout.length / 2));
    const samples = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) samples[i] = raw[i] / 32768.0;
    if (samples.length === 0) return false;

    this._durationMs = Math.floor((samples.length / this.sr) * 1000);

    if (this.mode === 'waveform') {
      this._frames = waveformEnvelope(samples, this.nFft, this.hop);
      this._bins = 1;
    } else {
      const r = spectrumFrames(samples, this.nFft, this.hop);
      this._frames = r.frames;
      this._bins = r.bins;
    }

    try {
      mkdirSync(this._cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ frames: Array.from(this._frames), bins: this._bins, duration_ms: this._durationMs }));
    } catch { /* cache write is best-effort */ }
    return true;
  }

  frameAt(positionMs) {
    if (!this._frames || this._durationMs <= 0) return null;
    const frac = Math.max(0.0, Math.min(1.0, positionMs / this._durationMs));
    const idx = Math.floor(frac * (this._frames.length / this._bins - 1));
    if (this.mode === 'waveform') return [this._frames[idx]];
    const start = idx * this._bins;
    return this._frames.slice(start, start + this._bins);
  }
}

export default Visualizer;
