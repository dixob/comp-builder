import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Recorded Riot/OP.GG evidence only. IDs and a compact match were extracted
// from the existing cache; tests vary clocks/transport, not match outcomes.
const root = new URL('../', import.meta.url);
const players = JSON.parse(fs.readFileSync(new URL('data/players.json', root)));
const match = JSON.parse(fs.readFileSync(new URL('tests/fixtures/recorded-flex-match.json', root)));
const ids = JSON.parse(fs.readFileSync(new URL('tests/fixtures/recorded-match-ids.json', root)));
const source = fs.readFileSync(new URL('worker/src/index.js', root), 'utf8');
const { StateHub, DraftHub, default: worker, compactMatch, matchExclusion, initializeHistory,
  rebuildHistory, expireHistory, historyStatus } = await import('data:text/javascript;base64,' +
    Buffer.from(source + '\nexport {compactMatch,matchExclusion,initializeHistory,rebuildHistory,expireHistory,historyStatus};').toString('base64'));
const response = body => new Response(JSON.stringify(body));

function seed(legacy = false) {
  const state = {
    config: { platform: 'na1', queue: 'ranked', maxMatchAgeDays: 365,
      riotIds: players.players.map(p => ({ riotId: p.riotId, puuid: p.puuid, puuids: p.puuidHistory || [p.puuid] })) },
    players: Object.fromEntries(players.players.map(p => [p.riotId, {
      mastery: p.mastery, ranks: p.ranks, profileIconId: p.profileIconId,
      champs: Object.fromEntries(p.champions.map(({ championId, ...rec }) => [championId, rec])),
      queues: p.queues, recent: p.recent,
    }])),
    processed: [match.metadata.matchId], playerPairs: {}, champPairs: {}, profileSums: {}, stacks: [],
    championNames: players.champions, ddragonVersion: players.ddragonVersion,
    lastRefresh: players.generatedAt,
  };
  if (!legacy) state.history = { version: 1, complete: true,
    matches: { [match.metadata.matchId]: compactMatch(match) }, excluded: {} };
  initializeHistory(state);
  if (!legacy) rebuildHistory(state);
  return state;
}
function harness(state) {
  const kv = new Map([['state', JSON.stringify(state)]]), stored = new Map();
  const storage = {
    async get(k) { return structuredClone(stored.get(k)); },
    async put(k,v) { if(typeof k === "object") { for(const [key,value] of Object.entries(k)) stored.set(key,structuredClone(value)); } else stored.set(k, structuredClone(v)); },
    async list({prefix,startAfter,limit=1000}) { return new Map([...stored].filter(([k])=>k.startsWith(prefix)&&(!startAfter||k>startAfter)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit).map(([k,v])=>[k,structuredClone(v)])); },
    async getAlarm() { return stored.get("alarm")||null; },
    async delete(k) { stored.delete(k); },
    async setAlarm(v) { stored.set('alarm',v); },
    async deleteAlarm() { stored.delete('alarm'); },
  };
  const env = { ADMIN_TOKEN: 'test-only-transport-token', KV: {
    async get(k,type) { const v = kv.get(k); return type === 'json' && v ? JSON.parse(v) : v ?? null; },
    async put(k,v) { kv.set(k,v); },
  } };
  const hub = new StateHub({storage},env);
  env.STATE = { idFromName: n=>n, get: ()=>hub };
  return { hub,env,kv,stored,storage };
}
const request = path => new Request('https://compy.example'+path, { method: path === '/refresh' ? 'POST' : 'GET' });

function completeDiscovery(state) {
  for (const d of Object.values(state.ingest.discovery)) {
    d.coveredThrough = Math.floor(Date.now()/1000); d.lastFullScan = Date.now(); d.scan = null;
  }
}

test('queue policy and rolling expiry rebuild from recorded events without changing source evidence', () => {
  const state = seed();
  assert.equal(matchExclusion(match, {queue:420,maxMatchAgeDays:0}), 'queue');
  assert.equal(matchExclusion(match, {queue:'ranked',maxMatchAgeDays:0}), null);
  assert(state.processed.includes(match.metadata.matchId));
  const later = match.info.gameStartTimestamp + 366*86400000;
  assert(expireHistory(state,later));
  assert.equal(state.processed.length,0);
  assert.equal(state.history.excluded[match.metadata.matchId],'expired');
  assert(Object.values(state.players).every(p=>Object.keys(p.champs).length===0));
});

