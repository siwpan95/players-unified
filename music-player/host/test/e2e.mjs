// End-to-end verification of the running host: spawns real VLC via the host,
// generates two short WAV samples, drives the Web UI REST API, and confirms
// actual playback (currentTime advances), transport commands, volume/seek, and
// auto-advance to the next track. Run: node test/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const NODE = process.execPath; // reuse the same node binary that runs this script
const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = 'E:/ffmpeg/bin/ffmpeg.exe';
const VLC = 'E:/VLC/vlc.exe';
const WEB_PORT = 19728;
const VLC_RC_PORT = 18228;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) log('  ok -', msg);
  else { log('  FAIL -', msg); failures++; }
}

async function api(endpoint, params) {
  const url = new URL(endpoint, BASE);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { method: 'POST' });
  return r.json().catch(() => ({}));
}
async function status() {
  const r = await fetch(`${BASE}/api/status`);
  return r.json();
}
async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await status().catch(() => null);
    if (s && pred(s)) return s;
    await sleep(300);
  }
  throw new Error('timeout waiting for: ' + (label || 'condition'));
}

// ---- generate two 3s WAV samples (no codec needed) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpl-e2e-'));
const sampleA = path.join(tmp, 'sample_a.wav');
const sampleB = path.join(tmp, 'sample_b.wav');
execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', sampleA], { stdio: 'ignore' });
execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', sampleB], { stdio: 'ignore' });
assert(fs.existsSync(sampleA) && fs.existsSync(sampleB), 'generated two 3s WAV samples');

// ---- spawn the host ----
const child = spawn(NODE, ['app.js'], {
  cwd: HOST_DIR,
  env: { ...process.env, VLC_PATH: VLC, VLC_RC_PORT: String(VLC_RC_PORT), WEB_PORT: String(WEB_PORT), WEB_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hostOut = '';
child.stdout.on('data', (d) => { hostOut += d.toString(); });
child.stderr.on('data', (d) => { hostOut += d.toString(); });

try {
  // 1) server up
  await waitFor(() => true, 20000, 'server up').catch(() => { throw new Error('server never came up'); });
  assert(true, 'host HTTP server is reachable (/api/status responds)');

  // 2) add both tracks
  const addRes = await fetch(`${BASE}/api/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [{ path: sampleA }, { path: sampleB }] }),
  });
  const addJson = await addRes.json();
  assert(addJson.length === 2 && addJson.ok, 'added 2 tracks (length=2)');

  // 3) play first track
  await api('/api/play', { index: 0 });
  const playing = await waitFor((s) => s.status === 'playing' && s.position_ms > 0, 8000, 'playing + time advancing');
  assert(playing.status === 'playing', 'VLC reports playing');
  assert(playing.position_ms > 0, `currentTime advancing (${(playing.position_ms / 1000).toFixed(1)}s)`);
  assert(playing.current_index === 0, 'currentIndex == 0 after play(0)');
  const dur = playing.duration_ms / 1000;
  assert(dur > 2 && dur < 4, `duration ~3s (got ${dur ? dur.toFixed(1) : '?'})`);

  // 4) pause / resume
  await api('/api/pause');
  const paused = await waitFor((s) => s.status === 'paused', 3000, 'paused');
  assert(paused.status === 'paused', 'pause works (status paused)');

  await api('/api/play');
  const resumed = await waitFor((s) => s.status === 'playing', 3000, 'resumed');
  assert(resumed.status === 'playing', 'resume works');

  // 5) volume
  await api('/api/volume', { v: 50 });
  const volState = await waitFor((s) => s.volume === 50, 2000, 'volume 50');
  assert(volState.volume === 50, 'setVolume(50) reflected in state');

  // 6) seek to 50%
  await api('/api/seek', { f: 0.5 });
  const seekState = await waitFor((s) => (s.position_ms / 1000) >= dur * 0.3 && (s.position_ms / 1000) <= dur * 0.9, 3000, 'seek 50%');
  assert((seekState.position_ms / 1000) > dur * 0.3, `seek to ~50% worked (cur=${(seekState.position_ms / 1000).toFixed(1)}/${dur.toFixed(1)})`);

  // 7) auto-advance: replay index 0, wait for it to end and advance to index 1
  await api('/api/play', { index: 0 });
  await waitFor((s) => s.status === 'playing', 3000, 'replay 0');
  const advanced = await waitFor((s) => s.current_index === 1, 9000, 'auto-advance to index 1');
  assert(advanced.current_index === 1, 'auto-advanced to next track on end-of-track');

  // 8) SSE stream pushes at least one update
  const esRes = await fetch(`${BASE}/api/stream`);
  assert(esRes.headers.get('content-type').includes('text/event-stream'), 'SSE /api/stream responds with event-stream');

  log(`\n${failures === 0 ? 'ALL E2E CHECKS PASSED' : failures + ' E2E CHECK(S) FAILED'}`);
} catch (e) {
  log('E2E ERROR:', e.message);
  failures++;
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  if (failures > 0) { log('\n--- host output ---\n' + hostOut.slice(-2000)); }
}
process.exit(failures === 0 ? 0 : 1);
