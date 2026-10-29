// 均衡器预设（对齐 Python music_player/engine/equalizer.py）。
//
// 纯逻辑、零依赖、框架无关（不 import Cordis），便于单测与 A/B 对拍。
// 注意：BAND_FREQUENCIES_HZ 与各预设值**逐字对齐 Python 版**（即使与 VLC
// 官方默认频率不同），以保证行为等价 —— 这是对拍基线，不在此"纠正"。

export const BAND_FREQUENCIES_HZ = Object.freeze([60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]);
export const NUM_BANDS = BAND_FREQUENCIES_HZ.length;

const PRESETS = {
  flat:      [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  rock:      [4.0, 3.0, 2.0, 1.0, -1.0, -1.0, 1.0, 2.0, 3.0, 4.0],
  pop:       [-1.0, 2.0, 4.0, 4.0, 1.0, -1.0, -1.0, 0.0, 1.0, 2.0],
  jazz:      [3.0, 2.0, 1.0, 2.0, -1.0, -1.0, 0.0, 1.0, 2.0, 3.0],
  classical: [4.0, 3.0, 2.0, 1.0, -1.0, -1.0, 0.0, 2.0, 3.0, 4.0],
  bass:      [6.0, 5.0, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  vocal:     [-2.0, -1.0, 0.0, 2.0, 3.0, 3.0, 2.0, 0.0, -1.0, -2.0],
};

export const DEFAULT_PRESET = 'flat';
export const PRESET_NAMES = Object.keys(PRESETS);

export function getPresetBands(name) {
  return [...(PRESETS[name] ?? PRESETS[DEFAULT_PRESET])];
}

export function isValidPreset(name) {
  return Object.prototype.hasOwnProperty.call(PRESETS, name);
}

export function clampBands(bands, lo = -20.0, hi = 20.0) {
  const out = [];
  for (let i = 0; i < NUM_BANDS; i++) {
    let g = 0.0;
    if (i < bands.length) {
      const v = Number(bands[i]);
      g = Number.isFinite(v) ? v : 0.0;
    }
    out.push(Math.max(lo, Math.min(hi, g)));
  }
  return out;
}

export function resolve(preset, bands) {
  if (bands) return clampBands(bands);
  if (preset) return getPresetBands(preset);
  return null;
}

export default { BAND_FREQUENCIES_HZ, NUM_BANDS, PRESET_NAMES, DEFAULT_PRESET, getPresetBands, isValidPreset, clampBands, resolve };
