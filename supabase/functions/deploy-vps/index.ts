import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const AGENT_URL = (Deno.env.get("DEPLOY_AGENT_URL") || "").replace(/\/+$/, "");
const AGENT_SECRET = Deno.env.get("DEPLOY_AGENT_SECRET") || "";

async function canAccess(userId: string, role: string, site: any) {
  if (site.owner_id === userId || ["super_admin", "admin", "technical_manager", "developer"].includes(role)) return true;
  if (site.org_id) {
    const { data: m } = await db.from("org_members").select("user_id").eq("org_id", site.org_id).eq("user_id", userId).maybeSingle();
    return !!m;
  }
  return false;
}

async function getVpsServerId(): Promise<string | null> {
  const { data } = await db.from("servers").select("id").eq("provider", "vps").maybeSingle();
  return data?.id ?? null;
}

async function callAgent(path: string, body: unknown) {
  if (!AGENT_URL || !AGENT_SECRET) throw new Error("vps_not_configured");
  const r = await fetch(`${AGENT_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AGENT_SECRET}` },
    signal: AbortSignal.timeout(170_000), // a fresh Docker build can take a while
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || `agent_http_${r.status}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  const user = u?.user;
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: prof } = await db.from("profiles").select("role,status").eq("id", user.id).maybeSingle();
  if (!prof || prof.status !== "active") return json({ error: "account_inactive" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = body.action === "remove" ? "remove" : "deploy";

  const { data: site } = await db.from("websites").select("id,owner_id,org_id,name,site_type,stack,slug,config").eq("id", body.website_id).maybeSingle();
  if (!site) return json({ error: "website_not_found" }, 404);
  if (!(await canAccess(user.id, prof.role, site))) return json({ error: "forbidden" }, 403);
  if (!["php", "node"].includes(site.stack)) return json({ error: "not_app_stack" }, 400);

  const serverId = await getVpsServerId();

  if (action === "remove") {
    try {
      await callAgent("/remove", { site_id: site.id });
    } catch (e) {
      return json({ ok: false, error: String((e as Error).message).slice(0, 300) }, 502);
    }
    await db.from("deployments").update({ status: "rolled_back" }).eq("website_id", site.id).eq("status", "live");
    await db.from("websites").update({ status: "draft", url: null, updated_at: new Date().toISOString() }).eq("id", site.id);
    await db.from("audit_logs").insert({ actor_id: user.id, action: "website.vps_unpublish", entity: "websites", meta: { id: site.id } });
    return json({ ok: true });
  }

  // ---- deploy ----
  if (!site.slug) return json({ error: "missing_slug" }, 400);
  const files = site.config?.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return json({ error: "nothing_to_publish" }, 400);

  // The admin/back-office password for this one site is generated exactly
  // once (first deploy) and kept in config.files's sibling config forever
  // after: every later redeploy reuses it, so the owner's login never
  // silently changes under them. It is shown to them in Settings (same
  // tab the site editor already uses) — this is the only credential a
  // generated PHP/Node project ever needs; everything else (DB path,
  // ports) is wired by the deploy-agent itself, never by the AI.
  let adminUser = site.config?.admin_user;
  let adminPassword = site.config?.admin_password;
  if (!adminUser || !adminPassword) {
    adminUser = "admin";
    adminPassword = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await db.from("websites").update({ config: { ...(site.config ?? {}), admin_user: adminUser, admin_password: adminPassword } }).eq("id", site.id);
  }

  const { data: dep } = await db.from("deployments")
    .insert({ website_id: site.id, server_id: serverId, status: "building", log: "deploying to VPS", created_by: user.id })
    .select().single();

  try {
    const result = await callAgent("/deploy", {
      site_id: site.id, stack: site.stack, slug: site.slug, files,
      env: { ADMIN_USER: adminUser, ADMIN_PASSWORD: adminPassword },
    });
    await db.from("deployments").update({ status: "live", verified_live: true, public_url: result.url, log: "deployed" }).eq("id", dep.id);
    await db.from("websites").update({ status: "published", url: result.url, updated_at: new Date().toISOString() }).eq("id", site.id);
    await db.from("notifications").insert({ user_id: site.owner_id, type: "deploy", title: "deploy_ok", body: site.name });
    await db.from("audit_logs").insert({ actor_id: user.id, action: "website.vps_published", entity: "websites", meta: { id: site.id, deployment: dep.id, url: result.url } });
    return json({ ok: true, url: result.url });
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 300);
    await db.from("deployments").update({ status: "failed", verified_live: false, log: msg }).eq("id", dep.id);
    await db.from("notifications").insert({ user_id: site.owner_id, type: "deploy_failed", title: "deploy_failed", body: msg });
    return json({ ok: false, error: msg }, 502);
  }
});
