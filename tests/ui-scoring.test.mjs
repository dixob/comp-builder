import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const html=fs.readFileSync(new URL('index.html',root),'utf8');
const script=html.match(/<script>\s*"use strict";([\s\S]*?)<\/script>/)[1];
const source='"use strict";'+script.slice(0,script.lastIndexOf('(async () => {'));
const players=JSON.parse(fs.readFileSync(new URL('data/players.json',root),'utf8'));
const meta=JSON.parse(fs.readFileSync(new URL('data/meta.json',root),'utf8'));
const run=(ctx,code)=>vm.runInContext(code,ctx);
function context(code=source){
 const ctx=vm.createContext({setTimeout,clearTimeout,AbortController,document:{addEventListener(){}},localStorage:{getItem(){return null;},removeItem(){},setItem(){}},setInterval(){},players:structuredClone(players),meta:structuredClone(meta)});
 run(ctx,code);
 run(ctx,`D=players; META=meta;
 masteryIdx=Object.fromEntries(D.players.map(p=>[p.riotId,Object.fromEntries(p.mastery.map(m=>[m.championId,m.points]))]));
 champPairIdx=Object.fromEntries(D.championPairs.map(p=>[p.pa+'|'+p.a+':'+p.pb+'|'+p.b,p]));
 playerPairIdx=Object.fromEntries(D.playerPairs.map(p=>[[p.a,p.b].sort().join('|'),p]));
 for(const p of D.players) included[p.riotId]=true;`);
 return ctx;
}
test('explanations reconcile with real role scores and shrink comfort',()=>{
 const c=context();
 const rows=run(c,`D.players.flatMap(p=>p.champions.flatMap(ch=>ROLES.map(role=>({
 e:pickEvidence(p.riotId,ch.championId,role),score:indScore(p.riotId,ch.championId,role),
 rawComfort:ROLE_COMFORT_WEIGHT*(playerRoleShare(p.riotId,role)-.2),mastery:masteryBonus(p.riotId,ch.championId)}))))`);
 assert(rows.length>0);
 for(const {e,score,rawComfort,mastery}of rows){assert.equal(mastery,0);assert(Math.abs(e.comfort)<=Math.abs(rawComfort)+1e-12);assert(Math.abs(score-(e.shrunkPersonal+e.comfort-e.rolePenalty))<1e-12);assert(e.priorWeight>0&&e.priorWeight<=1);}
 const missing=run(c,`D.players.flatMap(p=>p.champions.flatMap(ch=>ROLES.filter(role=>META.champions[ch.championId]?.winRate!=null&&!META.champions[ch.championId]?.positions?.[OPGG_POS[role]]).map(role=>({prior:metaWR(ch.championId,role),overall:META.champions[ch.championId].winRate,source:metaSource(ch.championId,role)}))))`);
 assert(missing.length);for(const r of missing){assert.equal(r.prior,r.overall);assert.match(r.source,/fallback/);}
});
test('matchup expectation is neutral for equal champions and symmetric for actual champions',()=>{
 const c=context();const ids=Object.keys(meta.champions).map(Number);
 for(let i=1;i<ids.length;i++)for(const role of ['TOP','MIDDLE','BOTTOM']){
  const same=run(c,`expectedMatchupWR(${ids[i]},${ids[i]},'${role}')`);assert.equal(same,.5);
  const sum=run(c,`expectedMatchupWR(${ids[i]},${ids[i-1]},'${role}')+expectedMatchupWR(${ids[i-1]},${ids[i]},'${role}')`);assert(Math.abs(sum-1)<1e-12);
 }
});
test('local prospective records capture chosen comp and pregame ablations without outcomes',()=>{
 const c=context();run(c,`slots=D.players.slice(0,5).map(p=>({player:p.riotId,champ:null}));`);
 const record=run(c,`predictionRecord(optimizeChamps(1)[0].assign)`);
 assert.equal(record.comp.length,5);assert.equal(record.evidence.length,5);assert.equal(record.modelVersion,'2026-11-24.3');
 assert(!('outcome'in record));assert(!('win'in record));assert.equal(record.scores.noMastery,record.scores.current);
 for(const value of Object.values(record.scores))assert(value>=.05&&value<=.95);
 assert(record.comp.every(p=>p.puuid&&p.puuidHistory.includes(p.puuid)));
 assert(record.candidates.every(p=>p.championIds.length<=8));
 const validation=spawnSync('python3',['-c','import json,sys; from scripts.evaluate_predictions import validate_record; validate_record(json.load(sys.stdin))'],{cwd:root,input:JSON.stringify(record),encoding:'utf8'});
 assert.equal(validation.status,0,validation.stderr);
});

