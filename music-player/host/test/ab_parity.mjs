// A/B 行为等价对拍：同一份 JSON-RPC transcript 分别打 A 侧（Python 无头
// harness，tools/ab_harness.py）与 B 侧（Node host 的 RpcService），逐观测点
// 比对返回序列。
//
// 运行：node test/ab_parity.mjs
//
// 归一化规则（易变字段不逐位比对，改语义哨兵）：
//   position_ms / duration_ms -> '>0' ? '<pos>'/'<dur>' : 0
//   current_uri / uri          -> 非空 ? '<uri>' : ''
// 确定性字段（status/current_index/volume/mute/play_mode/equalizer_on/
// mode/index/title/radio/added/pong）逐位精确比对。

import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const NODE = process.execPath;
const PY = 'python';
const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_DIR = path.resolve(HOST_DIR, '..');
const FFMPEG = 'E:/ffmpeg/bin/ffmpeg.exe';
const VLC = 'E:/VLC/vlc.exe';
// 随机高位端口，避免与残留进程冲突
const A_PORT = 28000 + Math.floor(Math.random() * 500);   // Python harness RPC
const B_PORT = 28500 + Math.floor(Math.random() * 500);   // Node host RPC
const VLC_RC_PORT = 29000 + Math.floor(Math.random() * 500);
const WEB_PORT = 29500 + Math.floor(Math.random() * 500);

let pass = 0, fail = 0;
const diffs = [];
const log = (...a) => console.log(...a);

// ---- generate two 10s WAV samples (avoid auto-advance during transcript) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'));
const sampleA = path.join(tmp, 'alpha.wav');
const sampleB = path.join(tmp, 'beta.wav');
execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', sampleA], { stdio: 'ignore' });
execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=10', sampleB], { stdio: 'ignore' });

// ---- JSON-RPC client (per-port) ----
function rpcClient(port) {
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  const pending = [];
  sock.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line && pending.length) pending.shift()(JSON.parse(line));
    }
  });
  return new Promise((resolve, reject) => {
    sock.on('connect', () => resolve({
      call(method, params = {}) {
        return new Promise((res, rej) => {
          const id = Math.floor(Math.random() * 1e9);
          pending.push((resp) => (resp.error ? rej(new Error(resp.error.message)) : res(resp.result)));
          sock.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
        });
      },
      close() { sock.destroy(); },
    }));
    sock.on('error', reject);
  });
}

async function waitRpc(port, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { return await rpcClient(port); } catch { await sleep(300); }
  }
  throw new Error(`RPC ${port} 未就绪`);
}

// ---- 归一化（易变字段 -> 语义哨兵）----
// 易变字段：
//   position_ms —— 播放进度，两侧集成方式不同（Python=libvlc 毫秒同步查询，
//                  Node=VLC RC 秒级 400ms 轮询），精确值与"是否>0"受时序影响，
//                  只断言"存在数字"。
//   duration_ms —— 文件时长，稳定值，settle 后两侧一致；保留 0 vs >0 语义
//                  （0=未加载完成）。
//   current_uri/uri —— 表示不同（Python=本地路径，Node=file:/// URI），非空即 <uri>。
//   status（play/play_index/next/prev 的即时返回）—— Python 侧 load 后 status
//                  仍 stopped（靠 VLC 事件回调才变 playing），Node 乐观同步置
//                  playing；这是有意差异，settle 后一致，此处归一化为 <status>。
function normalize(obj, transientStatus = false) {
  const s = JSON.parse(JSON.stringify(obj));
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (k === 'position_ms') node[k] = (typeof node[k] === 'number') ? '<num>' : node[k];
        else if (k === 'duration_ms') node[k] = (typeof node[k] === 'number' && node[k] > 0) ? '<dur>' : 0;
        else if (k === 'current_uri' || k === 'uri') node[k] = node[k] ? '<uri>' : '';
        else if (k === 'status' && transientStatus) node[k] = '<status>';
        else walk(node[k]);
      }
    }
  };
  walk(s);
  return s;
}

