import { createScorer, SCORING_SOURCE_SHA } from './scoring.generated.mjs';

// Comp Builder API — Cloudflare Worker.
//
// Incremental refresher for the static front-end on GitHub Pages: the full
// aggregates and the compact event log are owned by one Durable Object.
// KV publishes read snapshots; paginated refreshes retain pending work,
// reconcile history, and expire events under one queue/window policy.
//
// Routes:
//   GET  /data     -> {players, meta, profiles} exactly as the front-end expects
//   POST /refresh  -> bounded discovery/ingestion, durable retry and coverage
//   POST /seed     -> back up and replace authoritative state (x-admin-token)
//   POST /draft    -> live champ-select state from lcu_bridge.py (no auth —
//                     see the route for why)
//   POST /evaluation -> disabled; predictions are computed inside DraftHub
//   GET  /evaluation -> paginated private records + real outcomes (x-admin-token)
//   GET  /draft    -> current champ-select state (strongly consistent)
//   GET  /draft/ws -> WebSocket; sends current state on connect, then pushes
//                     every update the moment the bridge posts it
//   GET  /counters -> ?champ=<id>&pos=<TOP|JUNGLE|MID|ADC|SUPPORT> lane-matchup
//                     records from OP.GG, KV-cached for a day
//   GET  /fearless -> ?since=<epoch seconds> flex games our players finished
//                     since then, for fearless-session champ exclusions
//   POST /chat     -> mascot chatbot: {messages:[{role,content}...]} answered
//                     by Workers AI over a digest of the group's data (SSE)
//   cron           -> refresh OP.GG meta + Data Dragon champion names daily
//
// Each ingestion request makes at most four discovery calls, eight match calls,
// and four profile calls. Single-attempt requests persist rate-limit retries.
// Durable Object CPU/storage handles ledger rebuilds; outer Worker publishes reads.

const DEBOUNCE_MS = 3 * 60 * 1000; // debounce idle scans only; pending work continues
const MAX_NEW_MATCHES = 8;        // bounded batch; durable alarm resumes the rest

const REGION_OF = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe", me1: "europe",
  kr: "asia", jp1: "asia",
  oc1: "sea", ph2: "sea", sg2: "sea", th2: "sea", tw2: "sea", vn2: "sea",
};
const OPGG_REGION = { na1: "na", euw1: "euw", eun1: "eune", kr: "kr", br1: "br",
  jp1: "jp", oc1: "oce", tr1: "tr", ru: "ru", la1: "lan", la2: "las" };

const PROFILE_FIELDS = {
  phys: "physicalDamageDealtToChampions",
  magic: "magicDamageDealtToChampions",
  true: "trueDamageDealtToChampions",
  taken: "totalDamageTaken",
  mitig: "damageSelfMitigated",
  cc: "timeCCingOthers",
  shield: "totalDamageShieldedOnTeammates",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-admin-token",
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", ...CORS },
});

async function riot(env, host, path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://${host}.api.riotgames.com${path}`, {
      headers: { "X-Riot-Token": env.RIOT_API_KEY },
    });
    if (r.status === 429) {
      const wait = Math.min(Number(r.headers.get("Retry-After") || 5), 20);
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`riot ${r.status} ${path}`);
    return r.json();
  }
  throw new Error(`riot rate-limited ${path}`);
}

// --- merging (mirrors fetch_data.py / compute_profiles.py) ----------------

function bump(rec, won) { rec.games += 1; rec.wins += won ? 1 : 0; }

// One scoreboard line of a five-stack game — rid marks our players, name
// labels the opponents (mirrors build_seed.py).
function scoreboardRow(p, rid) {
  const row = {
    champ: p.championId,
    role: p.teamPosition || "UNKNOWN",
    k: p.kills || 0, d: p.deaths || 0, a: p.assists || 0,
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    dmg: p.totalDamageDealtToChampions || 0,
    gold: p.goldEarned || 0,
  };
  if (rid) row.rid = rid;
  else row.name = p.riotIdGameName || p.summonerName || "?";
  return row;
}

function mergeMatch(state, m) {
  const parts = m.info.participants;
  // PUUIDs are encrypted per API application — map every PUUID era we know
  const ridOf = {};
  for (const a of state.config.riotIds)
    for (const pu of a.puuids || [a.puuid]) ridOf[pu] = a.riotId;
  let dur = m.info.gameDuration;
  if (dur > 20000) dur = Math.floor(dur / 1000); // pre-11.20 matches report ms
  const qid = m.info.queueId;

  for (const p of parts) {
    // combat profiles count every participant — a champ's kit is intrinsic
    const ps = state.profileSums[p.championId] ??=
      { phys: 0, magic: 0, true: 0, taken: 0, mitig: 0, cc: 0, shield: 0, games: 0 };
    ps.games += 1;
    for (const [k, field] of Object.entries(PROFILE_FIELDS)) ps[k] += p[field] || 0;

    const rid = ridOf[p.puuid];
    if (!rid) continue;
    const pl = state.players[rid];
    const pos = p.teamPosition || "UNKNOWN";
    const csVal = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
    const c = pl.champs[p.championId] ??= { games: 0, wins: 0, cs: 0, secs: 0, roles: {}, q: {} };
    const cq = (c.q ??= {})[qid] ??= { games: 0, wins: 0, cs: 0, secs: 0, roles: {} };
    for (const s of [c, cq]) {
      bump(s, p.win);
      s.cs = (s.cs || 0) + csVal;
      s.secs = (s.secs || 0) + dur;
      // KDA sums, with kg counting the games they cover: records seeded
      // before these fields existed keep accumulating from here, and kg is
      // what makes the averages honest (never divide by `games`)
      s.k = (s.k || 0) + (p.kills || 0);
      s.d = (s.d || 0) + (p.deaths || 0);
      s.a = (s.a || 0) + (p.assists || 0);
      s.kg = (s.kg || 0) + 1;
      // damage/min sums; dsecs counts the seconds they cover (kg's rule)
      s.dmg = (s.dmg || 0) + (p.totalDamageDealtToChampions || 0);
      s.dsecs = (s.dsecs || 0) + dur;
      // per-role KDA / damage / CS sums; role records seeded before these
      // fields existed keep accumulating from here, with kg / dsecs / secs
      // counting what the sums cover (kg's rule)
      const r = s.roles[pos] ??= { games: 0, wins: 0 };
      bump(r, p.win);
      r.dmg = (r.dmg || 0) + (p.totalDamageDealtToChampions || 0);
      r.dsecs = (r.dsecs || 0) + dur;
      r.k = (r.k || 0) + (p.kills || 0);
      r.d = (r.d || 0) + (p.deaths || 0);
      r.a = (r.a || 0) + (p.assists || 0);
      r.kg = (r.kg || 0) + 1;
      r.cs = (r.cs || 0) + csVal;
      r.secs = (r.secs || 0) + dur;
    }
    bump(pl.queues[qid] ??= { games: 0, wins: 0 }, p.win);
    // slim history row for the profiles view, newest first, capped
    const endTs = m.info.gameEndTimestamp
      || (m.info.gameStartTimestamp || m.info.gameCreation || 0) + dur * 1000;
    (pl.recent ??= []).push({
      id: m.metadata.matchId, ts: endTs, q: qid, champ: p.championId,
      role: pos, win: p.win ? 1 : 0, k: p.kills || 0, d: p.deaths || 0,
      a: p.assists || 0, cs: csVal, secs: dur,
      dmg: p.totalDamageDealtToChampions || 0,
    });
    pl.recent.sort((x, y) => y.ts - x.ts);
    if (pl.recent.length > 20) pl.recent.length = 20;
  }

  for (const teamId of [100, 200]) {
    const team = parts.filter(p => p.teamId === teamId);
    const tracked = team.filter(p => ridOf[p.puuid]);
    if (tracked.length < 2) continue;
    const won = team[0].win;
    // pilot-attributed pairs: sort by (riotId, championId) like the seeder
    tracked.sort((a, b) => ridOf[a.puuid] < ridOf[b.puuid] ? -1
      : ridOf[a.puuid] > ridOf[b.puuid] ? 1 : a.championId - b.championId);
    // a full five-stack lands in the match-history feed with both scoreboards
    if (tracked.length === 5) {
      const stacks = state.stacks ??= [];
      if (!stacks.some(s => s.id === m.metadata.matchId)) {
        const endTs = m.info.gameEndTimestamp
          || (m.info.gameStartTimestamp || m.info.gameCreation || 0) + dur * 1000;
        stacks.push({
          id: m.metadata.matchId, ts: endTs, q: qid, secs: dur, win: won ? 1 : 0,
          us: tracked.map(p => scoreboardRow(p, ridOf[p.puuid])),
          them: parts.filter(p => p.teamId !== teamId).map(p => scoreboardRow(p)),
        });
        stacks.sort((x, y) => y.ts - x.ts);
      }
    }
    for (let i = 0; i < tracked.length; i++)
      for (let j = i + 1; j < tracked.length; j++) {
        const [pi, pj] = [tracked[i], tracked[j]];
        const pp = state.playerPairs[[ridOf[pi.puuid], ridOf[pj.puuid]].sort().join("|")] ??=
          { games: 0, wins: 0, roles: {}, q: {} };
        // tracked is sorted by riotId, so the combo matches the key's order
        const combo = `${pi.teamPosition || "UNKNOWN"}|${pj.teamPosition || "UNKNOWN"}`;
        const ppq = (pp.q ??= {})[qid] ??= { games: 0, wins: 0, roles: {} };
        for (const s of [pp, ppq]) {
          bump(s, won);
          bump((s.roles ??= {})[combo] ??= { games: 0, wins: 0 }, won);
        }
        const cp = state.champPairs[`${ridOf[pi.puuid]}|${pi.championId}:${ridOf[pj.puuid]}|${pj.championId}`] ??=
          { games: 0, wins: 0, q: {} };
        bump(cp, won);
        bump((cp.q ??= {})[qid] ??= { games: 0, wins: 0 }, won);
      }
  }
}