const close=(actual,expected)=>assert(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);
function setRecordedBoard(c){
 run(c,`slots=D.players.slice(0,5).map(p=>({player:p.riotId,champ:null}));
  board=optimizeChamps(1)[0].assign;slots=board.map(a=>({player:a.player,champ:a.champ}));`);
 return run(c,'board');
}

test('single-swap recommendations rank full compositions, reject duplicates, and respect locks and bans',()=>{
 const c=context();setRecordedBoard(c);
 const before=run(c,'JSON.stringify(slots)');
 const rows=run(c,`ROLES.map(role=>({role,options:replacementRecommendations(board,role),
  direct:candidates(board.find(a=>a.role===role).player,role,15)
    .filter(cid=>!board.some(a=>a.champ===cid))
    .map(cid=>({cid,raw:compScore(board.map(a=>({...a,champ:a.role===role?cid:a.champ}))).rawTotal}))}))`);
 assert(rows.some(r=>r.options.length));
 for(const r of rows){
  r.direct.sort((a,b)=>b.raw-a.raw||a.cid-b.cid);
  assert.deepEqual(Array.from(r.options,x=>x.cid),Array.from(r.direct,x=>x.cid));
  for(const o of r.options){assert.equal(new Set(o.comp.map(a=>a.champ)).size,5);close(o.rankScore,o.score.rawTotal);}
 }
 assert.equal(run(c,'JSON.stringify(slots)'),before,'Recommendations must not mutate the board');
 run(c,`draftMode=true;manualBans.add(replacementRecommendations(board,ROLES[0])[0].cid);candCache={};`);
 assert(run(c,'replacementRecommendations(board,ROLES[0]).every(a=>!manualBans.has(a.cid))'));
 run(c,`allyLock.set(ROLES[0],board[0].champ);`);
 assert.equal(run(c,'replacementRecommendations(board,ROLES[0]).length'),0);
 run(c,`allyLock.clear();liveOurs=[{position:ROLES[0],championId:board[0].champ}];`);
 assert.equal(run(c,'replacementRecommendations(board,ROLES[0]).length'),0);
 run(c,`liveOurs=[];board[4].champ=null;`);
 const incomplete=run(c,'replacementRecommendations(board,ROLES[0])');
 assert(incomplete.length);assert(incomplete.every(o=>!o.full&&o.delta===null&&o.score===null));
 for(const o of incomplete)close(o.rankScore,run(c,`slotScore(board[0].player,${o.cid},ROLES[0])`));
});

test('Best answers renders the shared ranking with raw matchup data only as supporting evidence',()=>{
 const c=context();setRecordedBoard(c);
 run(c,`draftMode=true;
  enemy=Number(Object.keys(META.champions).find(cid=>!board.some(a=>a.champ===+cid)));
  manualEnemy=new Set([enemy]);enemyRole=new Map([[enemy,'TOP']]);
  counterIdx={[enemy+'|TOP']:Object.fromEntries(D.players[0].champions.map(ch=>[ch.championId,{play:ch.games,win:ch.games-ch.wins}]))};
  candCache={};dAdjCache={};`);
 const expected=run(c,'replacementRecommendations(board,"TOP").slice(0,3).map(a=>a.cid)');
 const rendered=run(c,'answersBlock()');
 const shown=Array.from(rendered.matchAll(/data-answer="0:(\d+)"/g),m=>Number(m[1]));
 assert.deepEqual(shown,Array.from(expected));assert(shown.length>0);
 assert.match(rendered,/observed matchup WR over/);assert.match(rendered,/full composition estimate/);
 run(c,'slots[4].champ=null;');
 assert.match(run(c,'answersBlock()'),/>slot /);
 run(c,'allyLock.set("TOP",slots[0].champ);');
 const locked=run(c,'answersBlock()');
 assert(!locked.includes('data-answer="0:'));assert.match(locked,/Pick locked/);
});

