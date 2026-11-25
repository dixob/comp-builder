import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const script = html.match(/<script>\s*"use strict";([\s\S]*?)<\/script>/)[1];
const source = '"use strict";' + script.slice(0, script.lastIndexOf('(async () => {'));
const players = JSON.parse(fs.readFileSync(new URL('data/players.json', root), 'utf8'));
const meta = JSON.parse(fs.readFileSync(new URL('data/meta.json', root), 'utf8'));
const run = (context, code) => vm.runInContext(code, context);

function context(storage = {}) {
  const values = new Map(Object.entries(storage));
  const elements = new Map();
  const classList = { toggle() {}, remove() {}, add() {} };
  const ctx = vm.createContext({
    setInterval() {}, setTimeout, clearTimeout, AbortController,
    document: {
      addEventListener() {}, body: { classList },
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, { classList, innerHTML: '', addEventListener() {}, focus() {} });
        return elements.get(selector);
      },
      querySelectorAll() { return []; },
    },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    players: structuredClone(players), meta: structuredClone(meta),
  });
  run(ctx, source);
  run(ctx, `D=players; META=meta; setHaunt=()=>{};
    masteryIdx=Object.fromEntries(D.players.map(p=>[p.riotId,
      Object.fromEntries(p.mastery.map(m=>[m.championId,m.points]))]));
    for(const p of D.players) included[p.riotId]=true;`);
  return { ctx, elements };
}

test('empty no-repeat searches render filter guidance in every tab', () => {
  const { ctx, elements } = context();
  run(ctx, `uniqueComps=true; masteryMin=MASTERY_OFF; masteryMax=0;
    slots=D.players.slice(0,5).map(p=>({player:p.riotId,champ:null}));`);
  for (const tab of ['overall', 'assigned', 'worst']) {
    run(ctx, `switchTab('${tab}')`);
    assert.equal(run(ctx, `rankedTabs['${tab}'].length`), 0);
    assert.match(elements.get('#ranked').innerHTML, /No eligible|No valid|No composition|No .*comp/i);
  }
  assert.equal(run(ctx, `uniqueList('overall',null).length`), 0);
});

test('stored filter bounds remain finite and ordered after invalid values', () => {
  const { ctx } = context({
    masteryFloor: 'not-a-number', masteryMax: 'Infinity',
    minRoleGames: '-7', maxRoleGames: '', fearlessSince: 'NaN',
  });
  assert.deepEqual(Array.from(run(ctx, '[masteryMin,masteryMax,minGames,maxGames,fearlessSince]')),
    [30000, 200000, 0, 31, 0]);
  const reversed = context({ masteryFloor: '250000', masteryMax: '10000', minRoleGames: '9', maxRoleGames: '2' });
  assert.deepEqual(Array.from(run(reversed.ctx, '[masteryMin,masteryMax,minGames,maxGames]')),
    [200000, 200000, 9, 9]);
});

test('rightmost role minimum survives reload without relaxing the filter', () => {
  const { ctx } = context({ minRoleGames: '31', maxRoleGames: '31' });
  assert.equal(run(ctx, 'minGames'), 31);
  assert.equal(run(ctx, 'inGamesRange(30)'), false);
  assert.equal(run(ctx, 'inGamesRange(31)'), true);
  assert.equal(run(ctx, 'gamesLabel()'), '≥ 31');
});

test('invalid fearless cache cannot prevent application initialization', () => {
  for (const value of ['{', 'null', '{}', '1', '[null]', '[{}]']) {
    const { ctx } = context({ fearlessEval: value });
    assert.equal(run(ctx, 'fearlessEval.length'), 0, value);
    assert.equal(run(ctx, 'rebuildFearlessChamps()'), false, value);
  }
});

test('fearless cache retains real match identities and rejects malformed entries', () => {
  // Existing recorded match content is projected into the cache schema;
  // corruptions below probe storage types, not invented match outcomes.
  const game = players.stacks.find(g => new Set(g.us.map(p => p.champ)).size === 5);
  const entry = { id: game.id, end: game.ts, champs: game.us.map(p => p.champ) };
  const unmatched = { ...entry, champs: 0 };
  const cache = [entry, unmatched, null, { ...entry, end: 'invalid' },
    { ...entry, champs: entry.champs.slice(0, 1) }, { ...entry, champs: Array(5).fill(entry.champs[0]) }];
  const { ctx } = context({ fearlessEval: JSON.stringify(cache) });
  assert.deepEqual(JSON.parse(run(ctx, 'JSON.stringify(fearlessEval)')), [entry, unmatched]);
});