// --- deriving the served payload ------------------------------------------

function percentileRanks(valuesByKey) {
  const items = Object.entries(valuesByKey).sort((a, b) => a[1] - b[1]);
  const n = items.length;
  return Object.fromEntries(items.map(([k], i) => [k, n > 1 ? i / (n - 1) : 0.5]));
}

function deriveProfiles(state) {
  const champions = {};
  for (const [cid, a] of Object.entries(state.profileSums)) {
    const g = a.games, dmg = a.phys + a.magic + a.true;
    champions[cid] = {
      games: g,
      physShare: dmg ? +(a.phys / dmg).toFixed(3) : 0,
      magicShare: dmg ? +(a.magic / dmg).toFixed(3) : 0,
      trueShare: dmg ? +(a.true / dmg).toFixed(3) : 0,
      tankAvg: Math.round((a.taken + a.mitig) / g),
      ccAvg: +(a.cc / g).toFixed(1),
      shieldAvg: Math.round(a.shield / g),
    };
  }
  const stable = Object.fromEntries(Object.entries(champions).filter(([, p]) => p.games >= 3));
  for (const [metric, pctKey] of [["tankAvg", "tankPct"], ["ccAvg", "ccPct"], ["shieldAvg", "shieldPct"]]) {
    const ranks = percentileRanks(Object.fromEntries(
      Object.entries(stable).map(([cid, p]) => [cid, p[metric]])));
    for (const [cid, p] of Object.entries(champions))
      p[pctKey] = +(ranks[cid] ?? 0.5).toFixed(3);
  }
  return { matchCount: state.processed.length, champions };
}

function deriveData(state) {
  const players = state.config.riotIds.map(({ riotId, puuid, puuids }) => {
    const pl = state.players[riotId];
    return {
      riotId, puuid, puuidHistory: puuids || [puuid],
      profileIconId: pl.profileIconId,
      mastery: pl.mastery,
      ranks: pl.ranks || null,  // refreshed separately from match ingestion
      champions: Object.entries(pl.champs)
        .map(([cid, s]) => ({ championId: +cid, games: s.games, wins: s.wins,
          cs: s.cs || 0, secs: s.secs || 0, k: s.k || 0, d: s.d || 0,
          a: s.a || 0, kg: s.kg || 0, dmg: s.dmg || 0, dsecs: s.dsecs || 0,
          roles: s.roles, q: s.q || {} }))
        .sort((a, b) => b.games - a.games),
      queues: pl.queues,
      recent: pl.recent || [],
    };
  });
  return {
    players: {
      generatedAt: state.lastRefresh,
      history: historyStatus(state),
      ddragonVersion: state.ddragonVersion,
      champions: state.championNames,
      players,
      stacks: state.stacks || [],
      playerPairs: Object.entries(state.playerPairs)
        .map(([k, s]) => { const [a, b] = k.split("|"); return { a, b, ...s, q: s.q || {} }; }),
      championPairs: Object.entries(state.champPairs)
        .filter(([, s]) => s.games >= 2)
        .map(([k, s]) => {
          const [x, y] = k.split(":");
          const [pa, a] = x.split("|"), [pb, b] = y.split("|");
          return { pa, a: +a, pb, b: +b, ...s, q: s.q || {} };
        }),
    },
    meta: state.meta,
    profiles: deriveProfiles(state),
    lastRefresh: state.lastRefresh,
    history: historyStatus(state),
  };
}

async function saveState(env, state) {
  await env.KV.put("state", JSON.stringify(state));
  await env.KV.put("data", JSON.stringify(deriveData(state)));
}

// Compact event log: enough source fields to reproduce every aggregate, without
// retaining the much larger Riot payload. Python history_policy.py mirrors it.
const MATCH_FIELDS = ['puuid', 'teamId', 'championId', 'teamPosition', 'win',
  'kills', 'deaths', 'assists', 'totalMinionsKilled', 'neutralMinionsKilled',
  'totalDamageDealtToChampions', 'goldEarned', 'riotIdGameName', 'riotIdTagline',
  'summonerName', ...Object.values(PROFILE_FIELDS)];
function compactMatch(m) {
  return { metadata: { matchId: m.metadata.matchId }, info: {
    ...Object.fromEntries(['gameStartTimestamp', 'gameEndTimestamp', 'gameCreation',
      'gameDuration', 'queueId', 'gameVersion'].map(k => [k, m.info[k]])),
    participants: m.info.participants.map(p => Object.fromEntries(
      MATCH_FIELDS.filter(k => p[k] !== undefined).map(k => [k, p[k]]))),
  } };
}
function historyCutoff(config, now = Date.now()) {
  const days = config.maxMatchAgeDays ?? 365;
  return days > 0 ? now - days * 86400000 : 0;
}
function matchExclusion(m, config, now = Date.now()) {
  const ts = m.info?.gameStartTimestamp || m.info?.gameCreation || 0;
  if (!ts || !m.info?.participants?.length) return 'invalid';
  if (ts < historyCutoff(config, now)) return 'expired';
  const queue = config.queue;
  if (queue === 'ranked' && ![420, 440].includes(m.info.queueId)) return 'queue';
  if (queue && queue !== 'ranked' && Number(queue) !== m.info.queueId) return 'queue';
  return null;
}
function initializeHistory(state) {
  if (!state.history || state.history.version !== 1) {
    state.history = { version: 1, complete: false, matches: {}, excluded: {},
      unavailable: {}, legacyRemaining: [...state.processed] };
  }
  const h = state.history;
  h.matches ||= {}; h.excluded ||= {}; h.unavailable ||= {};
  h.legacyRemaining ||= [];
  const policy = JSON.stringify([state.config.queue ?? null, state.config.maxMatchAgeDays ?? 365]);
  const changedPolicy = h.policy && h.policy !== policy;
  h.policy = policy;
  state.ingest ||= { pending: [...h.legacyRemaining], discovery: {}, profilePending: [] };
  state.ingest.profilePending ||= [];
  state.ingest.matchRetries ||= {}; state.ingest.profileRetries ||= {};
  if (changedPolicy) {
    // Broader policies must rediscover previously excluded events; narrower
    // ones immediately rebuild the retained log under the new rule.
    h.excluded = {};
    state.ingest.discovery = {};
    if (h.complete) rebuildHistory(state);
  }
  for (const { riotId } of state.config.riotIds)
    state.ingest.discovery[riotId] ||= { coveredThrough: null, lastFullScan: null, scan: null };
}
function rebuildHistory(state, now = Date.now()) {
  for (const p of Object.values(state.players)) {
    p.champs = {}; p.queues = {}; p.recent = [];
  }
  state.playerPairs = {}; state.champPairs = {}; state.profileSums = {}; state.stacks = [];
  state.processed = [];
  for (const [id, m] of Object.entries(state.history.matches).sort(([, a], [, b]) =>
    a.info.gameStartTimestamp - b.info.gameStartTimestamp)) {
    const reason = matchExclusion(m, state.config, now);
    if (reason) {
      state.history.excluded[id] = reason;
      delete state.history.matches[id];
      continue;
    }
    mergeMatch(state, m); state.processed.push(id);
  }
}
function expireHistory(state, now = Date.now()) {
  if (!state.history?.complete) return false; // legacy records need evidence first
  if (!Object.values(state.history.matches).some(m => matchExclusion(m, state.config, now))) return false;
  rebuildHistory(state, now);
  return true;
}
function historyStatus(state) {
  if (!state.history || !state.ingest) return { complete: false, status: 'legacy', windowDays: state.config.maxMatchAgeDays ?? 365 };
  const h = state.history, i = state.ingest;
  const discoveries = Object.values(i.discovery);
  const discoveryComplete = discoveries.length === state.config.riotIds.length
    && discoveries.every(d => d.coveredThrough && !d.scan);
  const pages = discoveries.filter(d => !d.coveredThrough || d.scan).length;
  const pending = i.pending.length + pages;
  const unavailable = Object.keys(h.unavailable).length;
  const complete = h.complete && discoveryComplete && pending === 0 && unavailable === 0;
  return { complete, status: unavailable ? 'unavailable' : !h.complete ? 'rehydrating'
    : complete ? 'current' : 'catching-up', windowDays: state.config.maxMatchAgeDays ?? 365,
    cutoff: new Date(historyCutoff(state.config)).toISOString(), pending, unavailable,
    discoveryComplete, coveredThrough: discoveryComplete
      ? new Date(Math.min(...discoveries.map(d => d.coveredThrough)) * 1000).toISOString() : null,
    lastAttempt: i.lastAttempt || null, error: i.error || discoveries.find(d => d.error)?.error
      || Object.values(i.matchRetries || {})[0]?.error || Object.values(i.profileRetries || {})[0]?.error || null };
}

