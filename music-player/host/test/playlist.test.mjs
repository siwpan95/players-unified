// Offline unit test for the playlist service + ported pure functions.
// Run: node test/playlist.test.mjs  (no deps, no VLC needed)
import assert from 'node:assert';
import { Context, Logger } from '../src/core/index.js';
import { PlaylistService, nextIndex, prevIndex, PlayMode } from '../src/services/playlist.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok -', name);
}

// ---- pure-function tests (mirror play_mode.py semantics) ----
check('nextIndex SEQUENTIAL walks forward, null at end', () => {
  const played = new Set();
  assert.strictEqual(nextIndex(0, 3, PlayMode.SEQUENTIAL, played), 1);
  assert.strictEqual(nextIndex(1, 3, PlayMode.SEQUENTIAL, played), 2);
  assert.strictEqual(nextIndex(2, 3, PlayMode.SEQUENTIAL, played), null);
});

check('nextIndex LOOP wraps to 0', () => {
  const played = new Set();
  assert.strictEqual(nextIndex(2, 3, PlayMode.LOOP, played), 0);
});

check('nextIndex SINGLE stays put', () => {
  const played = new Set();
  assert.strictEqual(nextIndex(1, 3, PlayMode.SINGLE, played), 1);
});

check('nextIndex RANDOM avoids played set until exhausted', () => {
  const played = new Set([0, 1]);
  // length 3: only index 2 remains
  assert.strictEqual(nextIndex(2, 3, PlayMode.RANDOM, played), 2);
  // after all played, set clears and any index may be chosen (here all)
  const allPlayed = new Set([0, 1, 2]);
  const r = nextIndex(2, 3, PlayMode.RANDOM, allPlayed);
  assert.ok([0, 1, 2].includes(r));
});

check('prevIndex SEQUENTIAL steps back, null at start', () => {
  const hist = [0, 1, 2];
  assert.strictEqual(prevIndex(2, 3, PlayMode.SEQUENTIAL, hist), 1);
  assert.strictEqual(prevIndex(1, 3, PlayMode.SEQUENTIAL, hist), 0);
  assert.strictEqual(prevIndex(0, 3, PlayMode.SEQUENTIAL, hist), null);
});

check('prevIndex LOOP wraps to last', () => {
  const hist = [0];
  assert.strictEqual(prevIndex(0, 3, PlayMode.LOOP, hist), 2);
});

check('prevIndex SINGLE stays put', () => {
  const hist = [0, 1];
  assert.strictEqual(prevIndex(1, 3, PlayMode.SINGLE, hist), 1);
});

check('prevIndex RANDOM returns the track before current', () => {
  const hist = [0, 1, 2]; // top=2 current, previous=1
  assert.strictEqual(prevIndex(2, 3, PlayMode.RANDOM, hist), 1);
});

// ---- service-level test with a mocked player (no VLC) ----
check('playlist service: add/play/next/prev + auto-advance wiring', async () => {
  const root = new Context({ root: null });
  root.logger = new Logger('test');
  // mock player service with a load spy
  let loaded = [];
  let endedFired = 0;
  root.provide('player', {
    load: async (m) => { loaded.push(m.title); },
    on: () => () => {},
    getState: () => ({}),
  });
  // simulate player/end emission by capturing listeners on root bus
  const pl = new PlaylistService(root, { mode: PlayMode.SEQUENTIAL });
  ['a', 'b', 'c'].forEach((t) => pl.add({ uri: 'x', path: 'x', title: t }));

  assert.strictEqual(pl.length, 3);
  await pl.play(0);
  assert.strictEqual(pl.currentIndex, 0);
  assert.deepStrictEqual(loaded, ['a']);

  await pl.next();
  assert.strictEqual(pl.currentIndex, 1);
  assert.deepStrictEqual(loaded, ['a', 'b']);

  await pl.prev();
  assert.strictEqual(pl.currentIndex, 0);
  assert.deepStrictEqual(loaded, ['a', 'b', 'a']);

  // auto-advance: emit player/end -> should advance to b again
  root.emit('player/end');
  // advance() is async (awaits player.load); give microtasks a tick
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(loaded, ['a', 'b', 'a', 'b']);
  assert.strictEqual(pl.currentIndex, 1);

  // SINGLE mode replays same track on end
  pl.setMode(PlayMode.SINGLE);
  root.emit('player/end');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(pl.currentIndex, 1); // still 1 (replayed)
  assert.deepStrictEqual(loaded, ['a', 'b', 'a', 'b', 'b']);

  // removeAt reindexes played/history/current correctly
  pl.clear();
  ['a', 'b', 'c', 'd'].forEach((t) => pl.add({ uri: 'x', path: 'x', title: t }));
  await pl.play(1); // current b
  pl.removeAt(0);   // remove a -> b becomes index 0
  assert.strictEqual(pl.currentIndex, 0, 'current should shift down after removeAt(0)');
  assert.strictEqual(pl.getList()[0].title, 'b');
});

check('playlist service: SEQUENTIAL end of queue stops (playlist/ended)', async () => {
  const root = new Context({ root: null });
  root.logger = new Logger('test');
  let endCount = 0;
  root.on('playlist/ended', () => endCount++);
  root.provide('player', { load: async () => {}, on: () => () => {}, getState: () => ({}) });
  const pl = new PlaylistService(root, { mode: PlayMode.SEQUENTIAL });
  ['a', 'b'].forEach((t) => pl.add({ uri: 'x', path: 'x', title: t }));
  await pl.play(1); // last track
  const after = await pl.next();
  assert.strictEqual(after, null);
  assert.strictEqual(endCount, 1);
});

console.log(`\n${passed} checks passed.`);
