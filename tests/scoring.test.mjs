import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the real inline application against recorded Riot/OP.GG data.
// No fabricated players, match results, or model-authored records are used.
const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const script = html.match(/<script>\s*"use strict";([\s\S]*?)<\/script>/)[1];
const source = '"use strict";' + script.slice(0, script.lastIndexOf('(async () => {'));
const players = JSON.parse(fs.readFileSync(new URL('data/players.json', root), 'utf8'));
const meta = JSON.parse(fs.readFileSync(new URL('data/meta.json', root), 'utf8'));
const run = (ctx, code) => vm.runInContext(code, ctx);

function context(storage = {}, code = source) {
  const values = new Map(Object.entries(storage));
  const ctx = vm.createContext({
    document: { addEventListener() {} },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    setInterval() {},
    players: structuredClone(players),
    meta: structuredClone(meta),
  });
  run(ctx, code);
  run(ctx, `
    D = players; META = meta;
    masteryIdx = Object.fromEntries(D.players.map(p => [p.riotId,
      Object.fromEntries(p.mastery.map(m => [m.championId, m.points]))]));
    champPairIdx = Object.fromEntries(D.championPairs.map(p =>
      [p.pa + "|" + p.a + ":" + p.pb + "|" + p.b, p]));
    playerPairIdx = Object.fromEntries(D.playerPairs.map(p => [[p.a,p.b].sort().join("|"), p]));
  `);
  return ctx;
}

function close(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} vs ${expected}`);
}

test('role range does not reuse saved all-role limits', () => {
  const ctx = context({ minGames: '20', maxGames: '25' });
  assert.equal(run(ctx, 'minGames'), 0);
  assert.equal(run(ctx, 'maxGames'), run(ctx, 'MAX_GAMES_OFF'));
  const saved = context({ minRoleGames: '4', maxRoleGames: '9' });
  assert.equal(run(saved, 'minGames'), 4);
  assert.equal(run(saved, 'maxGames'), 9);
});

test('normal and worst candidates honor role minimum and maximum in both queue and role modes', () => {
  const ctx = context();
  let returned = 0, empty = 0, allRoleWouldDiffer = 0;
  for (const flex of [false, true]) for (const strict of [false, true]) {
    run(ctx, `D = ${flex ? 'flexView(players)' : 'players'}; strictRole = ${strict};
      masteryMin = 0; masteryMax = MASTERY_OFF;
      indCache = {}; candCache = {};
      for (const k of Object.keys(roleShareCache)) delete roleShareCache[k];`);
    for (const [min, max] of [[1,31],[5,31],[3,8],[10,15],[30,31],[0,0]]) {
      run(ctx, `minGames = ${min}; maxGames = ${max}; candCache = {};`);
      const results = run(ctx, `D.players.flatMap(p => ROLES.flatMap(role =>
        ['candidates', 'worstCandidates'].map(kind => ({
          player: p.riotId, role, kind,
          picks: (kind === 'candidates' ? candidates : worstCandidates)(p.riotId, role, 10000)
            .map(cid => {
              const c = p.champions.find(c => c.championId === cid);
              return { cid, roleGames: c?.roles?.[role]?.games || 0, totalGames: c?.games || 0 };
            }),
        }))))`);
      for (const result of results) {
        if (!result.picks.length) empty++;
        for (const pick of result.picks) {
          returned++;
          assert(pick.roleGames >= min, `${result.kind}: ${result.player} ${pick.cid} ${result.role} below role minimum`);
          assert(max === 31 || pick.roleGames <= max, `${result.kind}: ${result.player} ${pick.cid} ${result.role} above role maximum`);
          if (max < 31 && pick.totalGames > max) allRoleWouldDiffer++;
        }
      }
    }
  }
  assert(returned > 0, 'Checks must exercise real returned candidates');
  assert(empty > 0, 'Checks must exercise empty pools without weakening filters');
  assert(allRoleWouldDiffer > 0, 'Actual records must distinguish in-role from all-role filtering');
});

test('stronger prior moves real individual records toward their role meta prior', () => {
  const now = context();
  const old = context({}, source.replace(/const K_IND = 10;/, 'const K_IND = 8;'));
  assert.equal(run(now, 'K_IND'), 10);
  const makeRows = `D.players.flatMap(p => p.champions.flatMap(c => ROLES.map(role => ({
    score: indScore(p.riotId,c.championId,role), prior: metaWR(c.championId,role),
    additions: masteryBonus(p.riotId,c.championId)
      - (roleShare(c,role) < 0.25 ? OFF_ROLE_PENALTY : 0)
      + roleComfort(p.riotId,role)
  }))))`;
  const next = run(now, makeRows), before = run(old, makeRows);
  assert(next.length > 0);
  next.forEach((row, i) => {
    const a = Math.abs(row.score - row.additions - row.prior);
    const b = Math.abs(before[i].score - before[i].additions - before[i].prior);
    assert(a <= b + 1e-12, 'Increasing prior weight must not move away from prior');
  });
  const diffs = next.map((r,i) => Math.abs(r.score-before[i].score)*100).sort((a,b)=>a-b);
  console.log(`Real-record sensitivity, all player/champion/role combinations: median ${diffs[Math.floor(diffs.length*.5)].toFixed(3)}pp; p90 ${diffs[Math.floor(diffs.length*.9)].toFixed(3)}pp absolute individual change (not an accuracy estimate).`);
});

test('legacy shadow pair model retains its historical 0.4 scale', () => {
  const now = context();
  const old = context({}, source.replace(/const SYNERGY_WEIGHT = 0\.4;/, 'const SYNERGY_WEIGHT = 0.5;'));
  assert.equal(run(now, 'SYNERGY_WEIGHT'), 0.4);
  const expressions = [
    `D.championPairs.map(p => champPairAdjRaw(p.pa,p.a,p.pb,p.b))`,
    `D.playerPairs.flatMap(p => ROLES.flatMap(ra => ROLES.map(rb => playerPairAdj(p.a,ra,p.b,rb))))`,
  ];
  for (const expression of expressions) {
    const next = run(now, expression), before = run(old, expression);
    assert(before.some(x => x !== 0), 'Checks must exercise nonzero recorded synergy');
    next.forEach((value,i) => close(value, before[i]*0.8, 'Synergy reduction'));
  }
});