// ---- transcript（与实现无关的命令序列）----
const transcript = [
  { method: 'ping', params: {} },
  { method: 'add_files', params: { paths: [sampleA, sampleB] }, settle: 100 },
  { method: 'status', params: {} },
  { method: 'play_index', params: { index: 0 }, settle: 1200 },
  { method: 'status', params: {} },
  { method: 'pause', params: {}, settle: 200 },
  { method: 'status', params: {} },
  { method: 'resume', params: {}, settle: 200 },
  { method: 'volume', params: { value: 50 }, settle: 100 },
  { method: 'mute', params: { value: true }, settle: 100 },
  { method: 'mute', params: { value: false }, settle: 100 },
  { method: 'set_mode', params: { mode: 'loop' }, settle: 100 },
  { method: 'set_mode', params: { mode: 'sequential' }, settle: 100 },
  { method: 'seek', params: { position_ms: 1000 }, settle: 300 },
  { method: 'equalizer', params: { preset: 'rock' }, settle: 1500 },
  { method: 'status', params: {} },
  { method: 'equalizer', params: { preset: null, bands: null }, settle: 1500 },
  { method: 'status', params: {} },
  { method: 'playlist', params: {} },
  { method: 'next', params: {}, settle: 1200 },
  { method: 'status', params: {} },
  { method: 'prev', params: {}, settle: 1200 },
  { method: 'status', params: {} },
  { method: 'stop', params: {}, settle: 200 },
  { method: 'status', params: {} },
];

// ---- spawn A (Python harness) + B (Node host) ----
const aProc = spawn(PY, ['tools/ab_harness.py', String(A_PORT)], {
  cwd: PROJECT_DIR,
  env: { ...process.env, PYTHONUNBUFFERED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const bProc = spawn(NODE, ['app.js'], {
  cwd: HOST_DIR,
  env: { ...process.env, VLC_PATH: VLC, VLC_RC_PORT: String(VLC_RC_PORT), WEB_PORT: String(WEB_PORT), RPC_PORT: String(B_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let aOut = '', bOut = '';
aProc.stdout.on('data', (d) => { aOut += d.toString(); });
aProc.stderr.on('data', (d) => { aOut += d.toString(); });
bProc.stdout.on('data', (d) => { bOut += d.toString(); });
bProc.stderr.on('data', (d) => { bOut += d.toString(); });

try {
  const a = await waitRpc(A_PORT);
  const b = await waitRpc(B_PORT);
  log(`A 侧（Python）@${A_PORT} 与 B 侧（Node）@${B_PORT} 已就绪\n`);

  // 预热：Node 侧 VLC 进程启动 + RC 连接需 1–3s（Python 侧 libVLC 同步就绪）
  await sleep(3000);

  const TRANSIENT_STATUS = new Set(['play', 'play_index', 'next', 'prev']);

  for (const step of transcript) {
    const label = `${step.method}${Object.keys(step.params).length ? ' ' + JSON.stringify(step.params) : ''}`;
    const transient = TRANSIENT_STATUS.has(step.method);
    let ra, rb;
    try {
      ra = await a.call(step.method, step.params);
    } catch (e) { log(`  ✗ A 侧 ${label} 报错: ${e.message}`); fail++; continue; }
    try {
      rb = await b.call(step.method, step.params);
    } catch (e) { log(`  ✗ B 侧 ${label} 报错: ${e.message}`); fail++; continue; }

    const na = JSON.stringify(normalize(ra, transient));
    const nb = JSON.stringify(normalize(rb, transient));
    if (na === nb) {
      pass++;
      log(`  ✓ ${label} -> ${JSON.stringify(normalize(ra, transient))}`);
    } else {
      fail++;
      const d = { step: label, A: normalize(ra, transient), B: normalize(rb, transient) };
      diffs.push(d);
      log(`  ✗ ${label}`);
      log(`      A = ${JSON.stringify(d.A)}`);
      log(`      B = ${JSON.stringify(d.B)}`);
    }
    if (step.settle) await sleep(step.settle);
  }

  log(`\n==== 对拍结果：${pass} 一致 / ${fail} 差异 ====`);
  if (diffs.length) {
    log('\n差异明细（归一化后）:');
    diffs.forEach((d) => log(`  - ${d.step}\n      A=${JSON.stringify(d.A)}\n      B=${JSON.stringify(d.B)}`));
  }
} catch (e) {
  log('A/B 对拍错误:', e.message);
  fail++;
} finally {
  try { aProc.kill('SIGTERM'); } catch {}
  try { bProc.kill('SIGTERM'); } catch {}
  await sleep(500);
  try { aProc.kill('SIGKILL'); } catch {}
  try { bProc.kill('SIGKILL'); } catch {}
  if (fail > 0) {
    if (aOut.trim()) log('\n--- A 侧输出 ---\n' + aOut.slice(-1500));
    if (bOut.trim()) log('\n--- B 侧输出 ---\n' + bOut.slice(-1500));
  }
}
process.exit(fail === 0 ? 0 : 1);