test('relative grade includes current board, checks only unlocked single swaps, and separates evidence',()=>{
 const c=context();setRecordedBoard(c);
 const grade=run(c,'singleSwapComparison(board)');
 const count=run(c,'ROLES.reduce((n,r)=>n+replacementRecommendations(board,r).length,0)');
 assert.equal(grade.checkedAlternatives,count);assert(count>0);
 assert(grade.bestRawTotal>=grade.currentRawTotal);assert.match(grade.scope,/15.*unlocked/);
 assert.equal(grade.evidence.historyComplete,players.history.complete===true);
 assert.equal(grade.evidence.minRoleGames,run(c,'Math.min(...board.map(a=>roleGames(D.players.find(p=>p.riotId===a.player).champions.find(ch=>ch.championId===a.champ),a.role)))'));
 assert(!/Strong score|Higher score|Moderate score|Mixed score|Lower score/.test(grade.label));
 run(c,`draftMode=true;for(const a of board)allyLock.set(a.role,a.champ);`);
 const locked=run(c,'singleSwapComparison(board)');
 assert.equal(locked.label,'All picks locked');assert.equal(locked.checkedAlternatives,0);
 run(c,`allyLock.clear();masteryMin=Number.MAX_SAFE_INTEGER;candCache={};`);
 assert.equal(run(c,'singleSwapComparison(board).status'),'no_alternatives');
});

test('single-swap order and grade retain distinctions when display scores saturate',()=>{
 // A constant offset is a mechanical display-boundary probe. Recorded player
 // outcomes stay unchanged and this altered model is never used as a prediction.
 const c=context(source.replace('rawTotal = ind + syn;','rawTotal = ind + syn + 1;'));
 setRecordedBoard(c);
 run(c,'board=singleSwapComparison(board).alternatives.at(-1).comp;');
 const grade=run(c,'singleSwapComparison(board)');
 assert.equal(run(c,'compScore(board).total'),.95);
 assert(grade.alternatives.every(a=>a.score.total===.95));
 assert.equal(grade.status,'improvement');assert(grade.improvementPoints>0);
 for(let i=1;i<grade.alternatives.length;i++)assert(grade.alternatives[i-1].rankScore>=grade.alternatives[i].rankScore);
});

test('pregame components and shadow variants reconcile with recorded evidence',()=>{
 const c=context();setRecordedBoard(c);
 const record=run(c,'predictionRecord(board,undefined,100)');
 const e=record.evidence,part=record.components,clip=x=>Math.max(.05,Math.min(.95,x));
 const mean=f=>e.reduce((s,x)=>s+f(x),0)/5;
 close(part.personal,mean(x=>(x.effectiveWins+10*x.prior)/(x.effectiveGames+10)));
 close(part.player,mean(x=>(x.playerWins+5)/(x.playerGames+10)));
 close(part.rawTotal,part.personal+part.comfort-part.rolePenalty+part.matchup+part.championSynergy+part.playerSynergy);
 close(record.scores.current,clip(part.rawTotal));
 close(record.scores.noMatchup,clip(part.rawTotal-part.matchup));
 close(record.scores.noRolePenalty,clip(part.rawTotal+part.rolePenalty));
 close(record.scores.noChampionSynergy,clip(part.rawTotal-part.championSynergy));
 close(record.scores.noPlayerSynergy,clip(part.rawTotal-part.playerSynergy));
 close(record.scores.synergyHalf,clip(part.rawTotal-.5*(part.championSynergy+part.playerSynergy)));
 for(const k of [20,40])close(record.scores['priorK'+k],clip(part.rawTotal-part.personal+mean(x=>(x.effectiveWins+k*x.prior)/(x.effectiveGames+k))));
 assert.equal(record.side,100);assert.equal(record.captureStage,'pregame');assert.equal(record.schemaVersion,1);
 assert.equal(record.evaluationCohort.historyComplete,players.history.complete===true);
 assert.equal(run(c,'predictionRecord(board).side'),null);
 assert.throws(()=>run(c,'predictionRecord(board,undefined,300)'),/side/);
 assert(e.every(x=>['role','overall','neutral'].includes(x.priorSource)&&x.effectiveWins<=x.effectiveGames));
 assert(record.alternatives.length>0&&record.alternatives.length<=3);
 for(const alt of record.alternatives){
  assert.equal(alt.comp.filter((a,i)=>a.championId!==record.comp[i].championId).length,1);
  assert(alt.comp.every((a,i)=>a.riotId===record.comp[i].riotId&&a.role===record.comp[i].role));
  close(alt.scores.current,clip(alt.rawTotal));assert(!('outcome'in alt));
 }
 assert.match(record.alternativesNotice,/no observed outcome/);
});

