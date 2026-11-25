import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Recorded repository payloads with transport-only failures and controlled
// clocks. No gameplay observations or player records are invented.
const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const script = html.match(/<script>\s*"use strict";([\s\S]*?)<\/script>/)[1];
const source = '"use strict";' + script.slice(0, script.lastIndexOf('(async () => {'));
const recorded = Object.fromEntries(['players', 'meta', 'profiles'].map(name =>
  [name, JSON.parse(fs.readFileSync(new URL(`data/${name}.json`, root), 'utf8'))]));
const response = data => new Response(JSON.stringify(data));
const stalled = signal => new Promise((_resolve, reject) => {
  const abort = () => reject(new DOMException('Aborted', 'AbortError'));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
});

function harness(fetch) {
  const timers = new Map();
  const classes = new Set();
  const button = { disabled: false, innerHTML: '',
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  let timerId = 0;
  const ctx = vm.createContext({ fetch, AbortController,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {},
    document: { addEventListener() {}, querySelector() { return button; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  });
  vm.runInContext(source, ctx);
  return { run: code => vm.runInContext(code, ctx), timers, button, classes,
    expire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id); timer.fn();
    } };
}

test('successful live data clears its deadline and preserves recorded payloads', async () => {
  const h = harness(async () => response(recorded));
  assert.deepEqual(await h.run('loadLive()'), recorded);
  assert.equal(h.timers.size, 0);
});

test('a stalled live request reaches static fallback after the bounded deadline', async () => {
  const requested = [];
  const h = harness(async (url, options) => {
    requested.push(url);
    if (url.endsWith('/data')) return stalled(options.signal);
    const name = url.match(/data\/(\w+)\.json$/)[1];
    return response(recorded[name]);
  });
  const loaded = h.run('(async()=>await loadLive() || await loadStatic())()');
  assert.equal(h.timers.values().next().value.ms, 8000);
  h.expire();
  const result = await loaded;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), recorded);
  assert.equal(requested.length, 4);
  assert.equal(h.timers.size, 0);
});

test('live HTTP failures, rejected fetches and invalid JSON permit fallback', async () => {
  for (const fetch of [async () => new Response(null, { status: 503 }),
    async () => { throw new TypeError('Network unavailable'); },
    async () => new Response('{')]) {
    const h = harness(fetch);
    assert.equal(await h.run('loadLive()'), null);
    assert.equal(h.timers.size, 0);
  }
});

test('the deadline includes reading a stalled JSON body', async () => {
  const h = harness(async (_url, { signal }) => ({ ok: true, status: 200,
    json: () => stalled(signal) }));
  const loaded = h.run('loadLive()');
  await Promise.resolve();
  h.expire();
  assert.equal(await loaded, null);
  assert.equal(h.timers.size, 0);
});

test('static optional data can time out without hiding recorded players', async () => {
  const h = harness(async (url, { signal }) => url.endsWith('players.json')
    ? response(recorded.players) : stalled(signal));
  const loaded = h.run('loadStatic()');
  await Promise.resolve(); await Promise.resolve();
  for (const { fn } of [...h.timers.values()]) fn();
  const result = await loaded;
  assert.deepEqual(result.players, recorded.players);
  assert.equal(result.meta, null);
  assert.equal(result.profiles, null);
  assert.equal(h.timers.size, 0);
});

test('a stalled automatic refresh releases its button and busy state', async () => {
  const h = harness(async (_url, { signal }) => stalled(signal));
  const refreshed = h.run('doRefresh(true)');
  assert.equal(h.button.disabled, true);
  assert(h.classes.has('busy'));
  assert.equal(h.timers.values().next().value.ms, 20000);
  h.expire();
  await refreshed;
  assert.equal(h.button.disabled, false);
  assert.equal(h.classes.has('busy'), false);
  assert.equal(h.timers.size, 0);
});