test('late draft responses cannot rewind picks or resume disabled draft mode', () => {
  const { ctx } = context();
  // Project an existing recorded five-stack into the live transport shape.
  const game = players.stacks.find(g => g.us.every(p => p.rid && p.role));
  ctx.recordedDraft = {
    ts: game.ts, active: true, bans: [], enemy: game.them.map(p => p.champ),
    ours: game.us.map(p => ({ riotId: p.rid, position: p.role, championId: p.champ })),
  };
  run(ctx, `draftMode=true; updateLiveIndicator=()=>{}; draftChanged=()=>{};
    ensureEnemyCounters=()=>{}; fetchFearless=()=>{}; ensureIncluded=()=>{};
    setIncluded=(rid,val)=>{included[rid]=val;};
    applyLiveDraft(recordedDraft);
    applyLiveDraft({...recordedDraft,ts:recordedDraft.ts-1,enemy:[]});`);
  assert.equal(run(ctx, 'liveDraft.ts'), game.ts);
  assert.equal(run(ctx, 'liveEnemy.size'), 5);
  run(ctx, `applyLiveDraft({...recordedDraft,evaluation:{updatedAt:recordedDraft.ts+2}});
    applyLiveDraft({...recordedDraft,evaluation:{updatedAt:recordedDraft.ts+1},enemy:[]});`);
  assert.equal(run(ctx, 'liveDraft.evaluation.updatedAt'), game.ts + 2);
  assert.equal(run(ctx, 'liveEnemy.size'), 5);
  run(ctx, `draftMode=false;applyLiveDraft({...recordedDraft,ts:recordedDraft.ts+3,enemy:[]});`);
  assert.equal(run(ctx, 'liveDraft.ts'), game.ts);
  assert.equal(run(ctx, 'liveEnemy.size'), 5);
});

test('role swaps refresh all cached searches after moving pick locks', () => {
  for (const tab of ['assigned', 'overall', 'worst']) {
    const { ctx } = context();
    run(ctx, `draftMode=true; activeTab='${tab}';
      renderSlots=()=>{}; renderScore=()=>{}; renderTabs=()=>{};
      board=optimize(1)[0].assign;slots=board.map(a=>({player:a.player,champ:a.champ}));
      allyLock.set(ROLES[0],slots[0].champ);allyLock.set(ROLES[1],slots[1].champ);candCache={};
      rankedTabs.assigned=optimizeChamps(3,lockPins().fixed);
      rankedTabs.overall=optimize(3,lockPins().fixed,lockPins().pinPlayer);
      rankedTabs.worst=optimizeWorst(3,lockPins().fixed,lockPins().pinPlayer);
      swapRoleSlots(0,1);`);
    assert.equal(run(ctx, `allyLock.get('TOP')`), run(ctx, 'board[1].champ'));
    assert.equal(run(ctx, `allyLock.get('JUNGLE')`), run(ctx, 'board[0].champ'));
    assert(run(ctx, `rankedTabs[activeTab].length>0 && rankedTabs[activeTab].every(r=>
      r.assign[0].champ===board[1].champ && r.assign[0].player===board[1].player
      && r.assign[1].champ===board[0].champ && r.assign[1].player===board[0].player)`));
    for (const inactive of ['assigned', 'overall', 'worst'].filter(x => x !== tab)) {
      assert.equal(run(ctx, `rankedTabs['${inactive}']`), null);
    }
  }
});

test('results and sortable table headers expose native keyboard buttons', () => {
  const { ctx, elements } = context();
  run(ctx, 'renderRanked(optimize(1))');
  assert.match(elements.get('#ranked').innerHTML, /<button[^>]+aria-label="Load composition 1/);
  run(ctx, 'renderProfilePane()');
  assert.equal((elements.get('#ranked').innerHTML.match(/<button[^>]+data-sort-button=/g) || []).length, 7);
  run(ctx, 'renderBoardPane()');
  assert.equal((elements.get('#ranked').innerHTML.match(/<button[^>]+data-lbsort-button=/g) || []).length, 7);
  assert.match(elements.get('#ranked').innerHTML, /<button[^>]+aria-label="Open /);
});

test('history scoreboards expand and collapse with Enter and Space', () => {
  const { ctx, elements } = context();
  const handlers = {};
  let focuses = 0, prevented = 0;
  const row = { dataset: { mh: players.stacks[0].id }, focus() { focuses++; },
    addEventListener(type, handler) { handlers[type] = handler; } };
  ctx.document.querySelectorAll = selector => selector === '[data-mh]' ? [row] : [];
  run(ctx, 'renderHistoryPane()');
  assert.match(elements.get('#ranked').innerHTML, /role="button" tabindex="0" aria-expanded="false"/);
  handlers.keydown({ key: 'Enter', preventDefault() { prevented++; } });
  assert.equal(run(ctx, 'mhOpen.size'), 1);
  assert.match(elements.get('#ranked').innerHTML, /aria-expanded="true"/);
  handlers.keydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(run(ctx, 'mhOpen.size'), 0);
  assert.equal(prevented, 2);
  assert.equal(focuses, 2);
});
