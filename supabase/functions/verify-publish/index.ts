import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same SSRF hardening as supabase/functions/uptime-check/index.ts — see the
// comment block there for the full rationale (DNS-rebinding mitigation,
// fail-open only on the DNS-resolution layer itself).
function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1") return true;
  if (low.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(low)) return true;
  if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));
  return false;
}

async function resolvesToPublicOnly(hostname: string): Promise<boolean> {
  const records: string[] = [];
  let resolved = false;
  try { records.push(...(await Deno.resolveDns(hostname, "A"))); resolved = true; } catch { /* ignore */ }
  try { records.push(...(await Deno.resolveDns(hostname, "AAAA"))); resolved = true; } catch { /* ignore */ }
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

async function fail(dep: any, owner: string, msg: string) {
  await db.from("deployments").update({ status: "failed", verified_live: false, log: msg }).eq("id", dep.id);
  await db.from("notifications").insert({ user_id: owner, type: "deploy_failed", title: "deploy_failed", body: msg.slice(0, 200) });
  return json({ ok: false, error: msg });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: "unauthorized" }, 401);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (!UUID.test(String(b.deployment_id ?? ""))) return json({ error: "bad_request" }, 400);

  const { data: dep } = await db.from("deployments").select("*").eq("id", b.deployment_id).maybeSingle();
  if (!dep) return json({ error: "not_found" }, 404);
  const { data: site } = await db.from("websites").select("id,owner_id,org_id,name,slug,status").eq("id", dep.website_id).maybeSingle();
  if (!site) return json({ error: "not_found" }, 404);
  const { data: prof } = await db.from("profiles").select("role,status").eq("id", u.user.id).maybeSingle();
  let allowed = site.owner_id === u.user.id || (prof && prof.status === "active" && ["super_admin", "admin", "technical_manager"].includes(prof.role));
  if (!allowed && site.org_id) {
    const { data: m } = await db.from("org_members").select("user_id").eq("org_id", site.org_id).eq("user_id", u.user.id).maybeSingle();
    allowed = !!m;
  }
  if (!allowed) return json({ error: "forbidden" }, 403);
  if (dep.status === "live" && dep.verified_live) return json({ ok: true, url: dep.public_url, already: true });
  if (dep.status !== "building") return json({ error: "not_pending" }, 409);
  // the same gate as request_publish and the database trigger: contract approved + payment condition. A site that is already live is only re-verified.
  if (site.status !== "published") { const { data: blk } = await db.rpc("site_publish_block", { p_site: site.id }); if (blk) return json({ error: blk }, 403); }

  const { data: pub } = await db.from("published_sites").select("hash,slug").eq("website_id", site.id).maybeSingle();
  if (!pub) return await fail(dep, site.owner_id, "nothing published");
  const target = await safeUrl(dep.public_url ?? "");
  if (!target) return await fail(dep, site.owner_id, "invalid public url");

  target.searchParams.set("_", String(Date.now()));
  let r: Response;
  try {
    r = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(12_000), headers: { "user-agent": "ibtikar-verify/1" } });
  } catch (_e) {
    return await fail(dep, site.owner_id, "address unreachable: check the domain DNS record and route");
  }
  if (r.status !== 200) return await fail(dep, site.owner_id, `address answered ${r.status}`);

  // Accepted proof that the address really reaches the platform:
  //  - the sites Worker answers with the page's exact hash header, or
  //  - the platform app itself answers (it carries a marker and renders the published page from the database).
  let ok = r.headers.get("x-ibtikar-hash") === pub.hash;
  if (!ok) {
    const body = (await r.text()).slice(0, 300000);
    ok = body.includes('name="ibtikar-app"');
  }
  if (!ok) return await fail(dep, site.owner_id, "this address does not reach the platform");

  await db.from("deployments").update({ status: "rolled_back" }).eq("website_id", site.id).eq("status", "live");
  await db.from("deployments").update({ status: "live", verified_live: true, log: "verified" }).eq("id", dep.id);
  await db.from("websites").update({ status: "published", url: dep.public_url, updated_at: new Date().toISOString() }).eq("id", site.id);
  await db.from("notifications").insert({ user_id: site.owner_id, type: "deploy", title: "deploy_ok", body: site.name });
  await db.from("audit_logs").insert({ actor_id: u.user.id, action: "website.published", entity: "websites", meta: { id: site.id, deployment: dep.id } });
  return json({ ok: true, url: dep.public_url });
});