test('legacy import preserves counters, stores private backup, and exposes incomplete coverage', async () => {
  const original = seed(true), {hub,env,stored} = harness(original);
  const result = await (await worker.fetch(request('/data'),env)).json();
  assert.equal(result.history.complete,false);
  assert.equal(result.history.status,'rehydrating');
  assert.deepEqual((await hub.readSnapshot('backup:import')).players,original.players);
  assert.equal(result.players.players[0].champions.length,Object.keys(original.players[players.players[0].riotId].champs).length);
  assert(stored.has('active:manifest'));
  assert(!('matches' in result.history));
});

test('paginated discovery is durable past 100 IDs and failed match fetch retains pending work', async t => {
  const state = seed();
  state.config.riotIds = state.config.riotIds.slice(0,1);
  state.ingest.discovery = {[state.config.riotIds[0].riotId]: {coveredThrough:null,lastFullScan:null,scan:null}};
  const {hub,env} = harness(state), pages=[];
  t.mock.method(globalThis,'fetch',async input => {
    const u = new URL(input);
    if (u.pathname.endsWith('/ids')) {
      const start=Number(u.searchParams.get('start'));pages.push({start,end:u.searchParams.get('endTime')});
      return response(ids.slice(start,start+100));
    }
    return new Response(null,{status:429});
  });
  const first = await (await worker.fetch(request('/refresh'),env)).json();
  assert(first.remaining >= 100);
  assert(first.retryAfter > 0);
  let persisted = await hub.readSnapshot();
  assert.equal(Object.values(persisted.ingest.discovery)[0].scan.start,100);
  const pending = [...persisted.ingest.pending];
  persisted.ingest.retryAt=0;
  await hub.writeSnapshot(persisted);
  await worker.fetch(request('/refresh'),env);
  persisted = await hub.readSnapshot();
  assert.deepEqual(pages.map(p=>p.start),[0,100]);
  assert.equal(pages[0].end,pages[1].end,'endTime freezes pages against new arrivals');
  for (const id of pending) assert(persisted.ingest.pending.includes(id));
  assert(persisted.ingest.pending.length >= 100);
});

test('404 evidence remains explicit and automatically retryable instead of completing migration', async t => {
  const state = seed(true);completeDiscovery(state);
  const {hub,env,stored} = harness(state);
  t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:404}));
  const result = await (await worker.fetch(request('/refresh'),env)).json();
  const saved = await hub.readSnapshot();
  assert.equal(result.history.status,'unavailable');
  assert.equal(result.history.complete,false);
  assert(saved.history.legacyRemaining.includes(match.metadata.matchId));
  assert(saved.history.unavailable[match.metadata.matchId].retryAt > Date.now());
  assert(stored.get('alarm') > Date.now());
  assert.deepEqual(saved.players,state.players,'Unknown legacy evidence must not erase old stats');
});

test('a broken player discovery does not prevent another account or queued match from progressing', async t => {
  const state = seed(true);
  state.config.riotIds=state.config.riotIds.slice(0,2);
  state.ingest.discovery = Object.fromEntries(state.config.riotIds.map(a=>[a.riotId,{coveredThrough:null,lastFullScan:null,scan:null}]));
  const {hub,env} = harness(state), visited=[];
  t.mock.method(globalThis,'fetch',async input => {
    const u = new URL(input);visited.push(u.pathname);
    if(u.pathname.includes(state.config.riotIds[0].puuid)&&u.pathname.endsWith('/ids')) return new Response(null,{status:404});
    if(u.pathname.endsWith('/ids')) return response([]);
    if(u.pathname.endsWith('/'+match.metadata.matchId)) return response(match);
    return response([]);
  });
  await worker.fetch(request('/refresh'),env);
  const saved=await hub.readSnapshot();
  assert(visited.some(p=>p.includes(state.config.riotIds[1].puuid)));
  assert(saved.history.matches[match.metadata.matchId]);
  assert(!saved.ingest.pending.includes(match.metadata.matchId));
  assert(saved.ingest.discovery[state.config.riotIds[0].riotId].error);
  assert(saved.ingest.discovery[state.config.riotIds[1].riotId].coveredThrough);
});

