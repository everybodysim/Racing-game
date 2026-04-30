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
      const event = row || { pool: 0, entries: 0, leaderboard: [] };
      return json({ ok: true, event });
    }

    if (url.pathname === "/api/competitions/enter" && request.method === "POST") {
      const body = await request.json();
      const tier = Number(body?.tier);
      const seed = String(body?.seed || "");
      const fee = Math.max(0, Number(body?.fee || 0));
      if (!Number.isFinite(tier) || !seed || !Number.isFinite(fee)) return json({ ok: false, error: "invalid payload" }, 400);

      const key = `event:${seed}:${tier}`;
      const current = (await env.COMP_KV.get(key, "json")) || { pool: 0, entries: 0, leaderboard: [] };
      current.pool = Number(current.pool || 0) + fee;
      current.entries = Number(current.entries || 0) + 1;
      await env.COMP_KV.put(key, JSON.stringify(current));
      return json({ ok: true, event: current });
    }

    if (url.pathname === "/api/competitions/submit" && request.method === "POST") {
      const body = await request.json();
      const tier = Number(body?.tier);
      const seed = String(body?.seed || "");
      const player = String(body?.player || "Player").trim().slice(0, 24) || "Player";
      const time = Number(body?.time);
      if (!Number.isFinite(tier) || !seed || !Number.isFinite(time)) return json({ ok: false, error: "invalid payload" }, 400);

      const key = `event:${seed}:${tier}`;
      const current = (await env.COMP_KV.get(key, "json")) || { pool: 0, entries: 0, leaderboard: [] };
      const lb = Array.isArray(current.leaderboard) ? current.leaderboard : [];
      const existing = lb.find((r) => r?.name === player);
      if (!existing) lb.push({ name: player, time });
      else if (time < Number(existing.time)) existing.time = time;

      lb.sort((a, b) => Number(a.time) - Number(b.time));
      current.leaderboard = lb.slice(0, 200);
      await env.COMP_KV.put(key, JSON.stringify(current));
      return json({ ok: true, event: current });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