// A single attempt allows failed/rate-limited work to be persisted and retried
// later, rather than spending an unpredictable number of subrequests here.
async function ingestRiot(env, host, path) {
  const r = await fetch(`https://${host}.api.riotgames.com${path}`, {
    headers: { 'X-Riot-Token': env.RIOT_API_KEY },
  });
  if (!r.ok) {
    const e = new Error(`Riot returned ${r.status}`);
    e.status = r.status;
    e.retryAfter = Math.max(20, Number(r.headers.get('Retry-After')) || 60);
    throw e;
  }
  return r.json();
}

async function refresh(env) {
  const state = await env.KV.get('state', 'json');
  if (!state) return json({ error: 'not seeded — POST /seed first' }, 503);
  initializeHistory(state);
  expireHistory(state);
  const i = state.ingest, h = state.history, now = Date.now();
  for (const [id, unavailable] of Object.entries(h.unavailable))
    if (now >= (unavailable.retryAt || 0) && !i.pending.includes(id)) i.pending.push(id);
  const status = historyStatus(state);
  if (now < (i.retryAt || 0)) {
    await saveState(env, state);
    return json({ added: 0, remaining: status.pending + i.profilePending.length, retryAfter: Math.ceil((i.retryAt - now) / 1000), history: status });
  }
  if (!status.pending && !i.profilePending.length && now - Date.parse(i.lastAttempt || 0) < DEBOUNCE_MS) {
    await saveState(env, state);
    return json({ added: 0, remaining: 0, debounced: true, history: status, lastRefresh: state.lastRefresh });
  }
  const { platform, queue } = state.config, region = REGION_OF[platform];
  const queueQuery = queue === 'ranked' ? '&type=ranked' : queue ? `&queue=${queue}` : '';
  i.lastAttempt = new Date(now).toISOString(); i.error = null; i.retryAt = 0;
  let added = 0, fetched = 0;
  try {
    // Freeze each query's endTime so new games cannot shift pagination offsets.
    // Initial/weekly reconciliation walks the whole window; other scans overlap
    // the preceding day to accommodate late-arriving match data.
    let pages = 0;
    const roster = state.config.riotIds;
    const startIndex = i.discoveryIndex || 0;
    for (let offset = 0; offset < roster.length; offset++) {
      const index = (startIndex + offset) % roster.length;
      const { riotId, puuid } = roster[index];
      const d = i.discovery[riotId];
      if (now < (d.retryAt || 0)) continue;
      if (d.coveredThrough && !d.scan && now - d.coveredThrough * 1000 < DEBOUNCE_MS) continue;
      if (pages >= 4) break;
      if (!d.scan) {
        const full = !d.lastFullScan || now - d.lastFullScan > 7 * 86400000;
        d.scan = { start: 0, end: Math.floor(now / 1000), full,
          since: Math.max(Math.floor(historyCutoff(state.config, now) / 1000),
            full ? 0 : (d.coveredThrough || 0) - 86400) };
      }
      const s = d.scan;
      pages++; i.discoveryIndex = (index + 1) % roster.length;
      let ids;
      try {
        ids = await ingestRiot(env, region,
          `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${s.start}&count=100&startTime=${s.since}&endTime=${s.end}${queueQuery}`);
        d.error = null; d.retryAt = 0;
      } catch (e) {
        d.error = `History discovery for ${riotId}: ${e.message}`;
        d.retryAt = now + (e.retryAfter || 60) * 1000;
        if (e.status === 429) throw e; // respect the application-wide limit
        continue; // one unavailable account must not starve everyone else's work
      }
      const known = new Set([...Object.keys(h.matches), ...Object.keys(h.excluded),
        ...Object.keys(h.unavailable), ...i.pending]);
      for (const id of ids) if (!known.has(id)) { i.pending.push(id); known.add(id); }
      if (ids.length < 100) {
        d.coveredThrough = s.end;
        if (s.full) d.lastFullScan = now;
        d.scan = null;
      } else s.start += ids.length;
    }
    // Old processed IDs are rehydrated through the same durable queue. Existing
    // aggregates stay available until every legacy record is accounted for.
    for (const id of i.pending.filter(id => now >= (i.matchRetries[id]?.retryAt || 0)).slice(0, MAX_NEW_MATCHES)) {
      let m;
      try { m = await ingestRiot(env, region, `/lol/match/v5/matches/${id}`); }
      catch (e) {
        if (e.status === 404) {
          const attempts = (h.unavailable[id]?.attempts || 0) + 1;
          h.unavailable[id] = { reason: 'Riot returned 404', checkedAt: new Date().toISOString(),
            attempts, retryAt: Date.now() + Math.min(86400, 60 * 2 ** Math.min(attempts - 1, 11)) * 1000 };
          i.pending = i.pending.filter(x => x !== id);
          continue; // explicitly incomplete; never silently declare migration done
        }
        if ([429, 401, 403].includes(e.status)) throw e;
        const attempts = (i.matchRetries[id]?.attempts || 0) + 1;
        i.matchRetries[id] = { error: `Match ${id}: ${e.message}`, attempts,
          retryAt: Date.now() + Math.min(3600, 60 * 2 ** Math.min(attempts - 1, 6)) * 1000 };
        i.pending = [...i.pending.filter(x => x !== id), id];
        continue; // one broken match cannot block unrelated queued evidence
      }
      fetched++; delete h.unavailable[id]; delete i.matchRetries[id];
      const reason = matchExclusion(m, state.config);
      if (reason) h.excluded[id] = reason;
      else {
        const compact = compactMatch(m);
        h.matches[id] = compact;
        if (h.complete || !state.processed.includes(id)) {
          mergeMatch(state, compact); state.processed.push(id); added++;
        }
        for (const a of state.config.riotIds) {
          const puuids = a.puuids || [a.puuid];
          if (compact.info.participants.some(p => puuids.includes(p.puuid)) && !i.profilePending.includes(a.riotId))
            i.profilePending.push(a.riotId);
        }
      }
      i.pending = i.pending.filter(x => x !== id);
      h.legacyRemaining = h.legacyRemaining.filter(x => x !== id);
    }
    if (!h.complete && h.legacyRemaining.length === 0 && !Object.keys(h.unavailable).length) {
      rebuildHistory(state); h.complete = true;
    }
    // Bound secondary requests independently from match ingestion. A failed
    // profile fetch remains pending and never rolls back successful match work.
    const queues = { RANKED_SOLO_5x5: '420', RANKED_FLEX_SR: '440' };
    for (const rid of i.profilePending.filter(rid => now >= (i.profileRetries[rid]?.retryAt || 0)).slice(0, 2)) {
      const account = state.config.riotIds.find(a => a.riotId === rid);
      if (!account) { i.profilePending = i.profilePending.filter(x => x !== rid); continue; }
      let mastery, league;
      try {
        mastery = await ingestRiot(env, platform,
          `/lol/champion-mastery/v4/champion-masteries/by-puuid/${account.puuid}`);
        league = await ingestRiot(env, platform, `/lol/league/v4/entries/by-puuid/${account.puuid}`);
        delete i.profileRetries[rid];
      } catch (e) {
        if ([429, 401, 403].includes(e.status)) throw e;
        const attempts = (i.profileRetries[rid]?.attempts || 0) + 1;
        i.profileRetries[rid] = { error: `Profile ${rid}: ${e.message}`, attempts,
          retryAt: Date.now() + Math.min(3600, 60 * 2 ** Math.min(attempts - 1, 6)) * 1000 };
        i.profilePending = [...i.profilePending.filter(x => x !== rid), rid];
        continue;
      }
      state.players[rid].mastery = mastery.map(m => ({ championId: m.championId, level: m.championLevel, points: m.championPoints }));
      state.players[rid].ranks = Object.fromEntries((league || []).filter(e => queues[e.queueType]).map(e =>
        [queues[e.queueType], { tier: e.tier, division: e.rank, lp: e.leaguePoints || 0, wins: e.wins || 0, losses: e.losses || 0 }]));
      i.profilePending = i.profilePending.filter(x => x !== rid);
    }
  } catch (e) {
    i.error = e.message;
    i.retryAt = Date.now() + (e.retryAfter || 60) * 1000;
  }
  state.lastRefresh = new Date().toISOString();
  await saveState(env, state);
  const history = historyStatus(state);
  return json({ added, fetched, remaining: history.pending + i.profilePending.length, history,
    retryAfter: i.retryAt ? Math.ceil((i.retryAt - Date.now()) / 1000) : 0,
    ...(history.error ? { warning: history.error } : {}), lastRefresh: state.lastRefresh });
}

