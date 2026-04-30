const kv = await Deno.openKv();
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  if (url.pathname === "/" || url.pathname === "/ready") {
    return json({ ok: true, service: "competitions-api", runtime: "deno" });
  }
  if (url.pathname === "/health") return json({ ok: true });

  if (url.pathname === "/api/competitions/event" && req.method === "GET") {
    const tier = Number(url.searchParams.get("tier"));
    const seed = String(url.searchParams.get("seed") || "");
    if (!Number.isFinite(tier) || !seed) return json({ ok: false, error: "tier and seed required" }, 400);
    const key = ["event", seed, tier];
    const row = await kv.get(key);
    const event = row.value ?? { pool: 0, entries: 0, leaderboard: [] };
    return json({ ok: true, event });
  }

  if (url.pathname === "/api/competitions/enter" && req.method === "POST") {
    const body = await req.json();
    const tier = Number(body?.tier);
    const seed = String(body?.seed || "");
    const fee = Math.max(0, Number(body?.fee || 0));
    if (!Number.isFinite(tier) || !seed || !Number.isFinite(fee)) return json({ ok: false, error: "invalid payload" }, 400);
    const key = ["event", seed, tier];
    const current = (await kv.get(key)).value as any || { pool: 0, entries: 0, leaderboard: [] };
    current.pool = Number(current.pool || 0) + fee;
    current.entries = Number(current.entries || 0) + 1;
    await kv.set(key, current);
    return json({ ok: true, event: current });
  }

  if (url.pathname === "/api/competitions/submit" && req.method === "POST") {
    const body = await req.json();
    const tier = Number(body?.tier);
    const seed = String(body?.seed || "");
    const player = String(body?.player || "Player").trim().slice(0, 24) || "Player";
    const time = Number(body?.time);
    if (!Number.isFinite(tier) || !seed || !Number.isFinite(time)) return json({ ok: false, error: "invalid payload" }, 400);
    const key = ["event", seed, tier];
    const current = (await kv.get(key)).value as any || { pool: 0, entries: 0, leaderboard: [] };
    const lb = Array.isArray(current.leaderboard) ? current.leaderboard : [];
    const existing = lb.find((r: any) => r?.name === player);
    if (!existing) lb.push({ name: player, time });
    else if (time < Number(existing.time)) existing.time = time;
    lb.sort((a: any, b: any) => Number(a.time) - Number(b.time));
    current.leaderboard = lb.slice(0, 200);
    await kv.set(key, current);
    return json({ ok: true, event: current });
  }

  return json({ ok: false, error: "not found" }, 404);
});
