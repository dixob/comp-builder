import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const script = html.match(/<script>\s*"use strict";([\s\S]*?)<\/script>/)[1];
const source = '"use strict";' + script.slice(0, script.lastIndexOf('(async () => {'));
const players = JSON.parse(fs.readFileSync(new URL('data/players.json', root), 'utf8'));
const recorded = players.stacks.find(g => new Set(g.them.map(p => p.champ)).size === 5);
const enemyIds = recorded.them.map(p => p.champ);
const extraId = players.players.flatMap(p => p.champions).find(c => !enemyIds.includes(c.championId)).championId;
const otherIds = players.stacks.find(g => new Set(g.them.map(p => p.champ)).size === 5
  && g.them.every(p => !enemyIds.includes(p.champ))).them.map(p => p.champ);

function context() {
  const c = vm.createContext({document:{addEventListener(){}},setInterval(){},
    localStorage:{getItem(){return null;},removeItem(){}},enemyIds,otherIds,extraId,players});
  vm.runInContext(source, c);
  vm.runInContext('D=players;draftMode=true;ensureEnemyCounters=()=>{};', c);
  return c;
}
const run = (c, code) => vm.runInContext(code, c);

test('manual enemy draft rejects a sixth pick and duplicates without changing its five picks', () => {
  const c = context();
  for (const cid of enemyIds) assert.equal(run(c, `addManualEnemy(${cid})`), null);
  assert.match(run(c, 'addManualEnemy(extraId)'), /five enemy picks/);
  assert.match(run(c, 'addManualEnemy(enemyIds[0])'), /already an enemy pick/);
  assert.deepEqual(Array.from(run(c, '[...effEnemy()]')), enemyIds);
});

test('enemy capacity includes live picks and excludes banned champions', () => {
  const c = context();
  run(c, 'liveEnemy=new Set(enemyIds);');
  assert.match(run(c, 'addManualEnemy(extraId)'), /five enemy picks/);
  run(c, 'liveEnemy.clear();manualBans.add(extraId);');
  assert.match(run(c, 'addManualEnemy(extraId)'), /banned/);
  assert.equal(run(c, 'manualEnemy.size'), 0);
});

test('manual lane changes keep one certain opponent per role and swap existing locks', () => {
  const c = context();
  run(c, `manualEnemy=new Set(enemyIds);setEnemyRole(enemyIds[0],'TOP');setEnemyRole(enemyIds[1],'TOP');`);
  assert.equal(run(c, 'enemyRole.has(enemyIds[0])'), false);
  assert.equal(run(c, 'enemyRole.get(enemyIds[1])'), 'TOP');
  run(c, `setEnemyRole(enemyIds[0],'MIDDLE');setEnemyRole(enemyIds[1],'MIDDLE');`);
  assert.equal(run(c, 'enemyRole.get(enemyIds[0])'), 'TOP');
  assert.equal(run(c, 'enemyRole.get(enemyIds[1])'), 'MIDDLE');
  run(c, `setEnemyRole(enemyIds[1],'');`);
  assert.equal(run(c, 'enemyRole.has(enemyIds[1])'), false);
});

test('removing and readding a manual enemy clears its previous lane lock', () => {
  const c = context();
  run(c, `addManualEnemy(enemyIds[0]);setEnemyRole(enemyIds[0],'TOP');removeManualEnemy(enemyIds[0]);addManualEnemy(enemyIds[0]);`);
  assert.equal(run(c, 'enemyRole.has(enemyIds[0])'), false);
  run(c, `liveEnemy.add(enemyIds[0]);setEnemyRole(enemyIds[0],'TOP');removeManualEnemy(enemyIds[0]);`);
  assert.equal(run(c, 'effEnemy().has(enemyIds[0])'), true);
  assert.equal(run(c, 'enemyRole.get(enemyIds[0])'), 'TOP');
});

test('incoming live picks replace excess manual guesses and retain only open slots', () => {
  const c = context();
  run(c, `manualEnemy=new Set(enemyIds);enemyRole.set(enemyIds[4],'TOP');
    liveEnemy=new Set(otherIds.slice(0,3));reconcileManualDraft();`);
  assert.equal(run(c, 'effEnemy().size'), 5);
  assert.deepEqual(Array.from(run(c, '[...manualEnemy]')), enemyIds.slice(0,2));
  assert.equal(run(c, 'enemyRole.has(enemyIds[4])'), false);
  run(c, 'liveEnemy=new Set(otherIds);manualBans.add(otherIds[0]);reconcileManualDraft();');
  assert.deepEqual(Array.from(run(c, '[...effEnemy()]')), otherIds);
  assert.equal(run(c, 'manualEnemy.size'), 0);
  assert.equal(run(c, 'manualBans.has(otherIds[0])'), false);
});