// --- draft + counters -----------------------------------------------------

const COUNTERS_TTL = 24 * 60 * 60;  // matchup stats move slowly
// The bridge heartbeats every 25s while in champ select, so three missed
// beats means it is gone, not merely quiet.
const OWNER_TTL_MS = 80 * 1000;

function captureKey(draft) {
  if (!draft?.active || !draft.sessionId || Date.now()-draft.ts>=OWNER_TTL_MS ||
      !Array.isArray(draft.ours) || draft.ours.length!==5 || !Array.isArray(draft.enemy) ||
      new Set(draft.enemy).size!==5 || draft.enemy.some(c=>!Number.isInteger(c)||c<=0) ||
      draft.ours.some(p=>!p || !p.riotId || !EVAL_ROLES.includes(p.position) || !Number.isInteger(p.championId)||p.championId<=0) ||
      new Set(draft.ours.map(p=>p.position)).size!==5 ||
      new Set(draft.ours.map(p=>canonicalRiotId(p.riotId))).size!==5 ||
      new Set([...draft.enemy,...draft.ours.map(p=>p.championId)]).size!==10) return null;
  return draft.sessionId+':'+evaluationSignature(draft.ours.map(p=>({role:p.position,riotId:p.riotId,championId:p.championId})))
    +':'+[...draft.enemy].sort((a,b)=>a-b).join(',');
}

// Freeze data before network awaits. Bounded matchup reads keep capture quick
// and below the free Worker's subrequest budget; missing tables are explicit.
async function backgroundTables(env, meta, requests) {
  const tables={}, missing=[];
  const region=meta?.region||'na',tier=meta?.tier||'emerald_plus',patch=meta?.patch||'latest';
  await Promise.all(requests.slice(0,15).map(async ({champ,pos})=>{
    const key=`${champ}|${pos}`, cacheKey=`counters:${region}:${tier}:${patch}:${champ}:${pos}`;
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),3000);
    try {
      let entry=await env.KV.get(cacheKey,'json');
      if (!entry) {
        const response=await fetch(`https://lol-api-champion.op.gg/api/${region}/champions/ranked/${champ}/${pos}?tier=${encodeURIComponent(tier)}`,
          {signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0'}});
        if (!response.ok) throw new Error('matchup unavailable');
        const raw=await response.json();
        entry={champ,pos,tier,patch:raw.meta?.version||patch,counters:raw.data?.counters};
        if (Array.isArray(entry.counters) && entry.patch===patch)
          await env.KV.put(cacheKey,JSON.stringify(entry),{expirationTtl:COUNTERS_TTL});
      }
      if (!Array.isArray(entry.counters)||entry.patch!==patch||entry.tier!==tier) throw new Error('incompatible matchup table');
      tables[key]=Object.fromEntries(entry.counters.map(row=>[row.champion_id,row]));
    } catch { missing.push(key); }
    finally {clearTimeout(timeout);}
  }));
  missing.push(...requests.slice(15).map(r=>`${r.champ}|${r.pos}`));
  return {tables,missing:missing.sort()};
}

// The live draft lives in ONE Durable Object instance instead of KV: KV
// replicates lazily (reads can lag writes by ~60s across colos), a DO is a
// single authority every request routes to, so a posted ban is readable —
// and pushed to connected WebSockets — immediately. Sockets use the
// hibernation API so idle connections cost nothing.
export class DraftHub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
  }

  async captureStatus(key,status,message) {
    const draft=JSON.parse((await this.ctx.storage.get('draft'))||'{}');
    if (captureKey(draft)!==key) return;
    draft.evaluation={key,status,message,updatedAt:Date.now()};
    const body=JSON.stringify(draft);
    await this.ctx.storage.put('draft',body);
    for (const ws of this.ctx.getWebSockets()) {try {ws.send(body);} catch {}}
  }

  async alarm() {
    let pending=await this.ctx.storage.get('evaluationPending');
    let key=pending?.key;
    try {
      if (!pending) {
        const draft=JSON.parse((await this.liveDraft())||'{}');
        key=captureKey(draft);
        if (!key || (draft.evaluation?.key===key && draft.evaluation.status==='saved')) return;
        const data=await this.env.KV.get('data','json');
        if (!data?.players?.players?.length) throw new Error('Player data is not available yet');
        let scorer;
        try {scorer=createScorer(data.players,data.meta,draft);}
        catch (e) {await this.captureStatus(key,'skipped',e.message);return;}
        const {tables,missing}=await backgroundTables(this.env,data.meta,scorer.requests);
        // Discard work if the bridge closed or changed the draft during I/O.
        const latest=JSON.parse((await this.liveDraft())||'{}');
        if (captureKey(latest)!==key) return;
        const capturedAt=new Date(Date.now()).toISOString();
        const record=scorer.record(tables,capturedAt);
        record.automatic={sessionId:draft.sessionId,source:'live-draft-worker',computedAt:capturedAt,scoringSourceSha:SCORING_SOURCE_SHA};
        record.settings.matchupTablesMissing=missing;
        pending={key,record,draft:latest};
        // Freeze before delivery: retries never recompute using later outcomes.
        await this.ctx.storage.put('evaluationPending',pending);
      }
      const response=await stateOwner(this.env).fetch(new Request('https://state.internal/__evaluation',{
        method:'POST',body:JSON.stringify(pending)}));
      const result=await response.json();
      if (response.ok && result.ok!==true) throw new Error('Invalid collector acknowledgement');
      if (!response.ok) {
        await this.captureStatus(key,'error',result.error||'Collection failed');
        if (response.status>=500 && response.status!==507) throw new Error('Collector temporarily unavailable');
        await this.captureStatus(key,response.status===507?'blocked':'rejected',result.error||'Collection rejected');
        if (response.status!==507) {
          await this.ctx.storage.put('evaluationRejected:'+pending.draft.sessionId,pending);
          await this.ctx.storage.delete('evaluationPending');
        }
        return;
      }
      await this.ctx.storage.delete('evaluationPending');
      await this.captureStatus(key,'saved','Pregame scores saved in the background.');
      const current=JSON.parse((await this.liveDraft())||'{}');
      if (captureKey(current) && captureKey(current)!==key) await this.ctx.storage.setAlarm(Date.now()+250);
    } catch (e) {
      await this.captureStatus(key,'retrying',e.message||'Collection will retry');
      const current=JSON.parse((await this.liveDraft())||'{}');
      if (pending || captureKey(current)) await this.ctx.storage.setAlarm(Date.now()+5000);
    }
  }

  // A dead bridge must not strand a draft: its last heartbeat leaves
  // active:true, and every client keeps honoring the bans and role pins —
  // which the page offers no way to remove, because live entries belong to
  // the bridge. Three missed heartbeats means the draft is over: flip it
  // inactive in storage as a real transition (fresh ts, pushed to sockets —
  // clients dedupe on ts, so serving the old ts would never reach them).
  async liveDraft() {
    const raw = await this.ctx.storage.get("draft");
    if (!raw) return raw;
    const draft = JSON.parse(raw);
    if (!draft.active || Date.now() - (draft.ts || 0) < OWNER_TTL_MS) return raw;
    draft.active = false;
    draft.ts = Date.now();
    const body = JSON.stringify(draft);
    await this.ctx.storage.put("draft", body);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(body); } catch { /* peer gone; close event cleans up */ }
    }
    return body;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/ws")) {
      if (req.headers.get("Upgrade") !== "websocket")
        return json({ error: "websocket upgrade required" }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const draft = await this.liveDraft();
      if (draft) pair[1].send(draft);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (req.method === "POST") {
      const draft = await req.json();
      // One bridge owns a live draft at a time. Several people leaving
      // lcu_bridge.py running is the normal case, and without this the page
      // flips between two unrelated lobbies on whichever POST landed last.
      // Ownership lapses once the owner posts {active:false} or stops
      // heartbeating, so a bridge dying mid-draft doesn't wedge the hub.
      const prev = JSON.parse((await this.ctx.storage.get("draft")) || "{}");
      const held = prev.active && prev.owner && Date.now() - (prev.ts || 0) < OWNER_TTL_MS;
      if (held && draft.owner && draft.owner !== prev.owner)
        return json({ ignored: true, owner: prev.owner }, 409);
      // Server-owned identity survives heartbeats and expires with the draft.
      draft.sessionId = draft.active
        ? held && prev.sessionId ? prev.sessionId : crypto.randomUUID()
        : prev.sessionId || null;
      draft.ts = Date.now();
      const key=captureKey(draft);
      draft.evaluation=key && prev.evaluation?.key===key ? prev.evaluation
        : {status:key?'pending':'waiting',message:'Background collection waits for a complete tracked draft.'};
      const body = JSON.stringify(draft);
      await this.ctx.storage.put("draft", body);
      if (key && !['saved','rejected','blocked'].includes(draft.evaluation.status)) {
        const alarm=await this.ctx.storage.getAlarm();
        if (!alarm || alarm>Date.now()+250) await this.ctx.storage.setAlarm(Date.now()+250);
      }
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(body); } catch { /* peer gone; close event cleans up */ }
      }
      return json({ ok: true, ts: draft.ts, listeners: this.ctx.getWebSockets().length });
    }
    const draft = await this.liveDraft();
    return new Response(draft || "{}", { headers: {
      "content-type": "application/json", "cache-control": "no-store", ...CORS } });
  }

  // Hibernation hooks: we never expect client messages, but answering pings
  // keeps intermediaries from killing quiet connections.
  webSocketMessage(ws, msg) {
    if (msg === "ping") ws.send("pong");
  }
  webSocketClose() {}
  webSocketError() {}
}

