import { createClient } from "npm:@supabase/supabase-js@2";
import { DISPLAY, KINDS, keyHint, listError, modelsRequest, orderModels, parseModels, rankModels, safeEndpoint, type Found, type Kind, type Ranked } from "./models.ts";

// Public publishable key (same one shipped in the browser app). Used only as the `apikey` header when we act
// *as the signed-in admin* (their JWT goes in Authorization), e.g. to call admin_set_provider_key.
const PUBLISHABLE = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_5Ch9XW29qSLTxPuqvVVBnA_jjHsHtu0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Msg = { role: "system" | "user" | "assistant"; content: string };
type Out = { text: string; tin: number; tout: number };

const BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

async function callProvider(kind: string, endpoint: string | null, key: string, model: string, messages: Msg[], maxTokens = 4096, timeoutMs = 45_000): Promise<Out> {
  const base = (endpoint || BASES[kind] || "").replace(/\/+$/, "");
  if (!base.startsWith("https://")) throw new Error("provider endpoint must be https");
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  const signal = AbortSignal.timeout(timeoutMs);

  if (kind === "anthropic") {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST", signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: system || undefined, messages: turns }),
    });
    if (!r.ok) throw new Error(`provider status ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    return {
      text: (d.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
      tin: d.usage?.input_tokens ?? 0, tout: d.usage?.output_tokens ?? 0,
    };
  }
  if (kind === "gemini") {
    const r = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal,
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: turns.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 8192) },
      }),
    });
    if (!r.ok) throw new Error(`provider status ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    return {
      text: (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join(""),
      tin: d.usageMetadata?.promptTokenCount ?? 0, tout: d.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [...(system ? [{ role: "system", content: system }] : []), ...turns] }),
  });
  if (!r.ok) throw new Error(`provider status ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return { text: d.choices?.[0]?.message?.content ?? "", tin: d.usage?.prompt_tokens ?? 0, tout: d.usage?.completion_tokens ?? 0 };
}

function cleanMessages(input: unknown): Msg[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 40) return null;
  const out: Msg[] = [];
  for (const m of input) {
    if (!m || typeof m.content !== "string" || m.content.length > 20_000) return null;
    if (!["system", "user", "assistant"].includes(m.role)) return null;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

const monthStart = () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

async function monthlyLimit(userId: string): Promise<number> {
  const { data } = await db.from("subscriptions").select("status, ends_at, plans(ai_requests_limit)").eq("user_id", userId).eq("status", "active");
  const limits = (data ?? []).filter((s: any) => !s.ends_at || new Date(s.ends_at) > new Date()).map((s: any) => s.plans?.ai_requests_limit ?? 0);
  if (limits.length) return Math.max(...limits);
  // FIX (2026-11-21): plans.code is stored lowercase ('free'), matching the
  // enforce_site_limit() trigger. The previous query used "FREE" (uppercase)
  // and never matched any row, so every customer with no active subscription
  // silently fell back to the hardcoded `?? 50` below instead of the real,
  // admin-configurable free-plan limit. This was invisible only because the
  // free plan currently also happens to be 50 — it would desync the moment
  // an admin changes the free plan's ai_requests_limit.
  const { data: free } = await db.from("plans").select("ai_requests_limit").eq("code", "free").maybeSingle();
  return free?.ai_requests_limit ?? 50;
}

// Per-project AI budget: 50% of the package price (a small floor for free plans), measured in real cost.
async function budget(siteId: string, ownerId: string) {
  const { data: subs } = await db.from("subscriptions").select("status, ends_at, plans(price)").eq("user_id", ownerId).eq("status", "active");
  const prices = (subs ?? []).filter((s: any) => !s.ends_at || new Date(s.ends_at) > new Date()).map((s: any) => Number(s.plans?.price ?? 0));
  const price = prices.length ? Math.max(...prices) : 0;
  const { data: fl } = await db.from("platform_settings").select("value").eq("key", "ai.free_budget_usd").maybeSingle();
  const floor = Number(fl?.value ?? 0.25) || 0;
  const limit = Math.max(price * 0.5, floor);
  const { data: u } = await db.from("ai_usage").select("cost").eq("website_id", siteId).gte("created_at", monthStart());
  const used = (u ?? []).reduce((a: number, x: any) => a + Number(x.cost), 0);
  return { limit, used, ok: used < limit };
}

async function setting(key: string): Promise<string | null> {
  const { data } = await db.from("platform_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

class AIError extends Error { constructor(public code: string, public status = 502, public detail = "") { super(code); } }

// Candidate models for a task, cheapest first, from enabled providers with a saved key (no network call).
//
// FIX (2026-11-21): providers used to be tried strictly by `priority`, so a
// provider with a known-bad key (health='down' from a previous failed
// "test" call, e.g. a leftover test entry) could sit ahead of a working one
// at the same priority and eat a slow failed request on every single build
// before falling back. Providers are now ranked healthy-first (down last)
// within the same priority tier; a down provider is still tried as a last
// resort rather than skipped outright, in case it has since recovered.
async function candidates(task: string) {
  const { data: providers } = await db.from("ai_providers").select("*").eq("enabled", true).not("secret_id", "is", null).order("priority", { ascending: true });
  const healthRank = (h: string) => (h === "down" ? 2 : h === "degraded" ? 1 : 0);
  const ranked = (providers ?? []).slice().sort((a: any, b: any) => {
    const pa = Number(a.priority ?? 100), pb = Number(b.priority ?? 100);
    if (pa !== pb) return pa - pb;
    return healthRank(a.health) - healthRank(b.health);
  });
  const out: { provider: any; model: any }[] = [];
  for (const p of ranked) {
    const { data: models } = await db.from("ai_models").select("*").eq("provider_id", p.id).eq("enabled", true);
    const pool = models ?? [];
    let cand = pool.filter((m: any) => m.usage_type === task);
    if (!cand.length) cand = pool.filter((m: any) => m.usage_type === "general");
    // Same chain the connect screen shows (best balanced -> best fast -> others); cost is only for budgeting.
    cand = orderModels(task, p.kind as Kind, cand);
    for (const model of cand) out.push({ provider: p, model });
  }
  return out;
}

// Model router. Tries enabled providers/models best-first and moves on automatically when one fails
// (overloaded 503/429, timeout, bad model). A rejected key (401/403) skips that provider's remaining models.
// Hard deadline so the edge function always answers before its own wall-clock limit (the browser also has a timeout).
async function runAI(opts: { task: string; messages: Msg[]; userId: string; siteId: string | null; maxTokens?: number }) {
  const cand = await candidates(opts.task);
  if (!cand.length) throw new AIError("service_not_configured", 503);
  const deadline = Date.now() + 105_000;
  let tried = 0, lastErr = "";
  const dead = new Set<string>(), touched = new Set<string>();   // touched = we flagged it degraded earlier in THIS run, reset it on success
  for (const { provider: p, model } of cand) {
    if (dead.has(p.id)) continue;
    if (Date.now() > deadline - 8_000) break;
    const { count: recent } = await db.from("ai_usage").select("id", { count: "exact", head: true }).eq("provider_id", p.id).gte("created_at", new Date(Date.now() - 60_000).toISOString());
    if ((recent ?? 0) >= p.max_rpm) continue;
    const { data: key } = await db.rpc("get_provider_key", { p_provider: p.id });
    if (!key) continue;
    tried++;
    try {
      const out = await callProvider(p.kind, p.endpoint, key, model.model_id, opts.messages, opts.maxTokens ?? 4096, Math.min(55_000, deadline - Date.now()));
      const cost = (out.tin * Number(model.cost_in_per_1m) + out.tout * Number(model.cost_out_per_1m)) / 1_000_000;
      await db.from("ai_usage").insert({ user_id: opts.userId, website_id: opts.siteId, provider_id: p.id, model: model.model_id, tokens_in: out.tin, tokens_out: out.tout, cost, status: "ok" });
      if (p.health !== "healthy" || p.last_error || touched.has(p.id)) await db.from("ai_providers").update({ health: "healthy", checked_at: new Date().toISOString(), last_error: null }).eq("id", p.id);
      return { text: out.text, model: model.model_id };
    } catch (e) {
      const msg = String((e as Error).message);
      const status = Number(msg.match(/status (\d{3})/)?.[1] ?? 0);
      const authFail = status === 401 || status === 403;
      if (authFail) dead.add(p.id);
      touched.add(p.id);
      lastErr = `${p.name}/${model.model_id}: ${msg.slice(0, 160)}`;
      await db.from("ai_usage").insert({ user_id: opts.userId, website_id: opts.siteId, provider_id: p.id, model: model.model_id, status: "error" });
      await db.from("ai_providers").update({ health: authFail ? "down" : "degraded", checked_at: new Date().toISOString(), last_error: msg.slice(0, 500) }).eq("id", p.id);
    }
  }
  throw new AIError(tried ? "all_providers_failed" : "service_not_configured", tried ? 502 : 503, lastErr);
}

const intl = (x: unknown) => {
  const q = String(x ?? "").trim().replace(/[^\d+]/g, "");
  if (!q) return "";
  if (q[0] === "+") return q.slice(1);
  if (q.startsWith("00")) return q.slice(2);
  if (q[0] === "0") return "218" + q.slice(1);
  return q.length <= 9 ? "218" + q : q;
};

function cleanHtml(x: string) { return (x || "").replace(/^\s*```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim(); }
function validHtml(h: string, brief: any): boolean {
  if (!/<html[\s>]/i.test(h) || !/<\/html>/i.test(h) || h.length < 1500 || h.length > 300_000) return false;
  if (/<script[^>]+src=/i.test(h) || /<img[^>]+src=["']https?:/i.test(h)) return false;
  const dg = h.replace(/\D/g, "");
  const ph = intl(brief?.phone);
  if (ph && !dg.includes(ph.slice(-8))) return false;
  if (brief?.name && !h.toLowerCase().includes(String(brief.name).toLowerCase().slice(0, 12))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// PHP/Node ("app stack") generation (added 2026-11-21).
//
// store + clinic -> PHP; company + portfolio -> Node.js. Every other
// site_type (landing, restaurant, blog, education, other, ...) keeps the
// existing single-self-contained-HTML flow below completely unchanged.
// ---------------------------------------------------------------------------
type Stack = "php" | "node";
function stackFor(siteType: string): Stack | null {
  if (siteType === "store" || siteType === "clinic") return "php";
  if (siteType === "company" || siteType === "portfolio") return "node";
  return null;
}

const APP_PREAMBLE = (stack: Stack) => stack === "php"
  ? "أنت مهندس PHP محترف تكتب مشروع موقع حقيقي وكامل وجاهز للتشغيل فوراً، بأعلى معايير الأمان."
  : "أنت مهندس Node.js محترف تكتب مشروع موقع حقيقي وكامل وجاهز للتشغيل فوراً، بأعلى معايير الأمان.";

const APP_ADDENDUM = (stack: Stack) => `قيود صارمة لهذا النوع (تتقدم على أي متطلبات تقنية أخرى في التعليمات، ولا استثناء لها):
- أعد JSON صالحاً فقط، بلا أي نص أو شرح أو Markdown قبله أو بعده، بالشكل التالي حرفياً: {"files": {"المسار": "المحتوى الكامل كنص", ...}}
${stack === "php" ? `- الملف "public/index.php" إلزامي (نقطة الدخول الوحيدة). يمكن إضافة ملفات أصول داخل "public/" (مثل public/style.css) وملفات PHP تُدرَج داخل "src/" فقط. ممنوع منعاً مطلقاً أي ملف خارج هذين المجلدين، وممنوع إنشاء .htaccess أو أي ملف إعداد خادم.
- قاعدة البيانات: PDO SQLite فقط، المسار من getenv('DB_PATH') (لا تفترض قيمة ثابتة)، أنشئ الجداول بـ"CREATE TABLE IF NOT EXISTS" عند أول استخدام.
- كل استعلام SQL يجب أن يكون prepared statement بمعاملات مُجهّزة (bindValue/execute(array)). ممنوع تجميع أي SQL من نصوص خام بتاتاً.
- اهرب كل مُخرَج من بيانات المستخدم بدالة htmlspecialchars.
- أي صفحة تعرض طلبات/حجوزات/رسائل محفوظة (عادة public/admin.php) يجب حمايتها بهذا الكود تماماً في أولها: تحقق من $_SERVER['PHP_AUTH_USER'] و $_SERVER['PHP_AUTH_PW'] مقارنة بـgetenv('ADMIN_USER') وgetenv('ADMIN_PASSWORD')، وإن لم تتطابقا أرسل header('WWW-Authenticate: Basic realm="admin"') وhttp_response_code(401) وتوقف.` : `- الملفان "package.json" و "server.js" إلزاميان في جذر المشروع. استخدم فقط وحدات Node المدمجة (http, node:sqlite, url, crypto) بلا أي حزمة خارجية إلا إذا كانت ضرورية جداً، وإن استخدمت حزمة فيجب أن تكون من سجل npm العام برقم إصدار عادي (لا git:// ولا file:// ولا روابط). ممنوع أي سكربت preinstall أو postinstall في package.json.
- السيرفر يستمع عبر "process.env.PORT" (رقم المنفذ من البيئة، لا تفرض رقماً ثابتاً بنفسك) باستخدام http.createServer المدمج.
- قاعدة البيانات: وحدة "node:sqlite" المدمجة (const {DatabaseSync} = require('node:sqlite')) فقط، المسار من process.env.DB_PATH، أنشئ الجداول بـ"CREATE TABLE IF NOT EXISTS" عند أول استخدام.
- كل استعلام SQL يجب أن يكون عبر db.prepare(...).run(params)/.get(params) بمعاملات مُجهّزة. ممنوع تجميع أي SQL من نصوص خام بتاتاً.
- اهرب كل مُخرَج من بيانات المستخدم بدالة escape بسيطة تكتبها بنفسك (استبدال &<>"').
- أي مسار يعرض طلبات/رسائل محفوظة (عادة "/admin") يجب حمايته بفحص ترويسة Authorization: Basic (فكّك قيمتها بـBase64 وقارن المستخدم وكلمة المرور بـprocess.env.ADMIN_USER وprocess.env.ADMIN_PASSWORD)، وإن لم تتطابقا أرسل status 401 مع ترويسة WWW-Authenticate: Basic وتوقف.`}
- ممنوع تماماً: eval أو ما يشابهها، تنفيذ أوامر نظام (exec/shell/system/child_process)، قراءة أو كتابة أي مسار خارج مجلد المشروع أو مجلد البيانات، أي طلب شبكة خارجي (fetch/curl/http client نحو أي عنوان خارجي)، وأي مفتاح أو كلمة مرور مكتوبة مباشرة في الكود.
- عمليات العميل التي تُغيّر بيانات (طلب شراء، حجز، رسالة تواصل) تُحفظ في SQLite ثم تُعرض فقط في الصفحة المحمية أعلاه — لا إرسال بريد فعلي ولا دفع فعلي في هذا الإصدار، ويُستبدل ذلك برابط واتساب/هاتف حقيقي كما في بيانات العميل.
- أعد مشروعاً كاملاً يعمل فوراً دون أي تعديل، بلا أي ملف إعداد Docker أو خادم، وبلا أي نص خارج كتلة JSON.`;

const APP_MAX_FILES = 200;
const APP_MAX_FILE_BYTES = 512 * 1024;
const APP_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const APP_SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isSafeAppPath(p: string): boolean {
  if (typeof p !== "string" || !p || p.length > 200) return false;
  if (!APP_SAFE_PATH.test(p)) return false;
  if (p.includes("..") || p.startsWith("/")) return false;
  return !p.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

// Mirrors supabase/functions/deploy-vps and infra/deploy-agent/validate.js
// on purpose: the AI's raw output is validated here FIRST (so a bad
// generation never even gets saved as the "current" version of the site),
// and validated again independently by the deploy-agent right before it
// ever touches Docker. Neither layer trusts the other.
function validateAppProject(stack: Stack, files: unknown): string | null {
  if (!files || typeof files !== "object" || Array.isArray(files)) return "bad_files";
  const map = files as Record<string, unknown>;
  const paths = Object.keys(map);
  if (paths.length === 0) return "no_files";
  if (paths.length > APP_MAX_FILES) return "too_many_files";
  let total = 0;
  for (const p of paths) {
    if (!isSafeAppPath(p)) return `unsafe_path:${p}`;
    const c = map[p];
    if (typeof c !== "string") return `non_string_content:${p}`;
    const bytes = new TextEncoder().encode(c).length;
    if (bytes > APP_MAX_FILE_BYTES) return `file_too_large:${p}`;
    total += bytes;
  }
  if (total > APP_MAX_TOTAL_BYTES) return "project_too_large";
  if (stack === "php") {
    if (!("public/index.php" in map)) return "missing_entrypoint:public/index.php";
    for (const p of paths) {
      if (p === ".htaccess" || p.endsWith("/.htaccess")) return "htaccess_not_allowed";
      if (!p.startsWith("public/") && !p.startsWith("src/")) return `path_outside_project_layout:${p}`;
    }
  } else {
    if (!("package.json" in map)) return "missing_entrypoint:package.json";
    if (!("server.js" in map)) return "missing_entrypoint:server.js";
    try {
      const pkg = JSON.parse(map["package.json"] as string);
      if (pkg?.scripts?.preinstall) return "preinstall_script_not_allowed";
      if (pkg?.scripts?.postinstall) return "postinstall_script_not_allowed";
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dep, ver] of Object.entries(deps)) {
        if (/^(file:|git|https?:|github:)/i.test(String(ver))) return `unsafe_dependency_source:${dep}`;
      }
    } catch { return "bad_package_json"; }
  }
  return null;
}

function cleanJson(x: string) { return (x || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim(); }
function parseFilesJson(text: string): Record<string, string> | null {
  const cleaned = cleanJson(text);
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed.files === "object" ? parsed.files : null;
  } catch { return null; }
}

async function autoDeployVps(token: string, websiteId: string): Promise<{ deployed: boolean; url?: string; error?: string }> {
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/deploy-vps`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
      body: JSON.stringify({ website_id: websiteId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { deployed: false, error: j.error || `deploy_vps_http_${r.status}` };
    return { deployed: true, url: j.url };
  } catch (e) {
    return { deployed: false, error: String((e as Error).message).slice(0, 200) };
  }
}

const ADDENDUM = `قيود المنصة (تتقدم على أي متطلبات تقنية أخرى في التعليمات):
- المخرج صفحة HTML واحدة مكتفية بذاتها: CSS داخلي وجافاسكربت داخلي بسيط. لا سكربتات خارجية ولا صور بعيدة (استخدم تدرجات CSS أو SVG داخلي). يُسمح برابط Google Fonts فقط.
- لا يوجد خادم ولا قاعدة بيانات ولا لوحة إدارة. لا تحاكِ حسابات أو دفعاً أو مخزوناً حقيقياً أو إرسال نماذج. استبدلها بأزرار اتصال وواتساب وبريد حقيقية.
- روابط الاتصال تستخدم tel:+الرقم الدولي وروابط واتساب https://wa.me/الرقم الدولي، حرفياً كما في بيانات العميل.
- أعد وثيقة HTML كاملة فقط، بلا شرح ولا Markdown.`;

async function prompts(type: string): Promise<string> {
  const key = ({ restaurant: "restaurant", store: "store", company: "company" } as Record<string, string>)[type] ?? "landing";
  const { data } = await db.from("ai_prompts").select("key,body").in("key", ["master", key]);
  const m = (data ?? []).find((x: any) => x.key === "master")?.body ?? "";
  const t = (data ?? []).find((x: any) => x.key === key)?.body ?? "";
  return [m, t, ADDENDUM].filter(Boolean).join("\n\n---\n\n");
}

// Same idea as prompts() above but for the PHP/Node generator: no shared
// HTML-flavored 'master' row and no HTML ADDENDUM — just this type's own
// business instructions (editable from Admin -> Instructions exactly like
// 'landing'/'restaurant' already are) sandwiched between the fixed
// APP_PREAMBLE/APP_ADDENDUM that enforce the output format and security
// rules no admin edit can loosen.
async function appPrompts(type: string, stack: Stack): Promise<string> {
  const { data } = await db.from("ai_prompts").select("body").eq("key", type).maybeSingle();
  return [APP_PREAMBLE(stack), data?.body ?? "", APP_ADDENDUM(stack)].filter(Boolean).join("\n\n---\n\n");
}

async function canAccess(userId: string, role: string, site: any) {
  if (site.owner_id === userId || ["super_admin", "admin", "technical_manager", "developer"].includes(role)) return true;
  if (site.org_id) {
    const { data: m } = await db.from("org_members").select("user_id").eq("org_id", site.org_id).eq("user_id", userId).maybeSingle();
    return !!m;
  }
  return false;
}

function parseJson(t: string): any {
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
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
  const isAdmin = ["super_admin", "admin"].includes(prof.role);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  try {
    // ---- Admin: connect a provider with ONE key (discover its real models, pick the right ones, test, enable) ----
    //      "models" does the same for an already-connected provider (re-detect after a provider releases new models).
    if (body.action === "connect" || body.action === "models") {
      if (prof.role !== "super_admin") return json({ error: "forbidden" }, 403);
      let kind: Kind, key: string, endpoint: string | null = null, provider: any = null;
      if (body.action === "models") {
        const { data: p } = await db.from("ai_providers").select("*").eq("id", body.provider_id).maybeSingle();
        if (!p || !p.secret_id) return json({ ok: false, error: "provider_or_key_missing" });
        const { data: k } = await db.rpc("get_provider_key", { p_provider: p.id });
        if (!k) return json({ ok: false, error: "provider_or_key_missing" });
        provider = p; kind = p.kind as Kind; key = k; endpoint = p.endpoint;
      } else {
        kind = String(body.kind ?? "") as Kind;
        if (!KINDS.includes(kind)) return json({ ok: false, error: "bad_kind" });
        key = String(body.key ?? "").trim();
        if (key.length < 8 || key.length > 500 || /\s/.test(key)) return json({ ok: false, error: "invalid_key_format" });
        if (kind === "custom") {
          endpoint = safeEndpoint(String(body.endpoint ?? ""));
          if (!endpoint) return json({ ok: false, error: "endpoint_required" });
        }
      }

      // 1) ask the provider which models this key can really use
      const rq = modelsRequest(kind, endpoint, key);
      let found: Found[] = [];
      try {
        const r = await fetch(rq.url, { headers: rq.headers, signal: AbortSignal.timeout(15_000) });
        if (!r.ok) {
          const detail = (await r.text()).slice(0, 300);
          if (provider) await db.from("ai_providers").update({ health: "down", checked_at: new Date().toISOString(), last_error: `models status ${r.status}: ${detail}`.slice(0, 500) }).eq("id", provider.id);
          return json({ ok: false, error: listError(r.status), status: r.status, hint: keyHint(kind, key), detail });
        }
        found = parseModels(kind, await r.json());
      } catch { return json({ ok: false, error: "unreachable" }); }
      const ranked = rankModels(kind, found);
      if (!ranked.length) return json({ ok: false, error: "no_models" });

      // 2) one provider per kind (no more duplicates); store the key as the signed-in super admin
      if (!provider) {
        let q = db.from("ai_providers").select("*").eq("kind", kind).order("created_at", { ascending: true }).limit(1);
        if (kind === "custom") q = q.eq("endpoint", endpoint);
        const { data: ex } = await q;
        provider = ex?.[0] ?? null;
        if (!provider) {
          const name = kind === "custom" ? (String(body.name ?? "").trim().slice(0, 40) || "Custom") : DISPLAY[kind];
          const ins = await db.from("ai_providers").insert({ name, kind, endpoint, priority: 100, enabled: true }).select().single();
          if (ins.error) return json({ ok: false, error: "save_failed", detail: ins.error.message });
          provider = ins.data;
        }
        const userDb = createClient(Deno.env.get("SUPABASE_URL")!, PUBLISHABLE, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
        const kr = await userDb.rpc("admin_set_provider_key", { p_provider: provider.id, p_key: key });
        if (kr.error) return json({ ok: false, error: "key_store_failed", detail: kr.error.message });
      }

      // 3) sync models: add the new ones (primary + fallbacks enabled), fill missing prices, switch off ids the provider does not list
      const { data: have } = await db.from("ai_models").select("*").eq("provider_id", provider.id);
      const haveMap = new Map((have ?? []).map((m: any) => [m.model_id, m]));
      for (const m of ranked) {
        const row: any = haveMap.get(m.id);
        if (!row) await db.from("ai_models").insert({ provider_id: provider.id, model_id: m.id, usage_type: "general", enabled: m.selected, cost_in_per_1m: m.cost_in, cost_out_per_1m: m.cost_out });
        else if (Number(row.cost_in_per_1m) === 0 && Number(row.cost_out_per_1m) === 0 && (m.cost_in || m.cost_out)) await db.from("ai_models").update({ cost_in_per_1m: m.cost_in, cost_out_per_1m: m.cost_out }).eq("id", row.id);
      }
      const live = new Set(found.map((f) => f.id));
      for (const row of have ?? []) if (row.enabled && !live.has((row as any).model_id)) await db.from("ai_models").update({ enabled: false }).eq("id", (row as any).id);

      // 4) real test call with the first model that answers
      let tested: { ok: boolean; model?: string; error?: string } = { ok: false };
      for (const m of ranked.filter((x: Ranked) => x.selected)) {
        try { await callProvider(kind, endpoint, key, m.id, [{ role: "user", content: "ping" }], 16, 20_000); tested = { ok: true, model: m.id }; break; }
        catch (e) { tested = { ok: false, model: m.id, error: String((e as Error).message).slice(0, 200) }; }
      }
      await db.from("ai_providers").update({ enabled: true, health: tested.ok ? "healthy" : "degraded", checked_at: new Date().toISOString(), last_error: tested.ok ? null : (tested.error ?? "test failed") }).eq("id", provider.id);
      await db.from("audit_logs").insert({ actor_id: user.id, action: body.action === "connect" ? "ai_provider.connect" : "ai_provider.sync_models", entity: "ai_providers", meta: { provider_id: provider.id, kind, models: ranked.filter((x: Ranked) => x.selected).map((x: Ranked) => x.id), ok: tested.ok } });

      const { data: all } = await db.from("ai_models").select("model_id,enabled").eq("provider_id", provider.id);
      const en = new Map((all ?? []).map((m: any) => [m.model_id, !!m.enabled]));
      return json({ ok: true, provider: { id: provider.id, name: provider.name, kind }, models: ranked.map((m: Ranked) => ({ id: m.id, role: m.role, tier: m.tier, enabled: en.get(m.id) ?? false })), tested });
    }

    // ---- Admin: test a provider's real connection ----
    if (body.action === "test") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      const { data: p } = await db.from("ai_providers").select("*").eq("id", body.provider_id).maybeSingle();
      if (!p || !p.secret_id) return json({ ok: false, error: "provider_or_key_missing" }, 400);
      const { data: m } = await db.from("ai_models").select("model_id").eq("provider_id", p.id).eq("enabled", true).limit(1).maybeSingle();
      if (!m) return json({ ok: false, error: "no_model_configured" }, 400);
      const { data: key } = await db.rpc("get_provider_key", { p_provider: p.id });
      try {
        const out = await callProvider(p.kind, p.endpoint, key, m.model_id, [{ role: "user", content: "ping" }], 64);
        await db.from("ai_providers").update({ health: "healthy", checked_at: new Date().toISOString(), last_error: null }).eq("id", p.id);
        await db.from("audit_logs").insert({ actor_id: user.id, action: "ai_provider.test", entity: "ai_providers", meta: { provider_id: p.id, ok: true } });
        return json({ ok: true, reply_length: out.text.length });
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 500);
        await db.from("ai_providers").update({ health: "down", checked_at: new Date().toISOString(), last_error: msg }).eq("id", p.id);
        await db.from("audit_logs").insert({ actor_id: user.id, action: "ai_provider.test", entity: "ai_providers", meta: { provider_id: p.id, ok: false, error: msg } });
        return json({ ok: false, error: msg }, 502);
      }
    }

    // ---- Build a site from the customer's details + the right prompt for the chosen type ----
    if (body.action === "build") {
      const { data: site } = await db.from("websites").select("id,owner_id,org_id,name,site_type,config").eq("id", body.website_id).maybeSingle();
      if (!site) return json({ error: "website_not_found" }, 404);
      if (!(await canAccess(user.id, prof.role, site))) return json({ error: "forbidden" }, 403);
      const b = await budget(site.id, site.owner_id);
      if (!b.ok) return json({ error: "budget_exceeded" }, 402);
      if (prof.role === "customer") {
        const limit = await monthlyLimit(site.owner_id);
        const { count } = await db.from("ai_usage").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "ok").gte("created_at", monthStart());
        if ((count ?? 0) >= limit) return json({ error: "quota_exceeded", limit }, 429);
      }
      const brief = site.config?.brief ?? {};
      const lang = brief.lang === "both" ? "ثنائي اللغة: عربية RTL افتراضياً مع نسخة إنجليزية وزر EN/ع يبدّل النص واللغة والاتجاه" : brief.lang === "en" ? "English, LTR" : "العربية RTL (dir=rtl, lang=ar)";
      const ph = intl(brief.phone), wa = intl(brief.wa) || ph;
      const data = {
        name: brief.name ?? site.name, tagline: brief.tag ?? "", description: brief.desc ?? "", business_type: site.site_type,
        language: lang, main_color: brief.color ?? "", design_style: brief.style ?? "",
        phone: ph ? "+" + ph : "", whatsapp: wa ? "+" + wa : "", email: brief.email ?? "", address: brief.addr ?? "", hours: brief.hours ?? "",
        instagram: brief.ig ?? "", facebook: brief.fb ?? "", tiktok: brief.tt ?? "", telegram: brief.tg ?? "",
        offerings: String(brief.items ?? "").split("\n").map((x: string) => x.trim()).filter(Boolean),
      };
      const serverOn = (await setting("ai.server_stack")) === "on";   // experimental server-side generator: OFF unless explicitly enabled
      const stack = serverOn ? stackFor(site.site_type) : null;
      if (stack) {
        const sys = await appPrompts(site.site_type, stack);
        const r = await runAI({ task: "ui", userId: user.id, siteId: site.id, maxTokens: 12000, messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(data) }] });
        const files = parseFilesJson(r.text);
        const invalid = files ? validateAppProject(stack, files) : "unparseable_output";
        if (invalid) return json({ ok: false, error: "invalid_output", detail: invalid }, 200);
        const cfg = { ...(site.config ?? {}), files };
        await db.from("websites").update({ config: cfg, stack, updated_at: new Date().toISOString() }).eq("id", site.id);
        const { data: vv } = await db.from("website_versions").select("version").eq("website_id", site.id).order("version", { ascending: false }).limit(1);
        await db.from("website_versions").insert({ website_id: site.id, version: (vv?.[0]?.version ?? 0) + 1, snapshot: { files }, note: "design", created_by: user.id });
        const dep = await autoDeployVps(token, site.id);
        return json({ ok: true, model: r.model, ...dep });
      }

      const sys = await prompts(site.site_type);
      const r = await runAI({ task: "ui", userId: user.id, siteId: site.id, maxTokens: 12000, messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(data) }] });
      const html = cleanHtml(r.text);
      if (!validHtml(html, brief)) return json({ ok: false, error: "invalid_output" }, 200);
      const cfg = { ...(site.config ?? {}), html };
      await db.from("websites").update({ config: cfg, updated_at: new Date().toISOString() }).eq("id", site.id);
      const { data: vv } = await db.from("website_versions").select("version").eq("website_id", site.id).order("version", { ascending: false }).limit(1);
      await db.from("website_versions").insert({ website_id: site.id, version: (vv?.[0]?.version ?? 0) + 1, snapshot: { html }, note: "design", created_by: user.id });
      return json({ ok: true, model: r.model });
    }

    // ---- Price a modification request: AI classifies it, the price itself is COMPUTED from the
    //      admin's own per-token prices (platform_settings 'ai.cost_markup') and the real size of the
    //      page, not guessed freeform by the model. Bounds stay as safety rails only. ----
    if (body.action === "quote") {
      const { data: rq } = await db.from("modification_requests").select("*").eq("id", body.request_id).maybeSingle();
      if (!rq) return json({ error: "not_found" }, 404);
      const { data: site } = await db.from("websites").select("id,owner_id,org_id,name,site_type,stack,config").eq("id", rq.website_id).maybeSingle();
      if (!site || !(await canAccess(user.id, prof.role, site))) return json({ error: "forbidden" }, 403);
      if (!["submitted", "analyzing"].includes(rq.status)) return json({ error: "not_pending" }, 409);
      const bd = await budget(site.id, site.owner_id);
      if (!bd.ok) return json({ error: "budget_exceeded" }, 402);
      const bs = await setting("ai.quote_bounds");
      let bounds: Record<string, [number, number]> = { simple: [0, 10], medium: [10, 60], advanced: [60, 300], major: [300, 2000] };
      try { if (bs) bounds = { ...bounds, ...JSON.parse(bs) }; } catch { /* keep defaults */ }
      const markup = Math.max(1, Number(await setting("ai.cost_markup")) || 4);

      const sys = `أنت مصنّف طلبات تعديل المواقع في منصة ابتكار. حدد مستوى الطلب فقط ولا تضع سعراً (السعر يُحسب آلياً من تكلفة التوكنات).\nبسيط: نص/صورة/لون/معلومات تواصل. متوسط: قسم جديد أو تعديل تصميم صفحة. متقدم: نظام جديد أو ربط خارجي. كبير: تطوير واسع.\nأعد JSON فقط: {"level":"simple|medium|advanced|major","reason_ar":"جملة قصيرة بالعربية"}`;
      const r = await runAI({ task: "classify", userId: user.id, siteId: site.id, maxTokens: 200, messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify({ request: rq.description, site_type: site.site_type, site_name: site.name }) }] });
      const j = parseJson(r.text) ?? {};
      const level = ["simple", "medium", "advanced", "major"].includes(j.level) ? j.level : "medium";
      const [lo, hi] = bounds[level] ?? [0, 100];

      const curLen = site.stack ? (JSON.stringify(site.config?.files ?? {}).length || 6000) : ((site.config?.html ?? "").length || 6000);
      const reqLen = String(rq.description ?? "").length;
      const estIn = Math.ceil((curLen + reqLen + 1200) / 3);
      const estOut = Math.ceil(curLen / 3);
      const cand = await candidates("ui");
      const m0 = cand[0]?.model;
      const rawCost = m0 ? (estIn * Number(m0.cost_in_per_1m) + estOut * Number(m0.cost_out_per_1m)) / 1_000_000 : 0;
      const computed = rawCost * markup;
      const price = Math.round(Math.min(hi, Math.max(lo, computed)) * 2) / 2;

      await db.from("modification_requests").update({ level, estimated_price: price, final_price: price, ai_reason: String(j.reason_ar ?? "").slice(0, 300), status: "quoted" }).eq("id", rq.id);
      await db.from("notifications").insert({ user_id: rq.user_id, type: "modification", title: "quote_ready" });
      await db.from("audit_logs").insert({ actor_id: user.id, action: "modification.ai_quote", entity: "modification_requests", meta: { id: rq.id, level, price, raw_cost: rawCost, markup, est_in: estIn, est_out: estOut } });
      return json({ ok: true, level, price, reason: j.reason_ar ?? "" });
    }

    // ---- Apply an approved modification to the site ----
    if (body.action === "apply") {
      const { data: rq } = await db.from("modification_requests").select("*").eq("id", body.request_id).maybeSingle();
      if (!rq) return json({ error: "not_found" }, 404);
      const { data: site } = await db.from("websites").select("id,owner_id,org_id,name,site_type,stack,config").eq("id", rq.website_id).maybeSingle();
      if (!site || !(await canAccess(user.id, prof.role, site))) return json({ error: "forbidden" }, 403);
      if (rq.status !== "approved") return json({ error: "not_approved" }, 409);
      const stack = ((await setting("ai.server_stack")) === "on" && (site.stack === "php" || site.stack === "node")) ? (site.stack as Stack) : null;
      const cur = stack ? JSON.stringify(site.config?.files ?? {}) : (site.config?.html ?? "");
      if (!cur || cur === "{}" || cur.length > 120_000) return json({ error: "page_too_large_for_edit" }, 413);
      const bd = await budget(site.id, site.owner_id);
      if (!bd.ok) return json({ error: "budget_exceeded" }, 402);
      await db.from("modification_requests").update({ status: "in_progress" }).eq("id", rq.id);

      if (stack) {
        const sys = (await appPrompts(site.site_type, stack)) + "\n\n---\n\nوضع التعديل: هذا مشروع موجود، عدّل فقط ما يطلبه العميل وحافظ على كل شيء آخر كما هو حرفياً. CURRENT_PROJECT أدناه هو JSON بالشكل {\"files\":{...}} لنفس المشروع الحالي. أعد نفس الشكل {\"files\":{...}} كاملاً بعد التعديل، بكل الملفات (المعدّلة وغير المعدّلة).";
        try {
          const r = await runAI({ task: "ui", userId: user.id, siteId: site.id, maxTokens: 12000, messages: [{ role: "system", content: sys }, { role: "user", content: "CURRENT_PROJECT:\n" + cur + "\n\nREQUESTED_CHANGE:\n" + rq.description }] });
          const files = parseFilesJson(r.text);
          const invalid = files ? validateAppProject(stack, files) : "unparseable_output";
          if (invalid) throw new AIError("invalid_output", 502);
          await db.from("websites").update({ config: { ...(site.config ?? {}), files }, updated_at: new Date().toISOString() }).eq("id", site.id);
          const { data: vv } = await db.from("website_versions").select("version").eq("website_id", site.id).order("version", { ascending: false }).limit(1);
          await db.from("website_versions").insert({ website_id: site.id, version: (vv?.[0]?.version ?? 0) + 1, snapshot: { files }, note: "edit: " + String(rq.description).slice(0, 150), created_by: user.id });
          await db.from("modification_requests").update({ status: "done" }).eq("id", rq.id);
          await db.from("notifications").insert({ user_id: rq.user_id, type: "modification", title: "mod_done" });
          const dep = await autoDeployVps(token, site.id);
          return json({ ok: true, ...dep });
        } catch (e) {
          await db.from("modification_requests").update({ status: "approved" }).eq("id", rq.id);
          throw e;
        }
      }

      const sys = (await prompts(site.site_type)) + "\n\n---\n\nوضع التعديل: عدّل فقط ما يطلبه العميل وحافظ على بقية الصفحة كما هي حرفياً (النصوص وأرقام الهاتف والروابط). أعد وثيقة HTML الكاملة المحدّثة فقط.";
      try {
        const r = await runAI({ task: "ui", userId: user.id, siteId: site.id, maxTokens: 12000, messages: [{ role: "system", content: sys }, { role: "user", content: "CURRENT_HTML:\n" + cur + "\n\nREQUESTED_CHANGE:\n" + rq.description }] });
        const html = cleanHtml(r.text);
        if (!validHtml(html, site.config?.brief ?? { name: site.name })) throw new AIError("invalid_output", 502);
        await db.from("websites").update({ config: { ...(site.config ?? {}), html }, updated_at: new Date().toISOString() }).eq("id", site.id);
        const { data: vv } = await db.from("website_versions").select("version").eq("website_id", site.id).order("version", { ascending: false }).limit(1);
        await db.from("website_versions").insert({ website_id: site.id, version: (vv?.[0]?.version ?? 0) + 1, snapshot: { html }, note: "edit: " + String(rq.description).slice(0, 150), created_by: user.id });
        await db.from("modification_requests").update({ status: "done" }).eq("id", rq.id);
        await db.from("notifications").insert({ user_id: rq.user_id, type: "modification", title: "mod_done" });
        return json({ ok: true });
      } catch (e) {
        await db.from("modification_requests").update({ status: "approved" }).eq("id", rq.id);
        throw e;
      }
    }

    // ---- Legacy plain chat (kept for internal use) ----
    if (body.action === "chat") {
      const messages = cleanMessages(body.messages);
      if (!messages) return json({ error: "invalid_messages" }, 400);
      if (!body.website_id && !isAdmin) return json({ error: "forbidden" }, 403);   // no website = no budget to charge, so staff only
      let siteId: string | null = null;
      if (body.website_id) {
        const { data: w } = await db.from("websites").select("id,owner_id,org_id").eq("id", body.website_id).maybeSingle();
        if (!w) return json({ error: "website_not_found" }, 404);
        if (!(await canAccess(user.id, prof.role, w))) return json({ error: "forbidden" }, 403);
        const b = await budget(w.id, w.owner_id);
        if (!b.ok) return json({ error: "budget_exceeded" }, 402);
        siteId = w.id;
      }
      const r = await runAI({ task: typeof body.usage_type === "string" ? body.usage_type : "general", userId: user.id, siteId, messages });
      return json({ text: r.text, model: r.model });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    if (e instanceof AIError) return json({ error: e.code, detail: e.detail }, e.status);
    return json({ error: "server_error" }, 500);
  }
});
