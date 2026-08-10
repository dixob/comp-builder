// Comp Builder API — Cloudflare Worker.
//
// Incremental refresher for the static front-end on GitHub Pages: the full
// aggregates live in KV (seeded once from the local match cache by
// build_seed.py), and each /refresh pulls only the few newest matches per
// player and merges them into the running counters. Nothing here ever
// recomputes from raw match history.
//
// Routes:
//   GET  /data     -> {players, meta, profiles} exactly as the front-end expects
//   POST /refresh  -> pull newest matches, merge, return {added, remaining, ...}
//   POST /seed     -> replace KV state wholesale (x-admin-token: ADMIN_TOKEN)
//   cron           -> refresh OP.GG meta + Data Dragon champion names daily
//
// Free-tier budget per /refresh: 6 match-id calls + <=MAX_NEW_MATCHES match
// fetches + mastery for players with new games — worst case ~24 subrequests
// (cap 50), and JSON work stays tiny because at most MAX_NEW_MATCHES ~80 KB
// matches are parsed (CPU cap 10 ms).

const DEBOUNCE_MS = 3 * 60 * 1000; // ignore refreshes closer together than this
const RECENT_IDS = 5;              // newest match ids to check per player
const MAX_NEW_MATCHES = 12;        // merge cap per refresh; rest picked up next click

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
      bump(s.roles[pos] ??= { games: 0, wins: 0 }, p.win);
    }
    bump(pl.queues[qid] ??= { games: 0, wins: 0 }, p.win);
  }

  for (const teamId of [100, 200]) {
    const team = parts.filter(p => p.teamId === teamId);
    const tracked = team.filter(p => ridOf[p.puuid]);
    if (tracked.length < 2) continue;
    const won = team[0].win;
    // pilot-attributed pairs: sort by (riotId, championId) like the seeder
    tracked.sort((a, b) => ridOf[a.puuid] < ridOf[b.puuid] ? -1
      : ridOf[a.puuid] > ridOf[b.puuid] ? 1 : a.championId - b.championId);
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
  const players = state.config.riotIds.map(({ riotId, puuid }) => {
    const pl = state.players[riotId];
    return {
      riotId, puuid,
      profileIconId: pl.profileIconId,
      mastery: pl.mastery,
      champions: Object.entries(pl.champs)
        .map(([cid, s]) => ({ championId: +cid, games: s.games, wins: s.wins,
          cs: s.cs || 0, secs: s.secs || 0, roles: s.roles, q: s.q || {} }))
        .sort((a, b) => b.games - a.games),
      queues: pl.queues,
    };
  });
  return {
    players: {
      generatedAt: state.lastRefresh,
      ddragonVersion: state.ddragonVersion,
      champions: state.championNames,
      players,
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
  };
}

async function saveState(env, state) {
  await env.KV.put("state", JSON.stringify(state));
  await env.KV.put("data", JSON.stringify(deriveData(state)));
}

// --- refresh --------------------------------------------------------------

async function refresh(env) {
  const state = await env.KV.get("state", "json");
  if (!state) return json({ error: "not seeded — POST /seed first" }, 503);
  if (Date.now() - Date.parse(state.lastRefresh || 0) < DEBOUNCE_MS)
    return json({ added: 0, remaining: 0, debounced: true, lastRefresh: state.lastRefresh });

  const { platform, queue } = state.config;
  const region = REGION_OF[platform];
  const q = queue === "ranked" ? "&type=ranked" : queue ? `&queue=${queue}` : "";
  const processed = new Set(state.processed);

  // newest ids per player, deduped and filtered to unseen
  const fresh = new Set();
  const playersWithNew = new Set();
  for (const { riotId, puuid } of state.config.riotIds) {
    const ids = await riot(env, region,
      `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${RECENT_IDS}${q}`);
    for (const id of ids) if (!processed.has(id)) { fresh.add(id); playersWithNew.add(riotId); }
  }

  const todo = [...fresh].sort();
  const batch = todo.slice(0, MAX_NEW_MATCHES);
  for (const id of batch) {
    mergeMatch(state, await riot(env, region, `/lol/match/v5/matches/${id}`));
    processed.add(id);
  }

  // mastery moves only when someone actually played
  if (batch.length) {
    for (const { riotId, puuid } of state.config.riotIds) {
      if (!playersWithNew.has(riotId)) continue;
      const mastery = await riot(env, platform,
        `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`);
      state.players[riotId].mastery = mastery.map(m =>
        ({ championId: m.championId, level: m.championLevel, points: m.championPoints }));
    }
  }

  state.processed = [...processed];
  state.lastRefresh = new Date().toISOString();
  await saveState(env, state);
  return json({
    added: batch.length,
    remaining: todo.length - batch.length, // hit refresh again to catch up
    lastRefresh: state.lastRefresh,
  });
}

// --- cron: meta + champion names ------------------------------------------

async function refreshMeta(env) {
  const state = await env.KV.get("state", "json");
  if (!state) return;
  const region = OPGG_REGION[state.config.platform] || "na";
  const r = await fetch(`https://lol-api-champion.op.gg/api/${region}/champions/ranked`,
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
    state.meta = { patch: raw.meta.version, region, matchCount: raw.meta.match_count,
      analyzedAt: raw.meta.analyzed_at, champions: champs };
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
  state.lastMetaRefresh = new Date().toISOString();
  await saveState(env, state);
}

// --- entry ----------------------------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      if (url.pathname === "/data") {
        const data = await env.KV.get("data");
        if (!data) return json({ error: "not seeded" }, 503);
        return new Response(data, { headers: {
          "content-type": "application/json", "cache-control": "no-store", ...CORS } });
      }
      if (url.pathname === "/refresh" && req.method === "POST") return refresh(env);
      if (url.pathname === "/seed" && req.method === "POST") {
        if (!env.ADMIN_TOKEN || req.headers.get("x-admin-token") !== env.ADMIN_TOKEN)
          return json({ error: "forbidden" }, 403);
        const state = await req.json();
        state.lastRefresh ||= new Date().toISOString();
        await saveState(env, state);
        return json({ ok: true, matches: state.processed.length });
      }
      if (url.pathname === "/") {
        const state = await env.KV.get("state", "json");
        return json(state ? { ok: true, matches: state.processed.length,
          lastRefresh: state.lastRefresh, lastMetaRefresh: state.lastMetaRefresh }
          : { ok: false, error: "not seeded" });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshMeta(env));
  },
};