test('queued work bypasses idle debounce and missing STATE never falls back to uncoordinated writes', async t => {
  const state=seed(true);completeDiscovery(state);state.ingest.lastAttempt=new Date().toISOString();
  const {hub,env}=harness(state);
  t.mock.method(globalThis,'fetch',async input=>new URL(input).pathname.endsWith('/'+match.metadata.matchId)?response(match):response([]));
  const result=await (await worker.fetch(request('/refresh'),env)).json();
  assert.equal(result.fetched,1);
  assert(!(await hub.readSnapshot()).ingest.pending.length);
  delete env.STATE;
  const error=await worker.fetch(request('/refresh'),env);
  assert.equal(error.status,500);
  assert.match((await error.json()).error,/binding is required/);
});

test('durable writer queue includes network waits and failed chunk write preserves previous pointer', async () => {
  const {hub,storage,stored}=harness(seed());
  await hub.load();
  const before=await hub.readSnapshot(), order=[];
  let release;
  const barrier=new Promise(r=>{release=r;});
  const first=hub.serial(async()=>{order.push('first-start');await barrier;order.push('first-end');});
  const second=hub.serial(async()=>{order.push('second');});
  await Promise.resolve();assert.deepEqual(order,['first-start']);release();await Promise.all([first,second]);
  assert.deepEqual(order,['first-start','first-end','second']);
  const originalPut=storage.put;
  storage.put=async(k,v)=>{if(k.startsWith('chunk:'))throw new Error('storage unavailable');return originalPut(k,v);};
  const changed=structuredClone(before);changed.lastRefresh=new Date().toISOString();
  await assert.rejects(hub.writeSnapshot(changed),/storage unavailable/);
  storage.put=originalPut;
  assert.deepEqual(await hub.readSnapshot(),before);
  assert(stored.has('backup:import:manifest'));
});

test('a failing queued match cannot block another match and successful retries never double-count', async t => {
  const state=seed(true);completeDiscovery(state);
  const other=ids.find(id=>id!==match.metadata.matchId);
  state.ingest.pending=[other,match.metadata.matchId];
  const {hub,env}=harness(state);
  t.mock.method(globalThis,'fetch',async input=>{
    const u=new URL(input);
    if(u.pathname.endsWith('/'+other))return new Response(null,{status:500});
    if(u.pathname.endsWith('/'+match.metadata.matchId))return response(match);
    return response([]);
  });
  const result=await (await worker.fetch(request('/refresh'),env)).json();
  let saved=await hub.readSnapshot();
  assert.equal(result.fetched,1);
  assert(saved.history.matches[match.metadata.matchId]);
  assert(saved.ingest.pending.includes(other));
  assert(saved.ingest.matchRetries[other].retryAt>Date.now());
  const total=Object.values(saved.players).reduce((sum,p)=>sum+Object.values(p.queues).reduce((n,q)=>n+q.games,0),0);
  await worker.fetch(request('/refresh'),env);
  saved=await hub.readSnapshot();
  assert.equal(Object.values(saved.players).reduce((sum,p)=>sum+Object.values(p.queues).reduce((n,q)=>n+q.games,0),0),total);
});

