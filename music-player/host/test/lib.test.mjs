// lib 纯逻辑模块单测（对齐 Python 版测试向量，可 A/B 对拍）。
// 运行：node test/lib.test.mjs
import assert from 'node:assert';
import { resolve, clampBands, getPresetBands, isValidPreset, NUM_BANDS, PRESET_NAMES } from '../src/lib/equalizer.js';
import { LrcParser } from '../src/lib/lrc.js';
import { RadioManager, MediaType } from '../src/lib/radio.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

// ---- equalizer（对齐 test_equalizer.py） ----
check('equalizer: 每个预设 10 段', () => {
  for (const name of PRESET_NAMES) {
    assert.strictEqual(getPresetBands(name).length, NUM_BANDS, `预设 ${name} 段数错误`);
  }
});
check('equalizer: resolve 返回拷贝', () => {
  const a = resolve('flat', null);
  a[0] = 99.0;
  assert.strictEqual(resolve('flat', null)[0], 0.0);
});
check('equalizer: resolve(None,None) 关闭', () => {
  assert.strictEqual(resolve(null, null), null);
});
check('equalizer: clampBands 约束并补齐', () => {
  const bands = clampBands([100, -100, 5, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.strictEqual(bands[0], 20.0);
  assert.strictEqual(bands[1], -20.0);
  assert.strictEqual(bands.length, NUM_BANDS);
});
check('equalizer: is_valid_preset', () => {
  assert.ok(isValidPreset('rock'));
  assert.ok(!isValidPreset('nope'));
  assert.ok(isValidPreset('flat'));
});

// ---- lrc（对齐 test_lrc_parser.py） ----
const LRC = '[00:01.00]line one\n[00:03.50]line two\n[00:10.00]line three\n';
check('lrc: parse 计数与偏移', () => {
  const lines = LrcParser.parse(LRC);
  assert.strictEqual(lines.length, 3);
  assert.deepStrictEqual(lines[0], [1000, 'line one']);
  assert.deepStrictEqual(lines[1], [3500, 'line two']);
  assert.deepStrictEqual(lines[2], [10000, 'line three']);
});
check('lrc: 一行多标签展开', () => {
  const lines = LrcParser.parse('[00:00.00][00:05.00]repeat\n');
  assert.strictEqual(lines.length, 2);
});
check('lrc: line_at 二分定位', () => {
  const p = new LrcParser({ text: LRC });
  assert.strictEqual(p.lineAt(0), -1);
  assert.strictEqual(p.lineAt(1000), 0);
  assert.strictEqual(p.lineAt(2000), 0);
  assert.strictEqual(p.lineAt(3500), 1);
  assert.strictEqual(p.lineAt(9000), 1);
  assert.strictEqual(p.lineAt(10000), 2);
  assert.strictEqual(p.lineAt(999999), 2);
});

// ---- radio（对齐 radio_manager.from_m3u） ----
const M3U = '#EXTM3U\n#EXTINF:-1,Station One\nhttp://example.com/one.m3u8\n#EXTINF:-1,Station Two\nhttp://example.com/two\n';
check('radio: from_m3u 解析名称与类型', () => {
  const rm = new RadioManager();
  const items = rm.parseM3u(M3U);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].name, 'Station One');
  assert.strictEqual(items[0].item_type, MediaType.RADIO_HLS);
  assert.strictEqual(items[1].name, 'Station Two');
  assert.strictEqual(items[1].item_type, MediaType.RADIO_HTTP);
  assert.strictEqual(items[1].path, 'http://example.com/two');
});

console.log(`\n${passed} checks passed.`);
