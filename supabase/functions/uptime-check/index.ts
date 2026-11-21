import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// SSRF guard (2026-11-21 hardening)
//
// The original safeUrl() blocked literal private/loopback IPs and IPv6
// literals in the URL string. That stops the obvious case
// (http://127.0.0.1/..., http://192.168.1.1/...) but a customer who fully
// controls their own domain's DNS can still point a perfectly public-looking
// hostname (e.g. mysite.example.com) at a private/internal/cloud-metadata
// address *at request time* ("DNS rebinding") — the string-only check never
// resolves the name, so it never sees the real target.
//
// isPrivateIp() + resolvesToPublicOnly() add a best-effort second layer:
// resolve the hostname ourselves and reject if ANY returned A/AAAA record is
// private/loopback/link-local. This narrows, but does not eliminate, the
// rebinding window (the attacker could still flip DNS between our resolve()
// and fetch()'s own resolve()) — a fully airtight fix needs connecting to a
// pinned IP while keeping the original Host/SNI, which plain `fetch()` does
// not expose. Given these functions already run in Supabase's own isolated
// Edge Runtime (not on the database's private network), the residual risk is
// low; this is defense-in-depth, not a guarantee.
//
// If Deno.resolveDns is unavailable in this runtime, we fail OPEN on the DNS
// check only (log a warning, keep the original string-based checks) so a
// runtime restriction can't silently break uptime monitoring for every site.
// ---------------------------------------------------------------------------
function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1") return true;
  if (low.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(low)) return true; // unique-local fc00::/7
  if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));
  return false;
}

async function resolvesToPublicOnly(hostname: string): Promise<boolean> {
  const records: string[] = [];
  let resolved = false;
  try {
    records.push(...(await Deno.resolveDns(hostname, "A")));
    resolved = true;
  } catch { /* no A records or lookup unsupported */ }
  try {
    records.push(...(await Deno.resolveDns(hostname, "AAAA")));
    resolved = true;
  } catch { /* no AAAA records or lookup unsupported */ }
  if (!resolved) return true; // Deno.resolveDns unavailable/blocked: fail open on this layer
  if (records.length === 0) return false; // resolved but empty is suspicious: fail closed
  return records.every((ip) => !isPrivateIp(ip));
}

// Blocks private/internal targets so a customer URL cannot be used to probe our network.
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
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: "unauthorized" }, 401);
  const { data: p } = await db.from("profiles").select("role,status").eq("id", u.user.id).maybeSingle();
  if (!p || p.status !== "active" || !["super_admin", "admin", "technical_manager"].includes(p.role)) return json({ error: "forbidden" }, 403);

  const { data: sites } = await db.from("websites").select("id,name,public_url:url,owner_id").eq("status", "published").not("url", "is", null).limit(200);
  const results: unknown[] = [];
  for (const s of sites ?? []) {
    const target = await safeUrl(s.public_url as string);
    if (!target) { results.push({ id: s.id, ok: false, error: "invalid_url" }); continue; }
    const t0 = Date.now();
    let okv = false, code: number | null = null, err: string | null = null;
    try {
      const r = await fetch(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
      code = r.status; okv = r.status < 400;
    } catch (e) { err = String((e as Error).name); }
    await db.from("uptime_checks").insert({ website_id: s.id, ok: okv, status_code: code, latency_ms: Date.now() - t0, error: err });

    if (!okv) {
      const { data: last } = await db.from("uptime_checks").select("ok").eq("website_id", s.id).order("checked_at", { ascending: false }).range(1, 1);
      if (last?.[0]?.ok !== false) {
        await db.from("notifications").insert({ user_id: s.owner_id, type: "site_down", title: "site_down", body: s.name });
        await db.from("audit_logs").insert({ actor_id: u.user.id, action: "monitor.down", entity: "websites", meta: { id: s.id, code, err } });
      }
    }
    results.push({ id: s.id, ok: okv, status_code: code });
  }
  return json({ checked: results.length, results });
});
