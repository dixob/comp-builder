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
//   POST /draft    -> live champ-select state from lcu_bridge.py (no auth —
//                     see the route for why)
//   GET  /draft    -> current champ-select state (strongly consistent)
//   GET  /draft/ws -> WebSocket; sends current state on connect, then pushes
//                     every update the moment the bridge posts it
//   GET  /counters -> ?champ=<id>&pos=<TOP|JUNGLE|MID|ADC|SUPPORT> lane-matchup
//                     records from OP.GG, KV-cached for a day
//   GET  /fearless -> ?since=<epoch seconds> flex games our players finished
//                     since then, for fearless-session champ exclusions
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
      // KDA sums, with kg counting the games they cover: records seeded
      // before these fields existed keep accumulating from here, and kg is
      // what makes the averages honest (never divide by `games`)
      s.k = (s.k || 0) + (p.kills || 0);
      s.d = (s.d || 0) + (p.deaths || 0);
      s.a = (s.a || 0) + (p.assists || 0);
      s.kg = (s.kg || 0) + 1;
      bump(s.roles[pos] ??= { games: 0, wins: 0 }, p.win);
    }
    bump(pl.queues[qid] ??= { games: 0, wins: 0 }, p.win);
    // slim history row for the profiles view, newest first, capped
    const endTs = m.info.gameEndTimestamp
      || (m.info.gameStartTimestamp || m.info.gameCreation || 0) + dur * 1000;
    (pl.recent ??= []).push({
      id: m.metadata.matchId, ts: endTs, q: qid, champ: p.championId,
      role: pos, win: p.win ? 1 : 0, k: p.kills || 0, d: p.deaths || 0,
      a: p.assists || 0, cs: csVal, secs: dur,
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
      ranks: pl.ranks || null,  // seeded from the last fetch_data.py run
      champions: Object.entries(pl.champs)
        .map(([cid, s]) => ({ championId: +cid, games: s.games, wins: s.wins,
          cs: s.cs || 0, secs: s.secs || 0, k: s.k || 0, d: s.d || 0,
          a: s.a || 0, kg: s.kg || 0, roles: s.roles, q: s.q || {} }))
        .sort((a, b) => b.games - a.games),
      queues: pl.queues,
      recent: pl.recent || [],
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

// --- draft + counters -----------------------------------------------------

const COUNTERS_TTL = 24 * 60 * 60;  // matchup stats move slowly
// The bridge heartbeats every 25s while in champ select, so three missed
// beats means it is gone, not merely quiet.
const OWNER_TTL_MS = 80 * 1000;

// The live draft lives in ONE Durable Object instance instead of KV: KV
// replicates lazily (reads can lag writes by ~60s across colos), a DO is a
// single authority every request routes to, so a posted ban is readable —
// and pushed to connected WebSockets — immediately. Sockets use the
// hibernation API so idle connections cost nothing.
export class DraftHub {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/ws")) {
      if (req.headers.get("Upgrade") !== "websocket")
        return json({ error: "websocket upgrade required" }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const draft = await this.ctx.storage.get("draft");
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
      draft.ts = Date.now();
      const body = JSON.stringify(draft);
      await this.ctx.storage.put("draft", body);
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(body); } catch { /* peer gone; close event cleans up */ }
      }
      return json({ ok: true, ts: draft.ts, listeners: this.ctx.getWebSockets().length });
    }
    const draft = await this.ctx.storage.get("draft");
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
  const key = `counters:${region}:${champ}:${pos}`;
  const cached = await env.KV.get(key);
  if (cached) return new Response(cached, {
    headers: { "content-type": "application/json", ...CORS } });
  const r = await fetch(
    `https://lol-api-champion.op.gg/api/${region}/champions/ranked/${champ}/${pos}`,
    { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
  if (!r.ok) return json({ error: `opgg ${r.status}` }, 502);
  const raw = await r.json();
  const body = JSON.stringify({ champ, pos, counters: (raw.data && raw.data.counters) || [] });
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
      if (url.pathname === "/counters") return counters(env, url);
      if (url.pathname === "/fearless") return fearless(env, url);
      if (url.pathname === "/draft" || url.pathname === "/draft/ws") {
        // Deliberately unauthenticated, unlike /seed: requiring the admin
        // token here meant every new machine needed a secret copied by hand
        // before its bridge worked. The draft feed is transient, low-stakes
        // state — worst case someone who finds the URL posts a fake draft —
        // and the DraftHub's single-owner arbitration already handles
        // conflicting feeders.
        return env.DRAFT.get(env.DRAFT.idFromName("main")).fetch(req);
      }
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