test('fixed squad and roles keep comfort and player synergy constant across champion changes',()=>{
 const c=context();setRecordedBoard(c);
 const values=run(c,`[predictionRecord(board),...singleSwapComparison(board).alternatives.slice(0,10).map(a=>predictionRecord(a.comp))]
  .map(r=>({comfort:r.components.comfort,playerSynergy:r.components.playerSynergy}))`);
 assert(values.length>1);
 for(const v of values){close(v.comfort,values[0].comfort);close(v.playerSynergy,values[0].playerSynergy);}
});

test('capture and grade preserve unknown history coverage separately from true and false',()=>{
 const c=context();setRecordedBoard(c);
 for(const state of ['delete D.history','D.history={}','D.history={complete:"unknown"}',
  'D.history={complete:false}','D.history={complete:true}']){
  run(c,state);
  const expected=state.endsWith('false}')?false:state.endsWith('true}')?true:null;
  const record=run(c,'predictionRecord(board)');
  assert.equal(record.evaluationCohort.historyComplete,expected);
  assert.equal(record.gradeComparison.evidence.historyComplete,expected);
  if(expected!==true)assert.match(record.gradeComparison.evidence.label,/incomplete or unverified/);
 }
});

test('matchup advisory uses residual evidence rather than raw 55 percent alone',()=>{
 const c=context();
 // Mechanically project both sides of real aggregate outcome counts into the
 // counter shape; these are not claims about historical lane matchups.
 const cases=run(c,`D.players.flatMap(p=>p.champions.filter(ch=>ch.games>=20)
  .flatMap(ch=>[ch.wins,ch.games-ch.wins].map(wins=>({cid:ch.championId,games:ch.games,wins}))))`);
 assert(cases.length);
 let flagged=0,unflagged=0;
 for(const row of cases){
  c.counts=row;
  const result=run(c,`(()=>{const cid=counts.cid,enemy=Number(Object.keys(META.champions).find(k=>+k!==cid));
   draftMode=true;manualEnemy=new Set([enemy]);enemyRole=new Map([[enemy,'MIDDLE']]);
   counterIdx={[enemy+'|MID']:{[cid]:{play:counts.games,win:counts.games-counts.wins}}};dAdjCache={};
   const e=matchupEvidence(cid,enemy,'MIDDLE');
   return {e,flag:hardCounters(cid,'MIDDLE').includes(enemy),adjustment:dAdj(cid,'MIDDLE')};})()`);
  assert.equal(result.flag,result.e.upper<result.e.expected&&result.e.residual<0);
  close(result.adjustment,result.e.adjustment);
  assert(result.e.lower<=result.e.observed&&result.e.upper>=result.e.observed);
  if(result.flag)flagged++;else unflagged++;
 }
 assert(flagged>0&&unflagged>0,'Recorded outcome counts must exercise both advisory outcomes');
 // Move only the baseline across the computed interval endpoint to test the
 // exact advisory boundary, without fabricating additional match outcomes.
 run(c,`boundary=matchupEvidence(counts.cid,[...manualEnemy][0],'MIDDLE').upper;
  expectedMatchupWR=()=>boundary+1e-6;`);
 assert.equal(run(c,'hardCounters(counts.cid,"MIDDLE").length'),1);
 run(c,'expectedMatchupWR=()=>boundary-1e-6;');
 assert.equal(run(c,'hardCounters(counts.cid,"MIDDLE").length'),0);
 run(c,`for(const table of Object.values(counterIdx))for(const rec of Object.values(table)){const rate=rec.win/rec.play;rec.play=19;rec.win=rate*19;}dAdjCache={};`);
 assert.equal(run(c,'hardCounters(counts.cid,"MIDDLE").length'),0);
});
test('wider full search retains or improves best found on real five-player squad',()=>{
 const narrow=context(source.replace('const SEARCH_CANDIDATES = 8;','const SEARCH_CANDIDATES = 3;'));
 const wide=context();
 const setup=`for(const [i,p]of D.players.entries())included[p.riotId]=i<5;`;
 run(narrow,setup);run(wide,setup);
 const before=run(narrow,'optimize(1)[0]'),after=run(wide,'optimize(1)[0]');
 assert(after.total>=before.total-1e-12);
 wide.assignment=after.assign;assert(Math.abs(run(wide,'compScore(assignment).total')-after.total)<1e-12);
});
test('full search pruning agrees with exhaustive fixed-role enumeration on real squad',()=>{
 const c=context(source.replace('const SEARCH_CANDIDATES = 8;','const SEARCH_CANDIDATES = 3;'));
 run(c,`for(const [i,p]of D.players.entries())included[p.riotId]=i<5;`);
 const pruned=run(c,'optimize(1)[0].total');
 const exhaustive=run(c,`(()=>{let best=-Infinity;const pool=D.players.slice(0,5).map(p=>p.riotId);
  for(const perm of permutations(pool)){slots=perm.map(player=>({player,champ:null}));
   const r=optimizeChamps(1);if(r?.length)best=Math.max(best,r[0].total);}
  return best;})()`);
 assert(Math.abs(pruned-exhaustive)<1e-12);
});
test('score UI uses points and preserves historical WR',()=>{
 assert(html.includes('<h2>Composition score</h2>'));
 assert(!html.includes('<h2>Estimated win rate</h2>'));
 assert(html.includes('A recommendation heuristic, not a calibrated chance of winning.'));
 assert(html.includes('const pct = x => (x * 100).toFixed(1) + "%";'));
});

