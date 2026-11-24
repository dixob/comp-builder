import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Use the recorded OP.GG statistics in the checkout. Only transport and KV
// are mocked; no fictional players, results, or statistical observations.
const root = new URL('../', import.meta.url);
const meta = JSON.parse(fs.readFileSync(new URL('data/meta.json', root), 'utf8'));
const players = JSON.parse(fs.readFileSync(new URL('data/players.json', root), 'utf8'));
const source = fs.readFileSync(new URL('worker/src/index.js', root), 'utf8')
  .replace("'./scoring.generated.mjs'",JSON.stringify(new URL('worker/src/scoring.generated.mjs',root).href));
const { default: worker, StateHub } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const response = body => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json' },
});
const rawMeta = {
  meta: { version: meta.patch, match_count: meta.matchCount, analyzed_at: meta.analyzedAt },
  data: Object.entries(meta.champions).map(([id, c]) => ({
    id: Number(id),
    average_stats: { win_rate: c.winRate, pick_rate: c.pickRate, ban_rate: c.banRate,
      play: c.games, tier: c.tier },
    positions: Object.entries(c.positions).map(([name, p]) => ({ name, stats: {
      win_rate: p.winRate, pick_rate: p.pickRate, role_rate: p.roleRate, play: p.games,
    } })),
  })),
};

function fixture(tier) {
  const state = {
    config: { platform: 'na1', ...(tier ? { metaTier: tier } : {}),
      riotIds: players.players.map(({ riotId, puuid }) => ({ riotId, puuid })) },
    players: Object.fromEntries(players.players.map(p => [p.riotId, {
      profileIconId: p.profileIconId, mastery: p.mastery, ranks: p.ranks,
      champs: Object.fromEntries(p.champions.map(({ championId, ...record }) => [championId, record])),
      queues: p.queues, recent: p.recent,
    }])),
    stacks: players.stacks,
    playerPairs: {}, champPairs: {}, profileSums: {}, processed: [],
    championNames: players.champions, ddragonVersion: players.ddragonVersion,
    meta: structuredClone(meta), lastRefresh: players.generatedAt,
    lastMetaRefresh: meta.analyzedAt,
  };
  const values = new Map([['state', JSON.stringify(state)]]);
  const writes = [];
  const env = { KV: {
    async get(key, type) {
      const value = values.get(key) ?? null;
      return type === 'json' && value !== null ? JSON.parse(value) : value;
    },
    async put(key, value, options) { writes.push({ key, options }); values.set(key, value); },
  } };
  const durable = new Map();
  const hub = new StateHub({ storage: {
    async get(key) { return durable.has(key) ? structuredClone(durable.get(key)) : undefined; },
    async put(key, value) { durable.set(key, structuredClone(value)); },
    async delete(key) { durable.delete(key); },
    async list() { return new Map(); },
    async setAlarm() {}, async deleteAlarm() {},
  } }, env);
  env.STATE = { idFromName: name => name, get: () => hub };
  return { env, values, writes, state };
}

async function scheduled(env) {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
}

for (const tier of [undefined, 'diamond_plus']) {
  test(`scheduled refresh requests ${tier || 'default Emerald+'} and preserves source metadata`, async t => {
    const { env, values, state } = fixture(tier);
    const requested = [];
    t.mock.method(globalThis, 'fetch', async input => {
      const url = new URL(input);
      requested.push(url);
      if (url.hostname === 'lol-api-champion.op.gg') return response(rawMeta);
      assert.equal(url.href, 'https://ddragon.leagueoflegends.com/api/versions.json');
      return response([state.ddragonVersion]);
    });
    const started = Date.now();
    await scheduled(env);
    assert.equal(requested[0].searchParams.get('tier'), tier || 'emerald_plus');
    assert.equal(requested[0].pathname, '/api/na/champions/ranked');
    const saved = JSON.parse(values.get('state'));
    assert.equal(saved.meta.tier, tier || 'emerald_plus');
    assert.equal(saved.meta.region, 'na');
    assert.equal(saved.meta.patch, meta.patch);
    assert.equal(saved.meta.analyzedAt, meta.analyzedAt);
    assert.equal(saved.meta.matchCount, meta.matchCount);
    assert.deepEqual(saved.meta.champions, meta.champions);
    assert.equal(saved.lastMetaRefresh, saved.meta.fetchedAt);
    assert(Date.parse(saved.meta.fetchedAt) >= started);
    assert(Date.parse(saved.meta.fetchedAt) <= Date.now());
    assert.deepEqual(JSON.parse(values.get('data')).meta, saved.meta);
  });
}

test('failed meta fetch preserves the last successful metadata and timestamp', async t => {
  const { env, values, state } = fixture();
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.hostname === 'lol-api-champion.op.gg') return new Response(null, { status: 503 });
    assert.equal(url.href, 'https://ddragon.leagueoflegends.com/api/versions.json');
    return response([state.ddragonVersion]);
  });
  await scheduled(env);
  const saved = JSON.parse(values.get('state'));
  assert.equal(saved.lastMetaRefresh, state.lastMetaRefresh);
  assert.deepEqual(saved.meta, state.meta);
  assert.deepEqual(JSON.parse(values.get('data')).meta, state.meta);
});

test('counter requests and cache entries are isolated by tier and patch', async t => {
  const { env, values, writes, state } = fixture();
  const champion = rawMeta.data.find(c => c.positions.length);
  const pos = champion.positions[0].name;
  const request = () => new Request(`https://compy.example/counters?champ=${champion.id}&pos=${pos}`);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(url.pathname, `/api/na/champions/ranked/${champion.id}/${pos}`);
    // An empty counter list isolates routing/cache behavior without inventing
    // matchup results. Patch provenance comes from the recorded source.
    return response({ meta: rawMeta.meta, data: { counters: [] } });
  });
  const first = await worker.fetch(request(), env);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.tier, 'emerald_plus');
  assert.equal(body.patch, meta.patch);
  assert.equal(calls[0].searchParams.get('tier'), 'emerald_plus');
  const defaultKey = `counters:na:emerald_plus:${meta.patch}:${champion.id}:${pos}`;
  assert(values.has(defaultKey));
  assert(writes.find(w => w.key === defaultKey).options.expirationTtl > 0);
  assert.deepEqual(await (await worker.fetch(request(), env)).json(), body);
  assert.equal(calls.length, 1, 'Same tier and patch should hit cache');

  state.config.metaTier = 'diamond_plus';
  values.set('state', JSON.stringify(state));
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(calls.length, 2, 'Another tier must miss the Emerald+ cache');
  assert.equal(calls[1].searchParams.get('tier'), 'diamond_plus');
  assert(values.has(`counters:na:diamond_plus:${meta.patch}:${champion.id}:${pos}`));

  delete state.meta;
  values.set('state', JSON.stringify(state));
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(calls.length, 3, 'Unknown/current patch must not reuse a versioned cache');
  assert(values.has(`counters:na:diamond_plus:latest:${champion.id}:${pos}`));
});
