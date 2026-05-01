const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}
function normalizeTrack(input) {
  if (!input || typeof input !== "object") return null;
  const playUrl = String(input.playUrl || "").trim();
  if (!playUrl) return null;
  return {
    name: String(input.name || "Shared Track").trim().slice(0, 80) || "Shared Track",
    playUrl,
    bestLapSeconds: Number.isFinite(Number(input.bestLapSeconds)) ? Number(input.bestLapSeconds) : null,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true });

    if (url.pathname === "/api/competitions/event" && request.method === "GET") {
      const tier = Number(url.searchParams.get("tier"));
      const seed = String(url.searchParams.get("seed") || "");
      if (!Number.isFinite(tier) || !seed) return json({ ok: false, error: "tier and seed required" }, 400);

      const key = `event:${seed}:${tier}`;
      const row = await env.COMP_KV.get(key, "json");
      const event = row || { pool: 0, entries: 0, leaderboard: [], track: null, week: Number(url.searchParams.get("week") || 0) || null, settled: false, payouts: [] };
      return json({ ok: true, event });
    }

    if (url.pathname === "/api/competitions/enter" && request.method === "POST") {
      const body = await request.json();
      const tier = Number(body?.tier);
      const seed = String(body?.seed || "");
      const fee = Math.max(0, Number(body?.fee || 0));
      const week = Number(body?.week);
      const track = normalizeTrack(body?.track);
      if (!Number.isFinite(tier) || !seed || !Number.isFinite(fee)) return json({ ok: false, error: "invalid payload" }, 400);

      const key = `event:${seed}:${tier}`;
      const current = (await env.COMP_KV.get(key, "json")) || { pool: 0, entries: 0, leaderboard: [], track: null, week: Number.isFinite(week) ? week : null, settled: false, payouts: [] };
      current.pool = Number(current.pool || 0) + fee;
      current.entries = Number(current.entries || 0) + 1;
      if (!current.track && track) current.track = track;
      if (!Number.isFinite(Number(current.week)) && Number.isFinite(week)) current.week = week;
      await env.COMP_KV.put(key, JSON.stringify(current));
      return json({ ok: true, event: current });
    }

    if (url.pathname === "/api/competitions/submit" && request.method === "POST") {
      const body = await request.json();
      const tier = Number(body?.tier);
      const seed = String(body?.seed || "");
      const player = String(body?.player || "Player").trim().slice(0, 24) || "Player";
      const time = Number(body?.time);
      const week = Number(body?.week);
      if (!Number.isFinite(tier) || !seed || !Number.isFinite(time)) return json({ ok: false, error: "invalid payload" }, 400);

      const key = `event:${seed}:${tier}`;
      const current = (await env.COMP_KV.get(key, "json")) || { pool: 0, entries: 0, leaderboard: [], track: null, week: Number.isFinite(week) ? week : null, settled: false, payouts: [] };
      const lb = Array.isArray(current.leaderboard) ? current.leaderboard : [];
      const existing = lb.find((r) => r?.name === player);
      if (!existing) lb.push({ name: player, time });
      else if (time < Number(existing.time)) existing.time = time;

      lb.sort((a, b) => Number(a.time) - Number(b.time));
      current.leaderboard = lb.slice(0, 200);
      if (!Number.isFinite(Number(current.week)) && Number.isFinite(week)) current.week = week;
      await env.COMP_KV.put(key, JSON.stringify(current));
      return json({ ok: true, event: current });
    }

    if (url.pathname === "/api/competitions/settle" && request.method === "POST") {
      const body = await request.json();
      const tier = Number(body?.tier);
      const seed = String(body?.seed || "");
      if (!Number.isFinite(tier) || !seed) return json({ ok: false, error: "invalid payload" }, 400);
      const key = `event:${seed}:${tier}`;
      const current = (await env.COMP_KV.get(key, "json")) || { pool: 0, entries: 0, leaderboard: [], settled: false, payouts: [] };
      if (current.settled) return json({ ok: true, event: current, alreadySettled: true });
      const lb = Array.isArray(current.leaderboard) ? current.leaderboard.slice().sort((a, b) => Number(a.time) - Number(b.time)) : [];
      const pool = Math.max(0, Number(current.pool || 0));
      const perc = [0.6, 0.28, 0.12];
      current.payouts = lb.slice(0, 3).map((row, idx) => ({ name: String(row?.name || "Player"), coins: Math.floor(pool * perc[idx]), rank: idx + 1, time: Number(row?.time) }));
      current.settled = true;
      current.settledAt = Date.now();
      await env.COMP_KV.put(key, JSON.stringify(current));
      return json({ ok: true, event: current });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
