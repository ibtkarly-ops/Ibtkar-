import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// SSRF guard: block private/internal targets by string AND by resolving the hostname ourselves
// (defence in depth against DNS rebinding; fails open only if Deno.resolveDns itself is unavailable).
function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(low)) return true;
  if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));
  return false;
}

async function resolvesToPublicOnly(hostname: string): Promise<boolean> {
  const records: string[] = [];
  let resolved = false;
  try { records.push(...(await Deno.resolveDns(hostname, "A"))); resolved = true; } catch { /* none */ }
  try { records.push(...(await Deno.resolveDns(hostname, "AAAA"))); resolved = true; } catch { /* none */ }
  if (!resolved) return true;
  if (records.length === 0) return false;
  return records.every((ip) => !isPrivateIp(ip));
}

async function safeUrl(u: string): Promise<URL | null> {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return null;
    const h = x.hostname;
    if (h === "localhost" || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || h.endsWith(".internal") || h.includes(":")) return null;
    if (!(await resolvesToPublicOnly(h))) return null;
    return x;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  // Callers: (a) the scheduled job (pg_cron) with the random secret in platform_settings 'cron.secret',
  // (b) the service-role key, (c) a signed-in admin (the "check now" button). Everyone else is rejected.
  let isSystemCaller = !!token && token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cronSecret = req.headers.get("x-cron-secret");
  if (!isSystemCaller && cronSecret) {
    const { data: cs } = await db.from("platform_settings").select("value").eq("key", "cron.secret").maybeSingle();
    if (cs?.value && cs.value === cronSecret) isSystemCaller = true;
    else return json({ error: "unauthorized" }, 401);
  }
  let actorId: string | null = null;
  if (!isSystemCaller) {
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return json({ error: "unauthorized" }, 401);
    const { data: p } = await db.from("profiles").select("role,status").eq("id", u.user.id).maybeSingle();
    if (!p || p.status !== "active" || !["super_admin", "admin", "technical_manager"].includes(p.role)) return json({ error: "forbidden" }, 403);
    actorId = u.user.id;
  }

  const { data: sites } = await db.from("websites").select("id,name,public_url:url,owner_id").eq("status", "published").not("url", "is", null).limit(200);
  const results: unknown[] = [];
  for (const s of sites ?? []) {
    const target = await safeUrl(s.public_url as string);
    if (!target) { results.push({ id: s.id, ok: false, error: "invalid_url" }); continue; }
    const { data: prevRow } = await db.from("uptime_checks").select("ok").eq("website_id", s.id).order("checked_at", { ascending: false }).limit(1);
    const prevOk = prevRow?.[0]?.ok;   // undefined = first ever check
    const t0 = Date.now();
    let okv = false, code: number | null = null, err: string | null = null;
    try {
      const r = await fetch(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
      code = r.status; okv = r.status < 400;
    } catch (e) { err = String((e as Error).name); }
    await db.from("uptime_checks").insert({ website_id: s.id, ok: okv, status_code: code, latency_ms: Date.now() - t0, error: err });

    if (!okv && prevOk !== false) {            // went from up (or unknown) to down: tell the owner once
      await db.from("notifications").insert({ user_id: s.owner_id, type: "site_down", title: "site_down", body: s.name });
      await db.from("audit_logs").insert({ actor_id: actorId, action: "monitor.down", entity: "websites", meta: { id: s.id, code, err } });
    } else if (okv && prevOk === false) {       // recovered: tell the owner once
      await db.from("notifications").insert({ user_id: s.owner_id, type: "site_up", title: "site_up", body: s.name });
      await db.from("audit_logs").insert({ actor_id: actorId, action: "monitor.up", entity: "websites", meta: { id: s.id, code } });
    }
    results.push({ id: s.id, ok: okv, status_code: code });
  }
  return json({ checked: results.length, results });
});