// Protocol tests use the checked-in real match, a neutral numeric baseline,
// and a clock before that match. They do not claim historical model accuracy.
function evaluationFixture(t) {
  const state=seed(), h=harness(state), captured=match.info.gameStartTimestamp-60000;
  t.mock.method(Date,'now',()=>captured);
  const comp=match.info.participants.filter(p=>p.teamId===100).map(p=>({
    riotId:state.config.riotIds.find(a=>(a.puuids||[a.puuid]).includes(p.puuid))?.riotId,
    championId:p.championId,role:p.teamPosition,puuid:p.puuid,
  }));
  assert(comp.every(p=>p.riotId));
  const draft={active:true,sessionId:match.metadata.matchId,ts:captured,
    ours:comp.map(p=>({riotId:p.riotId,position:p.role,championId:p.championId})),
    enemy:match.info.participants.filter(p=>p.teamId===200).map(p=>p.championId)};
  h.env.DRAFT={idFromName:n=>n,get:()=>({fetch:async()=>response(draft)})};
  const record={schemaVersion:1,id:'transport-check',modelVersion:'constant-baseline',
    captureStage:'pregame',capturedAt:new Date(captured).toISOString(),side:null,
    queue:440,comp,scores:{current:.5},automatic:{sessionId:draft.sessionId}};
  const post=value=>worker.fetch(new Request('https://compy.example/evaluation',{
    method:'POST',body:JSON.stringify(value)}),h.env);
  const get=token=>worker.fetch(new Request('https://compy.example/evaluation',{
    headers:token?{'x-admin-token':token}:{}}),h.env);
  return {...h,state,draft,record,post,get,captured};
}
test('automatic collection verifies live identities, deduplicates tabs, and protects export',async t=>{
  const h=evaluationFixture(t);
  assert.equal((await h.get()).status,403);
  const result=await h.post(h.record);assert.equal(result.status,200,await result.text());
  assert.equal((await (await h.post(h.record)).json()).duplicate,true);
  const exported=await (await h.get(h.env.ADMIN_TOKEN)).json();
  assert.equal(exported.records.length,1);assert.equal(exported.matches.length,0);
  assert.equal(exported.records[0].capturedAt,new Date(h.captured).toISOString());
  assert(h.stored.get('alarm')>h.captured);
  const wrong=structuredClone(h.record);[wrong.comp[0].championId,wrong.comp[1].championId]=[wrong.comp[1].championId,wrong.comp[0].championId];
  assert.equal((await h.post(wrong)).status,400);
  assert.equal((await h.post({...h.record,outcome:1})).status,400);
  assert.equal((await h.post({...h.record,capturedAt:new Date(h.captured-60000).toISOString()})).status,400);
  h.draft.active=false;
  assert.equal((await h.post(h.record)).status,409);
});
test('automatic outcomes retain real match evidence and reject post-start and wrong-side records',async t=>{
  const h=evaluationFixture(t);
  assert.equal((await h.post(h.record)).status,200);
  await h.hub.reconcileEvaluation(h.state);
  const exported=await (await h.get(h.env.ADMIN_TOKEN)).json();
  assert.equal(exported.matches.length,1);
  assert.equal(exported.matches[0].metadata.matchId,match.metadata.matchId);
  assert.deepEqual(exported.matches[0],compactMatch(match));
  assert(!('outcome' in exported.records[0]));
  assert.equal(exported.collection[0].matchedIds[0],match.metadata.matchId);
  // Export stays available even if the rolling history window expires later.
  h.state.history.matches={};await h.hub.reconcileEvaluation(h.state);
  assert.equal((await (await h.get(h.env.ADMIN_TOKEN)).json()).matches.length,1);
});
test('evaluation matching refuses late captures, wrong roles, queues and sides',async()=>{
  const {evaluationMatch}=await import('data:text/javascript;base64,'+
    Buffer.from(source+'\nexport {evaluationMatch};').toString('base64'));
  const team=match.info.participants.filter(p=>p.teamId===100);
  const record={capturedAt:new Date(match.info.gameStartTimestamp-60000).toISOString(),queue:440,side:100,
    comp:team.map(p=>({riotId:p.riotIdGameName+'#'+p.riotIdTagline,puuid:p.puuid,championId:p.championId,role:p.teamPosition}))};
  assert(evaluationMatch(record,match));
  assert(!evaluationMatch({...record,capturedAt:new Date(match.info.gameStartTimestamp).toISOString()},match));
  assert(!evaluationMatch({...record,queue:420},match));
  assert(!evaluationMatch({...record,side:200},match));
  const wrong=structuredClone(record);[wrong.comp[0].role,wrong.comp[1].role]=[wrong.comp[1].role,wrong.comp[0].role];
  assert(!evaluationMatch(wrong,match));
});

test('draft session identity survives heartbeats and rotates after a closed lobby',async t=>{
 const h=evaluationFixture(t);
 const draftHub=new DraftHub({storage:h.storage,getWebSockets:()=>[]});
 const post=payload=>draftHub.fetch(new Request('https://compy.example/draft',{method:'POST',body:JSON.stringify(payload)}));
 const payload={...h.draft,owner:'test-transport-owner'};
 await post(payload);
 const first=JSON.parse(h.stored.get('draft')).sessionId;
 assert(first);assert.notEqual(first,payload.sessionId,'Client cannot choose the server session ID');
 await post(payload);assert.equal(JSON.parse(h.stored.get('draft')).sessionId,first);
 assert.equal((await post({...payload,owner:'another-transport-owner'})).status,409);
 await post({active:false,owner:payload.owner});
 await post(payload);assert.notEqual(JSON.parse(h.stored.get('draft')).sessionId,first);
});