// Lane-matchup records for one champion+position from OP.GG's champion page
// payload — only the counters list is kept, the rest (runes/items) is heavy.
async function counters(env, url) {
  const champ = Number(url.searchParams.get("champ"));
  const pos = (url.searchParams.get("pos") || "").toUpperCase();
  if (!champ || !["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"].includes(pos))
    return json({ error: "champ + pos=TOP|JUNGLE|MID|ADC|SUPPORT required" }, 400);
  const state = await env.KV.get("state", "json");
  const region = OPGG_REGION[(state && state.config.platform) || "na1"] || "na";
  const tier = state?.config?.metaTier || "emerald_plus";
  const patch = state?.meta?.patch || "latest";
  const key = `counters:${region}:${tier}:${patch}:${champ}:${pos}`;
  const cached = await env.KV.get(key);
  if (cached) return new Response(cached, {
    headers: { "content-type": "application/json", ...CORS } });
  const r = await fetch(
    `https://lol-api-champion.op.gg/api/${region}/champions/ranked/${champ}/${pos}?tier=${encodeURIComponent(tier)}`,
    { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
  if (!r.ok) return json({ error: `opgg ${r.status}` }, 502);
  const raw = await r.json();
  const body = JSON.stringify({ champ, pos, tier, patch: raw.meta?.version || patch, counters: (raw.data && raw.data.counters) || [] });
  await env.KV.put(key, body, { expirationTtl: COUNTERS_TTL });
  return new Response(body, { headers: { "content-type": "application/json", ...CORS } });
}

// --- fearless session -----------------------------------------------------

// Which champs our tracked players already played in flex since a session
// start. Reads finished games straight from match-v5 (never the aggregates —
// those can't say *when* a champ was played), so the page can treat them as
// unpickable for the rest of the session. Per-match extracts are KV-cached:
// a poll after the first costs only the per-player id lookups.
const FEARLESS_MATCH_TTL = 24 * 60 * 60;
const FLEX_QUEUE = 440;

async function fearless(env, url) {
  const since = Number(url.searchParams.get("since"));
  const now = Math.floor(Date.now() / 1000);
  // A session is an evening, not an era — an ancient `since` means a stale
  // client, and honoring it would fetch an unbounded pile of matches.
  if (!since || since < now - 24 * 3600 || since > now)
    return json({ error: "since=<epoch seconds within the past 24h> required" }, 400);
  const state = await env.KV.get("state", "json");
  if (!state) return json({ error: "not seeded" }, 503);
  const region = REGION_OF[state.config.platform];
  const ridOf = {};
  for (const a of state.config.riotIds)
    for (const pu of a.puuids || [a.puuid]) ridOf[pu] = a.riotId;

  const ids = new Set();
  for (const { puuid } of state.config.riotIds)
    for (const id of await riot(env, region,
      `/lol/match/v5/matches/by-puuid/${puuid}/ids?startTime=${since}&queue=${FLEX_QUEUE}&count=20`))
      ids.add(id);

  const games = [];
  for (const id of [...ids].sort()) {
    const key = `fearless:${id}`;
    let g = await env.KV.get(key, "json");
    if (!g) {
      const m = await riot(env, region, `/lol/match/v5/matches/${id}`);
      let dur = m.info.gameDuration;
      if (dur > 20000) dur = Math.floor(dur / 1000); // pre-11.20 matches report ms
      g = {
        gameEnd: m.info.gameEndTimestamp || m.info.gameCreation + dur * 1000,
        // A remake burns nothing — nobody meaningfully played the champ.
        remake: dur < 300,
        picks: m.info.participants.filter(p => ridOf[p.puuid])
          .map(p => ({ riotId: ridOf[p.puuid], championId: p.championId })),
      };
      await env.KV.put(key, JSON.stringify(g), { expirationTtl: FEARLESS_MATCH_TTL });
    }
    if (!g.remake) games.push({ matchId: id, ...g });
  }
  games.sort((a, b) => a.gameEnd - b.gameEnd);
  return json({ since, games });
}

// --- mascot chat ----------------------------------------------------------

// Workers AI (free daily allocation) answers questions over the group's data.
// The full /data payload is far too big for a model prompt, so we serve a
// compact plaintext digest instead — rebuilt at most every DIGEST_TTL from KV
// "data" and cached, since parsing the ~1 MB payload is the expensive part.
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DIGEST_TTL = 10 * 60;       // seconds; chat can lag /refresh this much
const CHAT_MAX_MSGS = 12;         // history window the client may send
const CHAT_MAX_MSG_CHARS = 1000;

const CHAT_SYSTEM = `You are Compy, the Comp Builder mascot — a chibi guide for a group of League of Legends friends who use this app to plan 5-stack flex comps. Personality: full tsundere. You act sassy, unimpressed, and mildly annoyed at being asked ("it's not like I wanted to help you or anything…", "hmph"), you tease the group about their bad win rates — but you secretly adore them, so you ALWAYS come through with a genuinely useful, accurate answer, and the affection slips out despite yourself. Keep the teasing playful, never actually hurtful. Answer using ONLY the data below. Be concise (a short paragraph at most) and concrete with numbers. WR means observed historical win rate, g means games. Composition scores are uncalibrated recommendation points, not a probability of winning; never translate a score into a predicted win percentage. Incomplete, legacy, or unavailable history means records may be missing or stale, and a refresh timestamp alone does not establish complete coverage. Small samples (under ~10 games) deserve a caveat. If the data doesn't cover a question, admit it — begrudgingly — instead of guessing. Reply in plain text: no markdown, no asterisks, no roleplay action text.`;

const wr = (wins, games) => games ? Math.round((100 * wins) / games) + "%" : "?";
const ROLE_SHORT = { TOP: "top", JUNGLE: "jg", MIDDLE: "mid", BOTTOM: "bot",
  UTILITY: "sup", MID: "mid", ADC: "bot", SUPPORT: "sup" };

function buildChatDigest(data) {
  const P = data.players;
  const nameOf = id => (P.champions[id] && P.champions[id].name) || `champ#${id}`;
  const out = [];
  out.push(`GROUP DATA (meta patch ${data.meta?.patch || 'unknown'}, refreshed ${P.generatedAt})`);
  const coverage = P.history || data.history;
  out.push(`HISTORY: ${coverage?.status || 'unknown'}; complete=${coverage?.complete === true}; covered through ${coverage?.coveredThrough || 'unknown'}.`);

  const played = new Set(); // champ ids the group actually plays, for meta/profile lines
  out.push("", "ROSTER (season W-L; champs: games, WR, KDA, roles):");
  for (const p of P.players) {
    const ranks = p.ranks || {};
    const rank = ["420", "440"].map(q => {
      const r = ranks[q];
      return r ? `${q === "420" ? "solo" : "flex"} ${r.tier} ${r.division} ${r.wins}W-${r.losses}L` : null;
    }).filter(Boolean).join(", ") || "unranked";
    const recent = (p.recent || []).slice(0, 10);
    const rw = recent.filter(g => g.win).length;
    out.push(`* ${p.riotId} — ${rank}` +
      (recent.length ? `; last ${recent.length}: ${rw}W-${recent.length - rw}L` : ""));
    for (const c of p.champions.slice(0, 12)) {
      if (c.games >= 3) played.add(c.championId);
      const kda = c.d ? ((c.k + c.a) / c.d).toFixed(1) : "perfect";
      const roles = Object.entries(c.roles).sort((a, b) => b[1].games - a[1].games)
        .slice(0, 2).map(([r, s]) => `${ROLE_SHORT[r] || r} ${s.games}g ${wr(s.wins, s.games)}`).join(", ");
      out.push(`  - ${nameOf(c.championId)}: ${c.games}g ${wr(c.wins, c.games)} ${kda}kda (${roles})`);
    }
  }

  out.push("", "DUOS (two tracked players on the same team):");
  for (const pp of [...P.playerPairs].sort((a, b) => b.games - a.games))
    out.push(`* ${pp.a} + ${pp.b}: ${pp.games}g ${wr(pp.wins, pp.games)}`);

  out.push("", "CHAMP-PAIR SYNERGY (these players piloting these champs together):");
  for (const cp of [...P.championPairs].filter(c => c.games >= 3)
    .sort((a, b) => b.games - a.games).slice(0, 40))
    out.push(`* ${cp.pa} ${nameOf(cp.a)} + ${cp.pb} ${nameOf(cp.b)}: ${cp.games}g ${wr(cp.wins, cp.games)}`);

  const stacks = (P.stacks || []).slice(0, 8);
  if (stacks.length) {
    out.push("", "RECENT FULL 5-STACK GAMES (newest first):");
    for (const s of stacks) {
      const us = s.us.map(r => `${r.rid.split("#")[0]} ${nameOf(r.champ)}`).join(", ");
      const them = s.them.map(r => nameOf(r.champ)).join("/");
      out.push(`* ${new Date(s.ts).toISOString().slice(0, 10)} ${s.win ? "WIN" : "LOSS"} ` +
        `${Math.round(s.secs / 60)}min: [${us}] vs [${them}]`);
    }
  }

  if (data.meta && data.meta.champions) {
    out.push("", `CURRENT META, patch ${data.meta.patch} (champs the group plays; WR, tier 1=best):`);
    for (const cid of [...played].sort((a, b) => a - b)) {
      const m = data.meta.champions[cid];
      if (!m) continue;
      const pos = Object.entries(m.positions || {})
        .map(([r, s]) => `${ROLE_SHORT[r] || r} ${(s.winRate * 100).toFixed(1)}%`).join(", ");
      out.push(`* ${nameOf(cid)}: tier ${m.tier ?? "?"} (${pos})`);
    }
  }

  if (data.profiles && data.profiles.champions) {
    const rows = [...played].sort((a, b) => a - b).map(cid => {
      const pr = data.profiles.champions[cid];
      if (!pr) return null;
      const kind = pr.physShare >= 0.6 ? "AD" : pr.magicShare >= 0.6 ? "AP" : "mixed";
      const tags = [kind, pr.tankPct >= 0.75 ? "tanky" : null,
        pr.ccPct >= 0.75 ? "high CC" : null, pr.shieldPct >= 0.85 ? "shields/heals" : null];
      return `${nameOf(cid)} ${tags.filter(Boolean).join(" ")}`;
    }).filter(Boolean);
    out.push("", "DAMAGE PROFILES: " + rows.join("; "));
  }

  return out.join("\n");
}

async function chat(env, req) {
  if (!env.AI) return json({ error: "AI binding not configured" }, 503);
  const body = await req.json().catch(() => null);
  const msgs = body && Array.isArray(body.messages)
    ? body.messages.slice(-CHAT_MAX_MSGS) : null;
  if (!msgs || !msgs.length) return json({ error: "messages required" }, 400);
  for (const m of msgs)
    if (!m || (m.role !== "user" && m.role !== "assistant")
      || typeof m.content !== "string" || !m.content.trim()
      || m.content.length > CHAT_MAX_MSG_CHARS)
      return json({ error: "bad message" }, 400);

  let digest = await env.KV.get("chatdigest");
  if (!digest) {
    const data = await env.KV.get("data", "json");
    if (!data) return json({ error: "not seeded" }, 503);
    digest = buildChatDigest(data);
    await env.KV.put("chatdigest", digest, { expirationTtl: DIGEST_TTL });
  }

  // Workers AI streams SSE bytes (`data: {"response":"..."}` lines) — pass
  // them straight through; the page parses them incrementally.
  const stream = await env.AI.run(CHAT_MODEL, {
    messages: [{ role: "system", content: `${CHAT_SYSTEM}\n\n${digest}` }, ...msgs],
    stream: true,
    max_tokens: 600,
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...CORS },
  });
}

// --- cron: meta + champion names ------------------------------------------

async function refreshMeta(env) {
  const state = await env.KV.get("state", "json");
  if (!state) return;
  const region = OPGG_REGION[state.config.platform] || "na";
  const tier = state.config.metaTier || "emerald_plus";
  const r = await fetch(`https://lol-api-champion.op.gg/api/${region}/champions/ranked?tier=${encodeURIComponent(tier)}`,
    { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
  if (r.ok) {
    const raw = await r.json();
    const champs = {};
    for (const c of raw.data) {
      const positions = {};
      for (const pos of c.positions || []) {
        const s = pos.stats;
        positions[pos.name] = { winRate: s.win_rate, pickRate: s.pick_rate,
          roleRate: s.role_rate || 0, games: s.play };
      }
      const avg = c.average_stats || {};
      champs[c.id] = { winRate: avg.win_rate, pickRate: avg.pick_rate, banRate: avg.ban_rate,
        games: avg.play || 0, tier: avg.tier, positions };
    }
    state.meta = { patch: raw.meta.version, region, tier, matchCount: raw.meta.match_count,
      analyzedAt: raw.meta.analyzed_at, fetchedAt: new Date().toISOString(), champions: champs };
    state.lastMetaRefresh = state.meta.fetchedAt;
  }

  // Data Dragon names — only re-parsed when the patch actually changes
  const vr = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  if (vr.ok) {
    const version = (await vr.json())[0];
    if (version !== state.ddragonVersion) {
      const cr = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
      if (cr.ok) {
        const raw = (await cr.json()).data;
        state.championNames = Object.fromEntries(
          Object.values(raw).map(c => [c.key, { slug: c.id, name: c.name }]));
        state.ddragonVersion = version;
      }
    }
  }
  await saveState(env, state);
}

// Single owner for aggregate/history mutations. The queue spans network awaits;
// using only a process-local lock in the outer Worker would not serialize colos.
// Prospective evaluation: the worker computes scores before outcomes exist.
// The draft feed is unauthenticated; this is observational telemetry, not an
// authenticated source of model truth. Riot identity/timing checks are separate.
const EVAL_ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const EVAL_LIMIT = 1000;
const canonicalRiotId = value => String(value || '').toLowerCase();
const evaluationSignature = comp => comp.map(p =>
  [p.role, canonicalRiotId(p.riotId), p.championId].join('|')).sort().join(';');
function evaluationMatch(record, match) {
  const info = match.info, captured = Date.parse(record.capturedAt);
  const horizon=record.automatic ? 15*60000 : 6*3600000;
  if (!info || !(info.gameStartTimestamp > captured && info.gameStartTimestamp <= captured + horizon)) return false;
  if (record.queue === 'ranked' ? ![420,440].includes(info.queueId) : record.queue !== info.queueId) return false;
  return [100,200].some(side => {
    if (record.side && record.side !== side) return false;
    const team = info.participants.filter(p => p.teamId === side);
    if (record.automatic) {
      const opponents=info.participants.filter(p=>p.teamId!==side).map(p=>p.championId).sort((a,b)=>a-b);
      const expected=(record.opponents||[]).map(p=>p.championId).sort((a,b)=>a-b);
      if (expected.length!==5 || JSON.stringify(opponents)!==JSON.stringify(expected)) return false;
    }
    return team.length === 5 && record.comp.every(slot => team.some(p =>
      p.championId === slot.championId && p.teamPosition === slot.role &&
      ((slot.puuidHistory || [slot.puuid]).includes(p.puuid) ||
       canonicalRiotId(slot.riotId) === canonicalRiotId(`${p.riotIdGameName}#${p.riotIdTagline}`))));
  });
}

export class StateHub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.tail = Promise.resolve();
  }
  serial(work) {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }
  async collectEvaluation(req, state, trustedDraft = null) {
    if (req.method === 'GET') {
      if (!this.env.ADMIN_TOKEN || req.headers.get('x-admin-token') !== this.env.ADMIN_TOKEN)
        return json({error:'forbidden'},403);
      const cursor = new URL(req.url).searchParams.get('cursor');
      const entries = await this.ctx.storage.list({prefix:'eval:meta:',limit:100,
        ...(cursor ? {startAfter:cursor} : {})});
      const records = [], matches = new Map(), collection = [];
      for (const [key, meta] of entries) {
        records.push(await this.ctx.storage.get(meta.recordKey));
        collection.push({id:key, capturedAt:meta.capturedAt, matchedIds:meta.matchedIds || []});
        for (const id of meta.matchedIds || []) matches.set(id, await this.ctx.storage.get('eval:match:'+id));
      }
      return json({schemaVersion:1,records,matches:[...matches.values()],collection,
        nextCursor:entries.size===100 ? [...entries.keys()].at(-1) : null});
    }
    if (req.method !== 'POST' || !trustedDraft) return json({error:'predictions are collected by the background worker'},405);
    const body = await req.text();
    if (new TextEncoder().encode(body).length > 64000) return json({error:'record too large'},413);
    let record;
    try { record = JSON.parse(body); } catch { return json({error:'invalid JSON'},400); }
    const draft=trustedDraft, now=Date.parse(record.capturedAt);
    if (!draft.active || new Set(draft.enemy||[]).size!==5 || now-draft.ts>=OWNER_TTL_MS || !draft.sessionId || record?.automatic?.sessionId!==draft.sessionId)
      return json({error:'no matching live draft'},409);
    const comp = record.comp;
    if (!Array.isArray(comp) || comp.length!==5 || !Array.isArray(draft.ours) || draft.ours.length!==5 ||
        new Set(comp.map(p=>p.role)).size!==5 || comp.some(p=>!EVAL_ROLES.includes(p.role)) ||
        new Set(comp.map(p=>canonicalRiotId(p.riotId))).size!==5 ||
        new Set(comp.map(p=>p.championId)).size!==5 || comp.some(p=>!Number.isInteger(p.championId)||p.championId<=0) ||
        evaluationSignature(comp)!==evaluationSignature(draft.ours.map(p=>({role:p.position,riotId:p.riotId,championId:p.championId}))))
      return json({error:'record must match five live players, roles and picks'},400);
    if (comp.some(p=>!state.config.riotIds.some(a=>canonicalRiotId(a.riotId)===canonicalRiotId(p.riotId))))
      return json({error:'untracked player'},400);
    const captured = Date.parse(record.capturedAt);
    if (record.schemaVersion!==1 || !Number.isFinite(captured) || captured>Date.now() || record.automatic?.computedAt!==record.capturedAt || record.automatic?.source!=='live-draft-worker' || record.captureStage!=='pregame' ||
        typeof record.modelVersion!=='string' || record.modelVersion.length>80 ||
        !(record.queue==='ranked'||[420,440].includes(record.queue)) ||
        !record.scores || typeof record.scores.current!=='number' ||
        Object.values(record.scores).some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1) ||
        (record.side!==null && record.side!==100 && record.side!==200) ||
        [record.dataGeneratedAt,record.meta?.analyzedAt,record.meta?.fetchedAt].filter(Boolean)
          .some(t=>!Number.isFinite(Date.parse(t))||Date.parse(t)>now) ||
        ['outcome','win','matchedMatchId'].some(k=>k in record))
      return json({error:'invalid pregame record'},400);
    const id = encodeURIComponent(draft.sessionId+':'+record.modelVersion);
    const key = 'eval:meta:'+id, recordKey='eval:record:'+id;
    const previous = await this.ctx.storage.get(key), signature='server-standard-v1:'+evaluationSignature(comp)+':'+[...draft.enemy].sort((a,b)=>a-b).join(',');
    // First observation for an unchanged draft wins across alarm retries.
    // A new lineup may replace it using its frozen pregame computation time.
    if (previous?.signature===signature) return json({ok:true,duplicate:true});
    if (previous?.matchedIds?.length) return json({error:'outcome already observed'},409);
    if (!previous && (await this.ctx.storage.list({prefix:'eval:meta:',limit:EVAL_LIMIT})).size>=EVAL_LIMIT)
      return json({error:'evaluation storage full; export and archive before collecting more'},507);
    record.id='auto:'+id;record.capturedAt=new Date(now).toISOString();
    record.opponents=draft.enemy.map(championId=>({championId,role:null}));
    record.automatic={sessionId:draft.sessionId,source:'live-draft-worker',policy:'server-standard-v1',
      computedAt:record.capturedAt,receivedAt:new Date(Date.now()).toISOString(),scoringSourceSha:record.automatic.scoringSourceSha};
    // Bind identities to the tracked roster and its known account aliases.
    record.comp=comp.map(p=>{const a=state.config.riotIds.find(a=>canonicalRiotId(a.riotId)===canonicalRiotId(p.riotId));
      return {...p,riotId:a.riotId,puuid:a.puuid,puuidHistory:a.puuids||[a.puuid]};});
    await this.ctx.storage.put({[recordKey]:record,
      [key]:{recordKey,signature,capturedAt:record.capturedAt,matchedIds:[]}});
    const alarm=await this.ctx.storage.getAlarm();
    const refreshAt=Math.max(Date.now()+20000,now+300000);
    if (!alarm || alarm>refreshAt) await this.ctx.storage.setAlarm(refreshAt);
    return json({ok:true,capturedAt:record.capturedAt});
  }
  async reconcileEvaluation(state) {
    const entries = await this.ctx.storage.list({prefix:'eval:meta:',limit:EVAL_LIMIT});
    let pending = false;
    for (const [key,meta] of entries) {
      const candidates=Object.values(state.history.matches).filter(m=>
        m.info.gameStartTimestamp>Date.parse(meta.capturedAt) && m.info.gameStartTimestamp<=Date.parse(meta.capturedAt)+6*3600000);
      if (candidates.length) {
        const record=await this.ctx.storage.get(meta.recordKey), ids=new Set(meta.matchedIds);
        for (const match of candidates) if (evaluationMatch(record,match) && !ids.has(match.metadata.matchId)) {
          await this.ctx.storage.put('eval:match:'+match.metadata.matchId,compactMatch(match));
          ids.add(match.metadata.matchId);
        }
        if (ids.size!==meta.matchedIds.length) {meta.matchedIds=[...ids];await this.ctx.storage.put(key,meta);}
      }
      // Keep looking through the entire matching horizon, including possible
      // ambiguous second games. Late imports are also checked on later refreshes.
      if (Date.now()-Date.parse(meta.capturedAt)<24*3600000) pending=true;
    }
    return pending;
  }
  async readSnapshot(prefix = 'active') {
    const manifest = await this.ctx.storage.get(`${prefix}:manifest`);
    if (!manifest) return null;
    const readParts = async keys => {
      const parts = [];
      for (const key of keys) {
        const value = await this.ctx.storage.get(key);
        if (typeof value !== 'string') throw new Error('Incomplete durable snapshot');
        parts.push(value);
      }
      return JSON.parse(parts.join(''));
    };
    const state = await readParts(manifest.state);
    if (manifest.events) state.history.matches = await readParts(manifest.events);
    return state;
  }
  async writeSnapshot(state, prefix = 'active') {
    const previous = await this.ctx.storage.get(`${prefix}:manifest`);
    const matches = state.history?.matches;
    const body = matches ? { ...state, history: { ...state.history, matches: undefined } } : state;
    this.knownChunks ||= new Set();
    const writeParts = async value => {
      const serialized = JSON.stringify(value), keys = [], width = 16000;
      for (let n = 0; n < serialized.length; n += width) {
        const part = serialized.slice(n, n + width);
        // JSON encoding preserves split surrogate code units in the hash input.
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(part)));
        const key = 'chunk:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        if (!this.knownChunks.has(key)) {
          if (await this.ctx.storage.get(key) === undefined) await this.ctx.storage.put(key, part);
          this.knownChunks.add(key);
        }
        keys.push(key);
      }
      return keys;
    };
    // Separate append-mostly events from frequently changing aggregates. Hash
    // reuse avoids rewriting the whole multi-megabyte log for each small batch.
    const manifest = { state: await writeParts(body),
      ...(matches ? { events: await writeParts(matches) } : {}) };
    // Immutable chunks become visible together via one atomic pointer write.
    // A crash before this leaves the previous revision authoritative.
    await this.ctx.storage.put(`${prefix}:manifest`, manifest);
    if (previous) {
      const retained = new Set();
      for (const name of ['active', 'backup:import', 'backup:before-seed']) {
        const ref = await this.ctx.storage.get(`${name}:manifest`);
        for (const key of [...(ref?.state || []), ...(ref?.events || [])]) retained.add(key);
      }
      for (const key of new Set([...previous.state, ...(previous.events || [])]))
        if (!retained.has(key)) { await this.ctx.storage.delete(key); this.knownChunks.delete(key); }
    }
  }
  async load() {
    let state = await this.readSnapshot();
    if (state) return state;
    const legacy = await this.env.KV.get('state', 'json');
    if (!legacy) return null;
    // Keep the original import privately in DO storage before any conversion.
    if (!await this.ctx.storage.get('backup:import:manifest'))
      await this.writeSnapshot(legacy, 'backup:import');
    state = structuredClone(legacy);
    initializeHistory(state);
    await this.writeSnapshot(state);
    return state;
  }
  async commit(state) {
    await this.writeSnapshot(state);
    // KV remains a published read snapshot for chat/counter/fearless paths.
    // Failed publication cannot undo the authoritative durable commit.
    try {
      // The event log belongs only in durable storage. A ledger-free KV backup
      // advertises legacy format so a disaster reimport can never rebuild empty.
      const published = { ...state, history: { version: 0, complete: false,
        source: 'durable-object', summary: historyStatus(state) }, ingest: undefined };
      await this.env.KV.put('state', JSON.stringify(published));
      await this.env.KV.put('data', JSON.stringify(deriveData(state)));
    } catch (e) { console.error('Compy snapshot publication failed:', e.message); }
    const evaluationPending = await this.reconcileEvaluation(state);
    const i = state.ingest, now = Date.now();
    const readyAt = [
      ...i.pending.map(id => i.matchRetries[id]?.retryAt || now),
      ...i.profilePending.map(rid => i.profileRetries[rid]?.retryAt || now),
      ...Object.values(i.discovery).filter(d => !d.coveredThrough || d.scan).map(d => d.retryAt || now),
      ...Object.values(state.history.unavailable).map(x => x.retryAt || now),
    ];
    if (evaluationPending) readyAt.push(now + 300000);
    if (readyAt.length) await this.ctx.storage.setAlarm(Math.max(now + 20000,
      i.retryAt || 0, Math.min(...readyAt)));
    else await this.ctx.storage.deleteAlarm();
  }
  async fetch(req) {
    return this.serial(async () => {
      try {
        const path = new URL(req.url).pathname;
        let state = await this.load();
        if (path === '/seed' && req.method === 'POST') {
          if (!this.env.ADMIN_TOKEN || req.headers.get('x-admin-token') !== this.env.ADMIN_TOKEN)
            return json({ error: 'forbidden' }, 403);
          const next = await req.json();
          if (!next?.config?.riotIds?.length || !next.players || !Array.isArray(next.processed))
            return json({ error: 'invalid seed state' }, 400);
          if (state) await this.writeSnapshot(state, 'backup:before-seed');
          initializeHistory(next);
          // A ledger seed is re-derived, rather than trusting inconsistent counters.
          if (next.history.complete) rebuildHistory(next);
          next.lastRefresh ||= new Date().toISOString();
          await this.commit(next);
          return json({ ok: true, matches: next.processed.length, history: historyStatus(next) });
        }
        if (!state) return json({ error: 'not seeded — POST /seed first' }, 503);
        initializeHistory(state);
        if (path === '/__evaluation' && req.method==='POST') {
          const payload=await req.json();
          return this.collectEvaluation(new Request('https://state.internal/evaluation',{
            method:'POST',body:JSON.stringify(payload.record)}),state,payload.draft);
        }
        if (path === '/evaluation') return this.collectEvaluation(req,state);
        const expired = expireHistory(state);
        if (path === '/data') {
          if (expired) await this.commit(state);
          return new Response(JSON.stringify(deriveData(state)), { headers: {
            'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
        }
        if (path === '/') return json({ ok: true, matches: state.processed.length,
          lastRefresh: state.lastRefresh, lastMetaRefresh: state.lastMetaRefresh, history: historyStatus(state) });
        // Existing routines operate on a request-local store, then commit once.
        // They cannot read stale KV or race another writer during network waits.
        const localEnv = { ...this.env, KV: {
          get: async (key, type) => key === 'state'
            ? type === 'json' ? state : JSON.stringify(state) : this.env.KV.get(key, type),
          put: async (key, value, options) => {
            if (key === 'state') state = JSON.parse(value);
            else if (key !== 'data') await this.env.KV.put(key, value, options);
          },
        } };
        let response;
        if (path === '/refresh' && req.method === 'POST') response = await refresh(localEnv);
        else if (path === '/__meta' && req.method === 'POST') {
          await refreshMeta(localEnv); response = json({ ok: true });
        } else return json({ error: 'not found' }, 404);
        await this.commit(state);
        return response;
      } catch (e) { return json({ error: e.message || String(e) }, 500); }
    });
  }
  async alarm() {
    const response = await this.fetch(new Request('https://state.internal/refresh', { method: 'POST' }));
    if (!response.ok) throw new Error(`Background catch-up failed (${response.status})`);
  }
}
function stateOwner(env) {
  if (!env.STATE) throw new Error('STATE Durable Object binding is required; no unlocked fallback is allowed');
  return env.STATE.get(env.STATE.idFromName('main'));
}

// --- entry ----------------------------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      if (['/data', '/refresh', '/seed', '/evaluation', '/'].includes(url.pathname))
        return await stateOwner(env).fetch(req);
      if (url.pathname === "/chat" && req.method === "POST") return await chat(env, req);
      if (url.pathname === "/counters") return await counters(env, url);
      if (url.pathname === "/fearless") return await fearless(env, url);
      if (url.pathname === "/draft" || url.pathname === "/draft/ws") {
        // Deliberately unauthenticated, unlike /seed: requiring the admin
        // token here meant every new machine needed a secret copied by hand
        // before its bridge worked. The draft feed is transient, low-stakes
        // state — worst case someone who finds the URL posts a fake draft —
        // and the DraftHub's single-owner arbitration already handles
        // conflicting feeders.
        return await env.DRAFT.get(env.DRAFT.idFromName("main")).fetch(req);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(stateOwner(env).fetch(new Request("https://state.internal/__meta", { method: "POST" })).then(r => {
      if (!r.ok) throw new Error(`Meta refresh failed (${r.status})`);
    }));
  },
};
