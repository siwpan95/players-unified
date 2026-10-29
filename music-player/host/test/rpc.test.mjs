// RPC 命令面 + 均衡器切换的端到端测试（对齐 Python RPC 契约）。
// 运行：node test/rpc.test.mjs
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const NODE = process.execPath;
const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = 'E:/ffmpeg/bin/ffmpeg.exe';
const VLC = 'E:/VLC/vlc.exe';
const WEB_PORT = 19738;
const RPC_PORT = 7790;
const VLC_RC_PORT = 18238;

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log('  ok -', msg); else { log('  FAIL -', msg); failures++; } }

// ---- generate two 3s WAV samples ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-'));
const sampleA = path.join(tmp, 'sample_a.wav');
const sampleB = path.join(tmp, 'sample_b.wav');
execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', sampleA], { stdio: 'ignore' });
execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', sampleB], { stdio: 'ignore' });

// ---- spawn host ----
const child = spawn(NODE, ['app.js'], {
  cwd: HOST_DIR,
  env: { ...process.env, VLC_PATH: VLC, VLC_RC_PORT: String(VLC_RC_PORT), WEB_PORT: String(WEB_PORT), RPC_PORT: String(RPC_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hostOut = '';
child.stdout.on('data', (d) => { hostOut += d.toString(); });
child.stderr.on('data', (d) => { hostOut += d.toString(); });

// ---- minimal JSON-RPC client ----
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
          pending.push((resp) => {
            if (resp.error) rej(new Error(resp.error.message));
            else res(resp.result);
          });
          sock.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
        });
      },
      close() { sock.destroy(); },
    }));
    sock.on('error', (e) => reject(e));
  });
}

try {
  // wait for RPC port
  let rpc;
  for (let i = 0; i < 40; i++) {
    try { rpc = await rpcClient(RPC_PORT); break; } catch { await sleep(250); }
  }
  assert(!!rpc, 'RPC 服务监听 7700（可达）');

  // ping / status / add / play
  const ping = await rpc.call('ping');
  assert(ping.pong === true, 'ping -> {pong:true}');

  const added = await rpc.call('add_files', { paths: [sampleA, sampleB] });
  assert(added.added === 2, 'add_files 2 曲');

  const cur = await rpc.call('play_index', { index: 0 });
  assert(cur.index === 0, 'play_index(0) -> index 0');
  assert(cur.status === 'playing', 'play_index(0) -> status playing');

  // 等待轮询更新 duration/position（按内容断言，不按计时）
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await rpc.call('status');
    if (st.duration_ms > 0 && st.position_ms > 0) break;
    await sleep(200);
  }
  assert(typeof st.status === 'string' && st.status !== '', 'status.status 存在');
  assert(st.current_index === 0, 'status.current_index === 0');
  assert(st.duration_ms > 2000 && st.duration_ms < 4000, `status.duration_ms ~3000 (got ${st.duration_ms})`);
  assert(st.position_ms > 0, 'status.position_ms 前进');
  assert(st.volume === 80, 'status.volume === 80 默认');
  assert(st.mute === false, 'status.mute === false');
  assert(st.play_mode === 'sequential', 'status.play_mode === sequential');
  assert(st.equalizer_on === false, 'status.equalizer_on === false 初始');
  assert('current_uri' in st, 'status 含 current_uri 字段');

  // volume / mute / seek
  assert((await rpc.call('volume', { value: 50 })).volume === 50, 'volume(50) -> {volume:50}');
  assert((await rpc.call('mute', { value: true })).mute === true, 'mute(true) -> {mute:true}');
  await rpc.call('mute', { value: false });
  const seeked = await rpc.call('seek', { position_ms: 1000 });
  assert(seeked.position_ms >= 700 && seeked.position_ms <= 1400, `seek(1000ms) -> position_ms ~1000 (got ${seeked.position_ms})`);

  // set_mode
  assert((await rpc.call('set_mode', { mode: 'loop' })).mode === 'loop', 'set_mode(loop) -> {mode:loop}');
  await rpc.call('set_mode', { mode: 'sequential' });

  // equalizer: 切换 preset 应 equalizer_on=true 且播放状态恢复（不丢曲目/位置）
  const beforeEq = await rpc.call('status');
  const eqOn = await rpc.call('equalizer', { preset: 'rock' });
  assert(eqOn.equalizer_on === true, 'equalizer(rock) -> equalizer_on true');
  await sleep(2000); // 等重启 + 恢复
  const afterEq = await rpc.call('status');
  assert(afterEq.equalizer_on === true, '切换后 status.equalizer_on true');
  assert(afterEq.current_index === beforeEq.current_index, '切换后 current_index 不变（状态恢复）');
  assert(afterEq.current_uri === beforeEq.current_uri, '切换后 current_uri 不变');

  const eqOff = await rpc.call('equalizer', { preset: null, bands: null });
  assert(eqOff.equalizer_on === false, 'equalizer(null,null) -> equalizer_on false');
  await sleep(2000);
  assert((await rpc.call('status')).equalizer_on === false, '关闭后 status.equalizer_on false');

  // playlist 契约（含 radio 字段）
  const pl = await rpc.call('playlist');
  assert(Array.isArray(pl) && pl.length === 2, 'playlist 返回 2 条');
  assert(pl[0].index === 0 && typeof pl[0].title === 'string' && pl[0].radio === false, 'playlist[0] {index,title,radio}');

  // next / prev
  assert((await rpc.call('next')).index === 1, 'next -> index 1');
  assert((await rpc.call('prev')).index === 0, 'prev -> index 0');

  log(`\n${failures === 0 ? 'ALL RPC CHECKS PASSED' : failures + ' RPC CHECK(S) FAILED'}`);
} catch (e) {
  log('RPC TEST ERROR:', e.message);
  failures++;
} finally {
  try { child.kill('SIGTERM'); } catch {}
  await sleep(500);
  try { child.kill('SIGKILL'); } catch {}
  if (failures > 0) log('\n--- host output ---\n' + hostOut.slice(-2500));
}
process.exit(failures === 0 ? 0 : 1);
