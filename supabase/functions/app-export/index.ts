// Public endpoint for built apps (no user JWT):
//  GET  ?go=<app id>&k=<share key>      -> 302 to Expo Snack with fresh signed file links (the short link behind the QR code)
//  POST {action:"export", app_id}        -> project files for the EAS build workflow   (header x-build-secret)
//  POST {action:"report", app_id, build} -> build status / artifact link from the workflow (header x-build-secret)
import { createClient } from "npm:@supabase/supabase-js@2";
import { depsOf, isCodePath, snackUrl } from "../ai-gateway/apps.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

async function loadApp(id: string | null) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db.from("websites").select("id,name,site_type,config").eq("id", id).maybeSingle();
  return data && data.site_type === "app" ? data : null;
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("go")) {
    const site = await loadApp(url.searchParams.get("go"));
    const app = site?.config?.app ?? {};
    if (!site || !app.share || !safeEqual(String(app.share), url.searchParams.get("k") ?? "")) return new Response("not found", { status: 404 });
    const rev = Number(app.rev) || 0, paths = Object.keys(app.files ?? {}).filter(isCodePath);
    if (!rev || !paths.length) return new Response("not built yet", { status: 409 });
    const { data: signed } = await db.storage.from("app-files").createSignedUrls(paths.map((p) => `${site.id}/${rev}/${p}`), 24 * 3600);
    const urls: Record<string, string> = {};
    (Array.isArray(signed) ? signed : []).forEach((x: any, i: number) => { if (x?.signedUrl) urls[paths[i]] = x.signedUrl; });
    const deps = depsOf(Object.fromEntries(paths.map((p) => [p, app.files[p]])));
    return new Response(null, { status: 302, headers: { location: snackUrl(String(app.name ?? site.name), urls, deps, "mydevice"), "cache-control": "no-store" } });
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { data: secret } = await db.rpc("get_integration_secret", { p_name: "build_secret" });
  if (!secret || !safeEqual(String(secret), req.headers.get("x-build-secret") ?? "")) return json({ error: "unauthorized" }, 401);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const site = await loadApp(body.app_id);
  if (!site) return json({ error: "not_found" }, 404);
  const app = site.config?.app ?? {};

  if (body.action === "export") return json({ ok: true, name: app.name ?? site.name, slug: app.slug, files: app.files ?? {} });

  if (body.action === "report") {
    const b = body.build ?? {};
    const entry = {
      id: String(b.id ?? "").slice(0, 80), platform: ["android", "ios"].includes(b.platform) ? b.platform : "android", profile: String(b.profile ?? "").slice(0, 20),
      status: ["queued", "in_progress", "finished", "errored", "canceled"].includes(b.status) ? b.status : "in_progress",
      url: /^https:\/\/[^\s"'<>]+$/.test(b.url ?? "") ? b.url : "", page: /^https:\/\/expo\.dev\/[^\s"'<>]+$/.test(b.page ?? "") ? b.page : "",
      at: new Date().toISOString(),
    };
    const builds = (Array.isArray(app.builds) ? app.builds : []).filter((x: any) => !(entry.id && x.id === entry.id) && !(x.run && x.run === b.run));
    await db.from("websites").update({ config: { ...(site.config ?? {}), app: { ...app, builds: [{ ...entry, run: String(b.run ?? "").slice(0, 40) }, ...builds].slice(0, 20) } } }).eq("id", site.id);
    return json({ ok: true });
  }
  return json({ error: "unknown_action" }, 400);
});