// Explicit benchmark mode uses only recorded roster data and real settings.
if(process.env.COMPY_BENCHMARK){
 for(const size of [3,8]){
  const c=context(source.replace('const SEARCH_CANDIDATES = 8;',`const SEARCH_CANDIDATES = ${size};`));
  const start=performance.now(),r=run(c,'optimize(10)');
  console.log(JSON.stringify({players:players.players.length,candidates:size,elapsedMs:Math.round(performance.now()-start),best:r[0]?.total,results:r.length}));
 }
}

test('automatic capture uses real live picks and restores manual exploration state',()=>{
 const c=context();setRecordedBoard(c);
 run(c,`draft={active:true,ts:Date.now(),sessionId:'recorded-roster-protocol-check',
  ours:board.map(p=>({riotId:p.player,position:p.role,championId:p.champ})),
  enemy:Object.keys(META.champions).map(Number).filter(cid=>!board.some(p=>p.champ===cid)).slice(0,5),bans:[]};
  manualBans=new Set([board[0].champ]);manualEnemy=new Set([board[1].champ]);
  allyLock.set(board[0].role,board[1].champ);fearless=true;fearlessChamps=new Set([board[2].champ]);
  original={manualBans,manualEnemy,allyLock,draftMode,dAdjCache,candCache};`);
 const record=run(c,'livePredictionRecord(draft)');
 assert(record);assert.equal(record.automatic.sessionId,'recorded-roster-protocol-check');
 assert.deepEqual(Array.from(record.comp,p=>p.championId),Array.from(run(c,'board.map(p=>p.champ)')));
 assert(run(c,'manualBans===original.manualBans&&manualEnemy===original.manualEnemy&&allyLock===original.allyLock&&draftMode===original.draftMode&&dAdjCache===original.dAdjCache&&candCache===original.candCache'));
 assert.equal(run(c,'livePredictionRecord({...draft,active:false})'),null);
 assert.equal(run(c,'livePredictionRecord({...draft,ts:Date.now()-81000})'),null);
 assert.equal(run(c,'livePredictionRecord({...draft,ours:draft.ours.slice(1)})'),null);
 assert.equal(run(c,'livePredictionRecord({...draft,enemy:draft.enemy.slice(1)})'),null);
});

test('automatic capture retries transport failures and suppresses duplicate uploads',async()=>{
 const c=context();setRecordedBoard(c);
 c.document.querySelector=()=>null;
 run(c,`liveMode=true;draftMode=true;liveDraft={active:true,ts:Date.now(),sessionId:'recorded-roster-transport',
  ours:board.map(p=>({riotId:p.player,position:p.role,championId:p.champ})),
  enemy:Object.keys(META.champions).map(Number).filter(cid=>!board.some(p=>p.champ===cid)).slice(0,5),bans:[]};`);
 const requests=[];
 c.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));if(requests.length===1)throw new Error('transport failed');return {ok:true,json:async()=>({ok:true})};};
 await run(c,'autoCollectLivePrediction()');
 assert.match(run(c,'automaticCaptureStatus'),/pending/);
 await run(c,'autoCollectLivePrediction()');
 await run(c,'autoCollectLivePrediction()');
 assert.equal(requests.length,2);assert.equal(requests[1].automatic.sessionId,'recorded-roster-transport');
 assert.match(run(c,'automaticCaptureStatus'),/saved automatically/);
});
