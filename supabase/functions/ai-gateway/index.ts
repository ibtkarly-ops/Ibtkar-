import { createClient } from "npm:@supabase/supabase-js@2";
import { DISPLAY, KINDS, cleanKey, detectPick, keyHint, listError, modelsRequest, orderModels, parseCurl, parseModels, rankModels, resolveTarget, safeEndpoint, targetFromCurl, type Found, type Kind, type Ranked, type Target } from "./models.ts";
import { APP_CHAT_PROMPT, APP_FILE_PROMPT, cleanPlan, depsOf, exportsOf, extractCode, isCodePath, projectConfig, slugOf, snackUrl, validFile } from "./apps.ts";
import { CORE_RULES, DESIGN_PROMPT, EDIT_PROMPT, applyPatch, cleanCopy, cleanItems, ownImage, parseJSON } from "./spec.ts";

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

// Rough token estimate for budgeting a request (Arabic packs fewer characters per token than English).
export const estTokens = (messages: Msg[]) => Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 2.6) + 40 * messages.length;

/** Free open-model hosts reject a request whose input + max_tokens exceeds their per-minute token limit. */
export function fitMaxTokens(kind: string, messages: Msg[], want: number, cap: number): number {
  if (kind !== "custom" || !cap) return want;
  return Math.max(900, Math.min(want, cap - estTokens(messages)));
}

async function callProvider(kind: string, endpoint: string | null, key: string, model: string, messages: Msg[], maxTokens = 4096, timeoutMs = 45_000, jsonMode = false): Promise<Out> {
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
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 8192), ...(jsonMode ? { responseMimeType: "application/json" } : {}), ...(/flash/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
      }),
    });
    if (!r.ok) throw new Error(`provider status ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    return {
      text: (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join(""),
      tin: d.usageMetadata?.promptTokenCount ?? 0, tout: d.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
  const payload: Record<string, unknown> = { model, max_tokens: maxTokens, messages: [...(system ? [{ role: "system", content: system }] : []), ...turns] };
  if (jsonMode) payload.response_format = { type: "json_object" };
  if (/gpt-oss/i.test(model)) payload.reasoning_effort = "low";   // reasoning tokens count against the same per-minute budget
  const send = () => fetch(`${base}/chat/completions`, {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let r = await send();
  if (!r.ok && r.status === 400 && jsonMode) {
    const t = await r.text();
    if (!/response_format|json/i.test(t)) throw new Error(`provider status 400: ${t.slice(0, 300)}`);
    delete payload.response_format;                                  // host without JSON mode: the prompt still asks for JSON
    r = await send();
  }
  if (!r.ok) {
    const ra = Number(r.headers.get("retry-after") ?? 0);
    throw new Error(`provider status ${r.status}${ra ? ` retry-after ${ra}` : ""}: ${(await r.text()).slice(0, 300)}`);
  }
  const d = await r.json();
  return { text: d.choices?.[0]?.message?.content ?? "", tin: d.usage?.prompt_tokens ?? 0, tout: d.usage?.completion_tokens ?? 0 };
}

/** Groq-style "Request too large ... Limit 8000, Requested 9500": how many tokens to take off max_tokens to fit. */
export function overBy(msg: string): number {
  const m = /Limit\s+(\d+),\s*Requested\s+(\d+)/i.exec(msg);
  return m ? Number(m[2]) - Number(m[1]) : 0;
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
async function runAI(opts: { task: string; messages: Msg[]; userId: string; siteId: string | null; maxTokens?: number; json?: boolean; deadlineMs?: number; rules?: boolean }) {
  const cand = await candidates(opts.task);
  if (!cand.length) throw new AIError("service_not_configured", 503);
  const cap = Number(await setting("ai.request_token_cap") ?? 7500) || 0;
  // IBTIKAR AI rules go first in the system prompt: the full text where the host has no per-minute cap, the core otherwise
  const core = opts.rules ? (await setting("ai.master_rules_core")) || CORE_RULES : "", full = opts.rules ? (await setting("ai.master_rules")) || "" : "";
  const withRules = (kind: string) => !opts.rules ? opts.messages : [{ role: "system" as const, content: (kind !== "custom" && full ? full : core) }, ...opts.messages];
  const deadline = Date.now() + (opts.deadlineMs ?? 135_000);
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
      const msgs = withRules(p.kind);
      let mt = fitMaxTokens(p.kind, msgs, opts.maxTokens ?? 4096, cap);
      const attempt = () => callProvider(p.kind, p.endpoint, key, model.model_id, msgs, mt, Math.min(105_000, deadline - Date.now()), !!opts.json);
      let out: Out;
      try { out = await attempt(); }
      catch (e1) {
        // the same model usually works a moment later (per-minute limit) or with a smaller output budget
        const m1 = String((e1 as Error).message), s1 = Number(m1.match(/status (\d{3})/)?.[1] ?? 0);
        const wait = Number(m1.match(/retry-after (\d+)/)?.[1] ?? 0), over = overBy(m1);
        if (s1 === 429 && !/insufficient_quota|billing|credit/i.test(m1) && wait > 0 && wait <= 20 && !cand.some((c) => c.provider.id !== p.id && !dead.has(c.provider.id)) && Date.now() + wait * 1000 < deadline - 20_000) { await new Promise((r) => setTimeout(r, wait * 1000)); out = await attempt(); }
        else if ((s1 === 413 || s1 === 400 || s1 === 429) && over > 0 && mt - over - 200 >= 900) { mt = mt - over - 200; out = await attempt(); }
        else throw e1;
      }
      const cost = (out.tin * Number(model.cost_in_per_1m) + out.tout * Number(model.cost_out_per_1m)) / 1_000_000;
      await db.from("ai_usage").insert({ user_id: opts.userId, website_id: opts.siteId, provider_id: p.id, model: model.model_id, tokens_in: out.tin, tokens_out: out.tout, cost, status: "ok" });
      if (p.health !== "healthy" || p.last_error || touched.has(p.id)) await db.from("ai_providers").update({ health: "healthy", checked_at: new Date().toISOString(), last_error: null }).eq("id", p.id);
      return { text: out.text, model: model.model_id };
    } catch (e) {
      const msg = String((e as Error).message);
      const status = Number(msg.match(/status (\d{3})/)?.[1] ?? 0);
      const authFail = status === 401 || status === 403;
      if (authFail || (status === 429 && /insufficient_quota|billing|credit/i.test(msg))) dead.add(p.id);   // no point trying the same provider's other models
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
const SD_TYPES = ["company", "store", "restaurant", "landing"];
// The generated page must carry its items as JSON (id="site-data") so the customer can edit them later without AI.
export function validSiteData(h: string): boolean {
  const m = /<script[^>]*id=["']site-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(h);
  if (!m || !/id=["']items-list["']/.test(h)) return false;
  try {
    const d = JSON.parse(m[1]);
    return Array.isArray(d.items) && d.items.length >= 3 && d.items.length <= 60 && d.items.every((i: any) => i && typeof i.n === "string" && i.n.trim());
  } catch { return false; }
}
function validHtml(h: string, brief: any, needSD = false): boolean {
  if (needSD && !validSiteData(h)) return false;
  if (!/<html[\s>]/i.test(h) || !/<\/html>/i.test(h) || h.length < 1500 || h.length > 300_000) return false;
  const ownAssets = `${Deno.env.get("SUPABASE_URL") ?? "https://invalid.local"}/storage/v1/object/public/site-assets/`;
  const hh = h.split(ownAssets).join("");   // images we host ourselves are allowed; any other remote image/script is not
  if (/<script[^>]+src=/i.test(hh) || /<img[^>]+src=["']https?:/i.test(hh)) return false;
  const dg = h.replace(/\D/g, "");
  const ph = intl(brief?.phone);
  if (ph && !dg.includes(ph.slice(-8))) return false;
  if (brief?.name && !h.toLowerCase().includes(String(brief.name).toLowerCase().slice(0, 12))) return false;
  return true;
}

const ADDENDUM = `قيود المنصة (تتقدم على أي متطلبات تقنية أخرى في التعليمات):
- المخرج صفحة HTML واحدة مكتفية بذاتها: CSS داخلي وجافاسكربت داخلي بسيط. لا سكربتات خارجية ولا صور بعيدة (استخدم تدرجات CSS أو SVG داخلي). يُسمح برابط Google Fonts فقط.
- لا يوجد خادم ولا قاعدة بيانات ولا لوحة إدارة. لا تحاكِ حسابات أو دفعاً أو مخزوناً حقيقياً أو إرسال نماذج. استبدلها بأزرار اتصال وواتساب وبريد حقيقية.
- روابط الاتصال تستخدم tel:+الرقم الدولي وروابط واتساب https://wa.me/الرقم الدولي، حرفياً كما في بيانات العميل.
- أعد وثيقة HTML كاملة فقط، بلا شرح ولا Markdown.
- لا تخترع أرقام هواتف أو آراء عملاء أو إحصائيات أو شهادات أو عناوين أو أسعاراً؛ استخدم ما في بيانات العميل فقط.
- بيانات العميل تحوي must_have: قائمة بنود إلزامية طلبها العميل صراحةً (بانر إعلاني، خلفية متحركة، حركات، زر واتساب عائم، ترتيب الأقسام). نفّذها كلها حرفياً بالمعرّفات المذكورة (id/data-attributes) لأنها تُفحص آلياً ثم تُعاد الصفحة إن نقص منها شيء. وإن وُجد design_plan فاتبع عناوينه ونصوصه. استخدم customer_notes وaudience وmain_goal وtone وselling_points لتشكيل المحتوى والنبرة.
- التخطيط حسب نوع النشاط: المتجر = بطاقات منتجات كبيرة بصور ودوائر تصنيفات وشريط تصنيفات متحرك تحت الهيرو؛ المطعم = قائمة طعام بصفوف (الاسم ……… السعر) مجمّعة بعناوين التصنيفات مع تبويبات تصنيف لاصقة، وساعات العمل والعنوان كشارات زجاجية في الهيرو؛ الشركة = هيرو منقسم (نص + لوحة زجاجية بالشعار ونقاط القوة) وبطاقات خدمات بأيقونات SVG وخط زمني «كيف نعمل» وشريط دعوة متدرّج؛ الصفحة التعريفية = هيرو ضخم بعنوان واحد وشبكة مزايا bento وشريط دعوة نهائي كبير.
- البانرات والشعار: إن وُجدت banners في بيانات العميل فاعرضها كلها كشرائح متتابعة في الهيرو (صورة البانر خلفية كاملة بتدرّج داكن فوقها، ونصه عنوان كبير، ورابطه زر «اكتشف الآن»)، وأضفها في site-data كحقل banners بالشكل [{\"t\":\"النص\",\"img\":\"الرابط\",\"u\":\"الرابط\"}]، وبدّل نصوصها داخل #promo-banner كل بضع ثوانٍ. وإن وُجد logo فاعرضه في الشريط العلوي وكبيراً في الهيرو. صور البانرات والأصناف والشعار مسموحة لأنها مستضافة لدينا.
- لمسات الحركة: شريط تقدّم التمرير أعلى الصفحة، رأس يصغر ويظهر ظله عند التمرير، ظهور متتابع للبطاقات، توهّج يتبع المؤشر في الهيرو، وإمالة خفيفة للبطاقات على الديسكتوب فقط، وزر «للأعلى».
- مستوى الجودة المطلوب: تصميم بمستوى وكالات التصميم المحترفة: هيرو سينمائي، طباعة واثقة، مسافات سخية، حركات متقنة (دخول عند التمرير، hover، خلفية حية) تعمل بسلاسة على الجوال، وكل قسم مفصّل ومكتمل وليس مجرد عنوان.
- عقد الأصناف (إلزامي لأنواع الشركة والمتجر والمطعم والصفحة التعريفية): قسم الأصناف عنصر <section id=\"items\"> يحوي <div id=\"items-list\"></div> فارغاً يملؤه سكربت. ضع قبل </body> كتلة <script type=\"application/json\" id=\"site-data\">{\"sample\":true,\"items\":[{\"n\":\"الاسم\",\"c\":\"التصنيف\",\"p\":\"\",\"d\":\"وصف قصير\"}]}</script> ثم سكربت صغير يقرأ الكتلة ويرسم البطاقات داخل #items-list بإنشاء عناصر DOM وtextContent (لا innerHTML بنصوص خام)، مع أزرار تصنيف إذا وُجد أكثر من تصنيف، وإذا كان p فارغاً اعرض «اتصل للسعر» كرابط tel أو واتساب. إن وردت offerings في بيانات العميل فاستخدمها كما هي (الاسم|السعر|الوصف) وضع sample=false، وإلا أنشئ من 6 إلى 10 أصناف نموذجية واقعية تناسب النشاط والوصف بلا أسعار (p فارغ) وsample=true. كل صنف: n الاسم، c التصنيف، p السعر، d الوصف، وإن وُجدت صورة img (رابط). إن وُجد existing_items في بيانات العميل فانسخه كما هو حرفياً داخل site-data (بما فيه img وc وp) ولا تستبدله بأصناف نموذجية وضع sample=false. إن وُجد logo أو currency فأضفهما كحقلين logo وcur في site-data، واعرض الشعار صغيراً في الشريط العلوي، وصورة الصنف إن وُجدت (بإنشاء عنصر img عبر DOM)، وألحق cur بالأسعار الرقمية. ضع أيضاً نسخة ثابتة من الأصناف داخل #items-list بين التعليقين <!--sd--> و<!--/sd--> (يستبدلها السكربت عند التحميل) لتراها محركات البحث.`;

// Built-in prompt for the "app" type (web app / PWA). ai_prompts.key has a CHECK constraint, so it lives in code.
const APP_PROMPT = `أنت مصمم تطبيقات ويب جوال محترف. أنشئ تطبيق ويب (PWA) بصفحة HTML واحدة يبدو كتطبيق أصلي على الجوال:
- شريط تبويب سفلي ثابت (٣–٥ تبويبات) تبدّل بينها شاشات داخل نفس الصفحة بجافاسكربت بسيط، وشريط علوي باسم التطبيق.
- شاشات واقعية تناسب فكرة التطبيق وميزاته المطلوبة (قوائم، بطاقات، نماذج، ملف شخصي أو إعدادات) ببيانات نموذجية واضحة أنها نموذجية.
- تصميم مسطّح أنيق باللون الأساسي المطلوب، حواف مدوّرة، أزرار كبيرة سهلة اللمس، دعم RTL كامل ووضع داكن تلقائي حسب prefers-color-scheme.
- أضف في شاشة الإعدادات أو الرئيسية بطاقة قصيرة تشرح كيف يثبّت المستخدم التطبيق على شاشته (مشاركة ثم إضافة إلى الشاشة الرئيسية).
- لا تخترع أرقام هواتف أو آراء أو إحصائيات حقيقية. لا اتصال بخوادم؛ احفظ ما يلزم في localStorage فقط.`;

// ---- What the customer explicitly asked for must really exist in the page (checked, then repaired) ----
type Req = { id: string; rule: string; test: (h: string) => boolean };
export function requirements(brief: any, siteType: string, hasContact: boolean): Req[] {
  const kwt = [brief?.desc, brief?.notes, brief?.tag, brief?.usp].join(" ");
  const out: Req[] = [];
  const banner = String(brief?.banner ?? "").trim() || /بانر|إعلان|اعلان|عروض|banner|promo/i.test(kwt) || siteType === "store";
  if (banner) out.push({ id: "banner", rule: `بانر إعلاني ظاهر أول الصفحة فوق الهيرو: عنصر id="promo-banner" بنص عرض مقنع${brief?.banner ? ` هو حرفياً: «${String(brief.banner).slice(0, 140)}»` : " (صياغة عامة بلا أرقام أو خصومات مخترعة)"} وزر واتساب وزر إغلاق، وبحركة لافتة (لمعان أو تمرير).`, test: (h) => /id=["']promo-banner["']/.test(h) });
  const bg = brief?.bg !== "none" && brief?.motion !== "none";
  if (bg) out.push({ id: "bg", rule: `خلفية متحركة في أعلى الصفحة (الهيرو): عنصر يحمل data-animated-bg="${["aurora", "particles", "waves"].includes(brief?.bg) ? brief.bg : "aurora"}" يملأ الهيرو بحركة مستمرة ناعمة (ألوان متحركة/جزيئات متصلة/أمواج) بـCSS keyframes أو canvas خفيف، ويحترم prefers-reduced-motion، ولا يغطي النصوص.`, test: (h) => /data-animated-bg=/.test(h) && /@keyframes|requestAnimationFrame/.test(h) });
  if (brief?.motion !== "none") out.push({ id: "motion", rule: "حركات دخول عند التمرير (IntersectionObserver) لأقسام وبطاقات الصفحة، وتأثيرات hover للبطاقات والأزرار، وحركة دخول للعنوان الرئيسي.", test: (h) => /IntersectionObserver|animation-timeline/.test(h) });
  if (brief?.float !== "0" && hasContact) out.push({ id: "float", rule: 'زر واتساب عائم ثابت في زاوية الصفحة: عنصر id="wa-float" برابط https://wa.me/… الحقيقي وبنبض خفيف.', test: (h) => /id=["']wa-float["']/.test(h) && /wa\.me/.test(h) });
  if ((siteType === "store" || siteType === "restaurant") && hasContact) out.push({ id: "cart", rule: 'سلة طلبات واتساب: زر «أضف للسلة» في كل صنف، وزر سلة عائم id="cart-btn" بعدّاد، ولوحة جانبية id="cart" فيها الأصناف بالكمية (+/−/حذف) والمجموع حين تكون الأسعار أرقاماً، وحقلا الاسم والملاحظات، وزر «أرسل الطلب عبر واتساب» يفتح https://wa.me/الرقم?text= برسالة مرتبة (الصنف × الكمية — السعر، ثم المجموع والاسم والملاحظات) مُرمّزة بـencodeURIComponent، وتُحفظ السلة في localStorage. ضع زر السلة في الزاوية المقابلة لزر واتساب العائم.', test: (h) => /id=["']cart["']/.test(h) && /id=["']cart-btn["']/.test(h) && /encodeURIComponent/.test(h) && /wa\.me/.test(h) });
  if (siteType === "store" || siteType === "restaurant") out.push({ id: "order", rule: "ترتيب الأقسام: بانر ← هيرو ← الأصناف/المنتجات مباشرة بعد الهيرو ← من نحن ← كيف تطلب ← أسئلة شائعة ← تواصل.", test: (h) => { const a = h.search(/id=["']items["']/), b = h.search(/id=["']about["']/); return a < 0 || b < 0 || a < b; } });
  return out;
}
const missingOf = (reqs: Req[], html: string) => reqs.filter((r) => !r.test(html));
const PLAN_PROMPT = `أنت مدير إبداعي في وكالة تصميم مواقع. اقرأ بيانات العميل (بما فيها ملاحظاته وجمهوره وهدفه ونبرته) وضع خطة موقع قبل بنائه.
أعد JSON فقط بلا أي نص آخر بالشكل: {"headline":"عنوان الهيرو القوي","subheadline":"جملة داعمة","banner_text":"نص البانر الإعلاني القصير","about":"فقرة من نحن بأسلوب النبرة المطلوبة","sections":[{"id":"items","title":"عنوان قسم الأصناف","intro":"جملة تمهيدية"}],"why_us":["ميزة1","ميزة2","ميزة3"],"faq":[{"q":"سؤال","a":"جواب"}],"cta":"نص زر الدعوة","vibe":"وصف الجو البصري والحركات في سطرين"}.
قواعد: اكتب بلغة الموقع المطلوبة، التزم بنبرة العميل، لا تخترع أرقاماً ولا أسعاراً ولا آراء عملاء ولا عناوين ولا خصومات، استخدم مميزات العميل نفسها في why_us إن وُجدت، ونص البانر عام ومقنع بلا نسب خصم.`;
function briefData(brief: any, site: any, ph: string, wa: string, prevSD: any, keepItems: any) {
  const lang = brief.lang === "both" ? "ثنائي اللغة: عربية RTL افتراضياً مع نسخة إنجليزية وزر EN/ع يبدّل النص واللغة والاتجاه" : brief.lang === "en" ? "English, LTR" : "العربية RTL (dir=rtl, lang=ar)";
  return {
    ...(keepItems ? { existing_items: keepItems } : {}), ...((prevSD?.logo || brief.logo) ? { logo: prevSD?.logo || brief.logo } : {}), ...((prevSD?.cur || brief.cur) ? { currency: prevSD?.cur || brief.cur } : {}),
    ...(Array.isArray(brief.banners) && brief.banners.length ? { banners: brief.banners.slice(0, 6).map((b: any) => ({ text: String(b?.t ?? "").slice(0, 140), image: /^https:\/\/[^\s"'()<>]+$/.test(b?.img ?? "") ? b.img : "", link: /^(https?:\/\/|#)[^\s"'<>]+$/.test(b?.u ?? "") ? b.u : "" })) } : {}),
    name: brief.name ?? site.name, tagline: brief.tag ?? "", description: brief.desc ?? "", business_type: site.site_type,
    audience: brief.aud ?? "", main_goal: brief.goal ?? "", tone: brief.tone ?? "", selling_points: String(brief.usp ?? "").split("\n").map((x: string) => x.trim()).filter(Boolean),
    inspiration: brief.insp ?? "", customer_notes: brief.notes ?? "",
    language: lang, main_color: brief.color ?? "", design_style: brief.style ?? "",
    phone: ph ? "+" + ph : "", whatsapp: wa ? "+" + wa : "", email: brief.email ?? "", address: brief.addr ?? "", hours: brief.hours ?? "",
    instagram: brief.ig ?? "", facebook: brief.fb ?? "", tiktok: brief.tt ?? "", telegram: brief.tg ?? "",
    offerings: String(brief.items ?? "").split("\n").map((x: string) => x.trim()).filter(Boolean),
  };
}

async function prompts(type: string): Promise<string> {
  const key = ({ restaurant: "restaurant", store: "store", company: "company", app: "app" } as Record<string, string>)[type] ?? "landing";
  const { data } = await db.from("ai_prompts").select("key,body").in("key", ["master", key]);
  const m = key === "app" ? "" : ((data ?? []).find((x: any) => x.key === "master")?.body ?? "");
  const t = (data ?? []).find((x: any) => x.key === key)?.body ?? (key === "app" ? APP_PROMPT : "");
  return [m, t, ADDENDUM].filter(Boolean).join("\n\n---\n\n");
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
  const { data: prof } = await db.from("profiles").select("role,status,apps_access").eq("id", user.id).maybeSingle();
  if (!prof || prof.status !== "active") return json({ error: "account_inactive" }, 403);
  const isAdmin = ["super_admin", "admin"].includes(prof.role);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  try {
    // ---- Admin: connect a provider with ONE key (discover its real models, pick the right ones, test, enable) ----
    //      "models" does the same for an already-connected provider (re-detect after a provider releases new models).
    if (body.action === "connect" || body.action === "models") {
      if (prof.role !== "super_admin") return json({ error: "forbidden" }, 403);
      let target: Target, key = "", provider: any = null, curlModel = String(body.model ?? "").trim().slice(0, 120), switched: string | null = null;
      // every failure is explained to the admin AND recorded (without the key) so it can be diagnosed afterwards
      const fail = async (error: string, extra: Record<string, unknown> = {}) => {
        try { await db.from("audit_logs").insert({ actor_id: user.id, action: "ai_provider.connect_failed", entity: "ai_providers", meta: { error, ...extra, kind: body.kind ?? null, via: body.curl ? "curl" : "key", key_len: key.length, key_head: key.slice(0, 4) } }); } catch { /* never block the answer */ }
        return json({ ok: false, error, ...extra });
      };
      if (body.action === "models") {
        const { data: p } = await db.from("ai_providers").select("*").eq("id", body.provider_id).maybeSingle();
        if (!p || !p.secret_id) return json({ ok: false, error: "provider_or_key_missing" });
        const { data: k } = await db.rpc("get_provider_key", { p_provider: p.id });
        if (!k) return json({ ok: false, error: "provider_or_key_missing" });
        provider = p; target = { kind: p.kind as Kind, endpoint: p.endpoint, name: p.name }; key = k;
      } else if (typeof body.curl === "string" && body.curl.trim()) {
        // the admin pasted a full curl command: take the URL, key and model from it
        const c = parseCurl(body.curl.slice(0, 20_000));
        if ("error" in c) return fail(c.error);
        const tg = targetFromCurl(c);
        if ("error" in tg) return fail(tg.error);
        target = tg; key = c.key; curlModel = c.model || curlModel;
        if (key.length < 8 || key.length > 500 || /\s/.test(key)) return fail("curl_no_key");
      } else {
        key = cleanKey(body.key);
        if (key.length < 8 || key.length > 500 || /\s/.test(key)) return fail("invalid_key_format");
        let pick = String(body.kind ?? "");
        const seen = detectPick(key);
        if (seen && seen !== pick) { switched = seen; pick = seen; }   // e.g. a Groq key pasted under OpenAI: use the right provider
        const tg = pick === "custom" ? ({ kind: "custom", endpoint: safeEndpoint(String(body.endpoint ?? "")), name: String(body.name ?? "").trim().slice(0, 40) || "Custom" } as Target) : resolveTarget(pick);
        if (!tg) return fail("bad_kind");
        if (tg.kind === "custom" && !tg.endpoint) return fail("endpoint_required");
        target = tg;
      }
      const kind = target.kind, endpoint = target.endpoint;

      // 1) ask the provider which models this key can really use
      const rq = modelsRequest(kind, endpoint, key);
      let found: Found[] = [];
      try {
        const r = await fetch(rq.url, { headers: rq.headers, signal: AbortSignal.timeout(15_000) });
        if (!r.ok) {
          const detail = (await r.text()).slice(0, 300);
          if (provider) await db.from("ai_providers").update({ health: "down", checked_at: new Date().toISOString(), last_error: `models status ${r.status}: ${detail}`.slice(0, 500) }).eq("id", provider.id);
          // some providers have no model-list endpoint: when the curl named a model, trust it and let the real test call decide
          if (curlModel && [400, 404, 405, 422, 501].includes(r.status)) found = [{ id: curlModel, created: 0 }];
          else return fail(listError(r.status), { status: r.status, hint: keyHint(kind, key), detail, provider: target.name });
        } else found = parseModels(kind, await r.json());
      } catch (e) { return fail("unreachable", { detail: String((e as Error).message).slice(0, 200), provider: target.name }); }
      if (curlModel && !found.some((f) => f.id === curlModel)) found.push({ id: curlModel, created: 0 });
      const ranked = rankModels(kind, found);
      if (!ranked.length) return fail("no_models", { provider: target.name });
      // the model named in the curl is always enabled
      if (curlModel) { const m = ranked.find((x) => x.id === curlModel); if (m) m.selected = true; }

      // 2) one provider per kind (no more duplicates); store the key as the signed-in super admin
      if (!provider) {
        let q = db.from("ai_providers").select("*").eq("kind", kind).order("created_at", { ascending: true }).limit(1);
        if (kind === "custom") q = q.eq("endpoint", endpoint);
        const { data: ex } = await q;
        provider = ex?.[0] ?? null;
        if (!provider) {
          const ins = await db.from("ai_providers").insert({ name: target.name, kind, endpoint, priority: 100, enabled: true }).select().single();
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
      return json({ ok: true, switched, provider: { id: provider.id, name: provider.name, kind }, models: ranked.map((m: Ranked) => ({ id: m.id, role: m.role, tier: m.tier, enabled: en.get(m.id) ?? false })), tested });
    }

    // ---- Expo (React Native) app builder: super admin + users the super admin enabled ----
    if (typeof body.action === "string" && body.action.startsWith("app_")) {
      if (!(prof.role === "super_admin" || prof.apps_access)) return json({ error: "forbidden" }, 403);
      const { data: site } = await db.from("websites").select("id,owner_id,name,site_type,config").eq("id", body.website_id).maybeSingle();
      if (!site || site.site_type !== "app") return json({ error: "website_not_found" }, 404);
      if (site.owner_id !== user.id && prof.role !== "super_admin") return json({ error: "forbidden" }, 403);
      const app0 = site.config?.app ?? {};
      const files: Record<string, string> = { ...(app0.files ?? {}) };
      if (!Object.keys(files).length && typeof app0.code === "string" && app0.code) files["App.js"] = app0.code;   // older single-file apps
      const codePaths = Object.keys(files).filter(isCodePath);
      const plan = app0.plan ?? null;
      const state = () => ({ plan: plan ? { name: plan.name, summary: plan.summary, screens: plan.screens, colors: plan.colors, features: plan.features } : null, files: codePaths.map((p) => ({ path: p, exports: exportsOf(files[p]) })) });
      const save = async (app: Record<string, unknown>, note: string, snapFiles = false) => {
        await db.from("websites").update({ name: (app.name as string) ?? site.name, config: { ...(site.config ?? {}), app }, updated_at: new Date().toISOString() }).eq("id", site.id);
        if (!snapFiles) return;
        const { data: vv } = await db.from("website_versions").select("version").eq("website_id", site.id).order("version", { ascending: false }).limit(1);
        await db.from("website_versions").insert({ website_id: site.id, version: (vv?.[0]?.version ?? 0) + 1, snapshot: { app: { files: app.files, plan: app.plan } }, note: note.slice(0, 150), created_by: user.id });
      };

      // 1) chat: one question only if essential, otherwise a plan (new app) or the list of files to change (existing app)
      if (body.action === "app_chat") {
        const message = String(body.message ?? "").trim().slice(0, 3000);
        if (message.length < 2) return json({ error: "invalid_messages" }, 400);
        const chat = Array.isArray(app0.chat) ? app0.chat : [];
        const history = chat.slice(-8).map((m: any) => ({ role: m.role === "user" ? "user" as const : "assistant" as const, content: String(m.content ?? "").slice(0, 800) }));
        const r = await runAI({ task: "ui", json: true, rules: true, userId: user.id, siteId: site.id, maxTokens: 1800, deadlineMs: 90_000, messages: [{ role: "system", content: APP_CHAT_PROMPT }, ...history, { role: "user", content: JSON.stringify({ app: state(), message }) }] });
        const out = parseJSON(r.text) ?? {};
        const type = ["question", "plan", "edit", "answer"].includes(out.type) ? out.type : "answer";
        const text = String(out.text ?? "").trim().slice(0, 1200) || (type === "plan" ? "هذه خطة تطبيقك" : "تم");
        const reply: Record<string, unknown> = { role: "assistant", content: text, type };
        if (type === "plan") reply.plan = cleanPlan(out.plan);
        if (type === "edit") reply.files = (Array.isArray(out.files) ? out.files : []).slice(0, 8).map((f: any) => ({ path: String(f?.path ?? "").slice(0, 80), purpose: String(f?.purpose ?? "").slice(0, 200) })).filter((f: any) => isCodePath(f.path));
        if (type === "edit" && !(reply.files as unknown[]).length) reply.type = "answer";
        await save({ ...app0, files, chat: [...chat, { role: "user", content: message }, reply].slice(-60) }, "");
        return json({ ok: true, ...reply, model: r.model });
      }

      // 2) one file at a time (keeps every request inside a free provider's per-minute token limit)
      if (body.action === "app_file") {
        const path = String(body.path ?? "");
        if (!isCodePath(path)) return json({ error: "bad_path" }, 400);
        const p = cleanPlan(body.plan ?? plan ?? {});
        const all = new Set([...codePaths, ...p.files.map((f: any) => f.path), ...(Array.isArray(body.paths) ? body.paths.filter((x: unknown) => typeof x === "string" && isCodePath(x as string)) : [])]);
        const ctx = { plan: { name: p.name, summary: p.summary, screens: p.screens, colors: p.colors, features: p.features }, files: [...all].map((f) => ({ path: f, purpose: p.files.find((x: any) => x.path === f)?.purpose ?? "", exports: files[f] ? exportsOf(files[f]) : "" })), file: path, purpose: String(body.purpose ?? "").slice(0, 300), request: String(body.request ?? "").slice(0, 1500) };
        const cur = files[path] && files[path].length < 9000 ? "\n\nالمحتوى الحالي للملف (عدّله وأعده كاملاً):\n```jsx\n" + files[path] + "\n```" : "";
        const r = await runAI({ task: "ui", rules: true, userId: user.id, siteId: site.id, maxTokens: 3400, deadlineMs: 100_000, messages: [{ role: "system", content: APP_FILE_PROMPT }, { role: "user", content: JSON.stringify(ctx) + cur }] });
        const code = extractCode(r.text);
        if (!code) return json({ ok: false, error: "invalid_output", detail: "no_code" });
        const bad = validFile(path, code, all);
        if (bad) return json({ ok: false, error: "invalid_output", detail: bad });
        return json({ ok: true, path, code, model: r.model });
      }

      // 3) commit the written files: validated together, config files generated, version saved, files stored for Expo Go
      if (body.action === "app_commit") {
        const inFiles = body.files && typeof body.files === "object" ? body.files as Record<string, unknown> : {};
        const merged = { ...files };
        for (const [k, v] of Object.entries(inFiles)) if (isCodePath(k) && typeof v === "string") merged[k] = v;
        const all = new Set(Object.keys(merged).filter(isCodePath));
        for (const k of all) { const bad = validFile(k, merged[k], all); if (bad) return json({ ok: false, error: "invalid_output", detail: k + ": " + bad }, 422); }
        if (!all.has("App.js")) return json({ ok: false, error: "invalid_output", detail: "App.js missing" }, 422);
        const p = body.plan ? cleanPlan(body.plan) : plan;
        const name = p?.name ?? site.name, slug = app0.slug ?? slugOf(String(name), site.id);
        const code = Object.fromEntries([...all].map((k) => [k, merged[k]]));
        const full = { ...code, ...projectConfig({ name, slug, plan: p }, code) };
        const rev = (Number(app0.rev) || 0) + 1;
        const chat = Array.isArray(app0.chat) ? app0.chat : [];
        const note = String(body.note ?? "").slice(0, 300);
        await save({ ...app0, name, slug, plan: p, files: full, rev, chat: note ? [...chat, { role: "assistant", content: note, type: "built", rev }].slice(-60) : chat }, "app: " + note, true);
        for (const [k, v] of Object.entries(full)) await db.storage.from("app-files").upload(`${site.id}/${rev}/${k}`, new Blob([v], { type: "text/plain" }), { upsert: true, contentType: "text/plain" });
        return json({ ok: true, rev, files: Object.keys(full), deps: depsOf(code) });
      }

      // 4) "View in Expo Go": a Snack link whose files are short-lived signed links to this revision
      if (body.action === "app_snack") {
        const rev = Number(app0.rev) || 0;
        if (!rev || !codePaths.length) return json({ ok: false, error: "no_build_yet" }, 409);
        const paths = codePaths;
        const { data: signed } = await db.storage.from("app-files").createSignedUrls(paths.map((k) => `${site.id}/${rev}/${k}`), 7 * 24 * 3600);
        const urls: Record<string, string> = {};
        (Array.isArray(signed) ? signed : []).forEach((x: any, i: number) => { if (x?.signedUrl) urls[paths[i]] = x.signedUrl; });
        if (Object.keys(urls).length !== paths.length) return json({ ok: false, error: "storage_error" }, 502);
        const deps = depsOf(Object.fromEntries(paths.map((k) => [k, files[k]])));
        const nm = String(app0.name ?? site.name);
        let share = String(app0.share ?? "");
        if (!/^[a-f0-9]{32}$/.test(share)) { share = crypto.randomUUID().replace(/-/g, ""); await save({ ...app0, share }, ""); }
        const go = `${Deno.env.get("SUPABASE_URL")}/functions/v1/app-export?go=${site.id}&k=${share}`;
        return json({ ok: true, url: snackUrl(nm, urls, deps, "mydevice"), embed: snackUrl(nm, urls, deps, "web"), go, rev });
      }

      // 5) store builds (EAS) through the GitHub workflow .github/workflows/eas-build.yml — super admin only
      if (body.action === "app_build") {
        if (prof.role !== "super_admin") return json({ error: "forbidden" }, 403);
        if (!(Number(app0.rev) > 0)) return json({ ok: false, error: "no_build_yet" }, 409);
        const platform = body.platform === "ios" ? "ios" : "android", profile = body.profile === "production" ? "production" : "preview";
        const { data: gh } = await db.rpc("get_integration_secret", { p_name: "github_token" });
        if (!gh) return json({ ok: false, error: "build_not_configured" }, 409);
        const repo = (await setting("apps.build_repo")) || "ibtkarly-ops/Ibtkar-", ref = (await setting("apps.build_ref")) || "main";
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ ok: false, error: "build_not_configured" }, 409);
        const run = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
        const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/eas-build.yml/dispatches`, {
          method: "POST", signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${gh}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ibtikar-platform", "content-type": "application/json" },
          body: JSON.stringify({ ref, inputs: { app_id: site.id, platform, profile, run } }),
        }).catch(() => null);
        if (!res || res.status !== 204) return json({ ok: false, error: "build_dispatch_failed", detail: res ? String(res.status) : "network" }, 502);
        const builds = Array.isArray(app0.builds) ? app0.builds : [];
        await save({ ...app0, builds: [{ id: "", run, platform, profile, status: "queued", url: "", page: "", at: new Date().toISOString() }, ...builds].slice(0, 20) }, "");
        await db.from("audit_logs").insert({ actor_id: user.id, action: "app.build", entity: "websites", meta: { id: site.id, platform, profile, run } });
        return json({ ok: true, run });
      }
      return json({ error: "unknown_action" }, 400);
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
      const ph = intl(brief.phone), wa = intl(brief.wa) || ph;
      const sdm = /<script[^>]*id=["']site-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(site.config?.html ?? "");
      let prevSD: any = null;
      try { prevSD = sdm ? JSON.parse(sdm[1]) : null; } catch { /* ignore */ }
      const keepItems = prevSD && !prevSD.sample && Array.isArray(prevSD.items) && prevSD.items.length ? prevSD.items.slice(0, 60) : null;
      const reqs = requirements(brief, site.site_type, !!(ph || wa));
      const data = { ...briefData(brief, site, ph, wa, prevSD, keepItems), ...(site.config?.plan ? { design_plan: site.config.plan } : {}), must_have: reqs.map((r) => r.rule) };
      const sys = await prompts(site.site_type);
      const r = await runAI({ task: "ui", userId: user.id, siteId: site.id, maxTokens: 14000, messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(data) }] });
      const html = cleanHtml(r.text);
      if (!validHtml(html, brief, SD_TYPES.includes(site.site_type))) return json({ ok: false, error: "invalid_output", detail: "page_failed_validation" }, 200);
      const cfg = { ...(site.config ?? {}), html };
      await db.from("websites").update({ config: cfg, updated_at: new Date().toISOString() }).eq("id", site.id);
      const { data: vv } = await db.from("website_versions").select("version").eq("website_id", site.id).order("version", { ascending: false }).limit(1);
      await db.from("website_versions").insert({ website_id: site.id, version: (vv?.[0]?.version ?? 0) + 1, snapshot: { html }, note: "design", created_by: user.id });
      return json({ ok: true, model: r.model, missing: missingOf(reqs, html).map((x) => x.id) });
    }

    // ---- Creative plan first (fast): headline, copy, banner, sections - stored and fed to the build ----
    if (body.action === "plan") {
      const { data: site } = await db.from("websites").select("id,owner_id,org_id,name,site_type,config").eq("id", body.website_id).maybeSingle();
      if (!site) return json({ error: "website_not_found" }, 404);
      if (!(await canAccess(user.id, prof.role, site))) return json({ error: "forbidden" }, 403);
      const brief = site.config?.brief ?? {};
      const ph = intl(brief.phone), wa = intl(brief.wa) || ph;
      const r = await runAI({ task: "classify", userId: user.id, siteId: site.id, maxTokens: 3500, messages: [{ role: "system", content: PLAN_PROMPT }, { role: "user", content: JSON.stringify(briefData(brief, site, ph, wa, null, null)) }] });
      const plan = parseJson(r.text);
      if (!plan || typeof plan !== "object") return json({ ok: false, error: "invalid_output", detail: "plan_unparseable" });
      await db.from("websites").update({ config: { ...(site.config ?? {}), plan } }).eq("id", site.id);
      return json({ ok: true, model: r.model });
    }

    // ---- Repair: add only what the customer asked for and the page lacks (own time budget) ----
    if (body.action === "repair") {
      const { data: site } = await db.from("websites").select("id,owner_id,org_id,name,site_type,config").eq("id", body.website_id).maybeSingle();
      if (!site) return json({ error: "website_not_found" }, 404);
      if (!(await canAccess(user.id, prof.role, site))) return json({ error: "forbidden" }, 403);
      const brief = site.config?.brief ?? {};
      const ph = intl(brief.phone), wa = intl(brief.wa) || ph;
      const cur = site.config?.html ?? "";
      const reqs = requirements(brief, site.site_type, !!(ph || wa));
      const miss = missingOf(reqs, cur);
      if (!miss.length) return json({ ok: true, missing: [] });
      if (cur.length > 150_000) return json({ ok: false, error: "page_too_large_for_edit" });
      const sys = (await prompts(site.site_type)) + "\n\n---\n\nوضع الإصلاح: الصفحة التالية ينقصها بنود طلبها العميل صراحةً. أضف البنود الناقصة فقط (بالمعرّفات المذكورة) وأبقِ كل شيء آخر كما هو حرفياً بما فيه كتلة site-data. أعد وثيقة HTML كاملة فقط.";
      const r = await runAI({ task: "ui", userId: user.id, siteId: site.id, maxTokens: 14000, messages: [{ role: "system", content: sys }, { role: "user", content: "CURRENT_HTML:\n" + cur + "\n\nMISSING_REQUIREMENTS:\n" + miss.map((m) => "- " + m.rule).join("\n") }] });
      const html = cleanHtml(r.text);
      if (!validHtml(html, brief, SD_TYPES.includes(site.site_type))) return json({ ok: false, error: "invalid_output", detail: "repair_failed_validation", missing: miss.map((x) => x.id) });
      await db.from("websites").update({ config: { ...(site.config ?? {}), html }, updated_at: new Date().toISOString() }).eq("id", site.id);
      const { data: vv } = await db.from("website_versions").select("version").eq("website_id", site.id).order("version", { ascending: false }).limit(1);
      await db.from("website_versions").insert({ website_id: site.id, version: (vv?.[0]?.version ?? 0) + 1, snapshot: { html }, note: "repair: " + miss.map((x) => x.id).join(","), created_by: user.id });
      return json({ ok: true, model: r.model, missing: missingOf(reqs, html).map((x) => x.id) });
    }

    // ---- Read a site's spec (brief + items) for the design/edit actions ----
    const loadSpec = async (id: unknown) => {
      const { data: site } = await db.from("websites").select("id,owner_id,org_id,name,site_type,status,config").eq("id", id).maybeSingle();
      if (!site || site.site_type === "app") return { error: json({ error: "website_not_found" }, 404) };
      if (!(await canAccess(user.id, prof.role, site))) return { error: json({ error: "forbidden" }, 403) };
      const bd = await budget(site.id, site.owner_id);
      if (!bd.ok) return { error: json({ error: "budget_exceeded" }, 402) };
      const { _data, ...brief } = { name: site.name, type: site.site_type, ...(site.config?.brief ?? {}) };
      const sdm = /<script[^>]*id=["']site-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(site.config?.html ?? "");
      let sd: any = null;
      try { sd = sdm ? JSON.parse(sdm[1]) : null; } catch { /* no items */ }
      return { site, brief, sd };
    };
    const img = ownImage(Deno.env.get("SUPABASE_URL") ?? "https://invalid.local");
    const siteLang = (b: any) => (b.lang === "en" ? "English" : "العربية");

    // ---- New site: the AI writes all the copy (small JSON); the page engine renders the design ----
    if (body.action === "design") {
      const L0 = await loadSpec(body.website_id);
      if (L0.error) return L0.error;
      const { site, brief, sd } = L0;
      if (prof.role === "customer") {
        const limit = await monthlyLimit(site.owner_id);
        const { count } = await db.from("ai_usage").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "ok").gte("created_at", monthStart());
        if ((count ?? 0) >= limit) return json({ error: "quota_exceeded", limit }, 429);
      }
      const needs = !(sd && !sd.sample && Array.isArray(sd.items) && sd.items.length) && !String(brief.items ?? "").trim();
      const info = {
        name: brief.name, business_type: site.site_type, tagline: brief.tag ?? "", description: brief.desc ?? "", language: siteLang(brief),
        audience: brief.aud ?? "", main_goal: brief.goal ?? "", tone: brief.tone ?? "", selling_points: String(brief.usp ?? "").split("\n").map((x: string) => x.trim()).filter(Boolean).slice(0, 6),
        notes: String(brief.notes ?? "").slice(0, 600), hours: brief.hours ?? "", address: brief.addr ?? "",
        offerings: String(brief.items ?? "").split("\n").map((x: string) => x.split("|")[0].trim()).filter(Boolean).slice(0, 12), needs_items: needs,
      };
      const r = await runAI({ task: "ui", json: true, userId: user.id, siteId: site.id, maxTokens: 2600, deadlineMs: 100_000, rules: true, messages: [{ role: "system", content: DESIGN_PROMPT }, { role: "user", content: JSON.stringify(info) }] });
      const out = parseJSON(r.text);
      if (!out || typeof out !== "object") return json({ ok: false, error: "invalid_output", detail: "design_unparseable" });
      const copy = cleanCopy(out.copy, img);
      if (!copy.hero) return json({ ok: false, error: "invalid_output", detail: "design_missing_hero" });
      const items = needs ? cleanItems(out.items, img).map((x) => ({ ...x, p: "" })) : [];
      return json({ ok: true, copy, items: items.length >= 3 ? items : null, model: r.model });
    }

    // ---- Instant edit: the customer (or the admin chat) describes a change, the AI returns a small patch,
    //      validated here; the browser re-renders, saves a version (undo) and re-publishes ----
    if (body.action === "edit") {
      const instruction = String(body.instruction ?? "").trim().slice(0, 1500);
      if (instruction.length < 2) return json({ error: "invalid_messages" }, 400);
      const L0 = await loadSpec(body.website_id);
      if (L0.error) return L0.error;
      const { site, brief, sd } = L0;
      const staff = ["super_admin", "admin", "technical_manager", "developer"].includes(prof.role);
      if (!staff) {
        const perDay = Number(await setting("ai.edits_per_day") ?? 20) || 20;
        const day = new Date(); day.setUTCHours(0, 0, 0, 0);
        const { count } = await db.from("modification_requests").select("id", { count: "exact", head: true }).eq("website_id", site.id).eq("status", "done").gte("created_at", day.toISOString());
        if ((count ?? 0) >= perDay) return json({ error: "edits_limit", limit: perDay }, 429);
      }
      const history = (cleanMessages(body.history) ?? []).filter((m) => m.role !== "system").slice(-6).map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
      const items = sd && Array.isArray(sd.items) ? sd.items.slice(0, 60).map((x: any) => ({ n: x.n, c: x.c, p: x.p, d: x.d, ...(x.img ? { img: x.img } : {}) })) : [];
      const { aud, goal, insp, notes, items: _txt, ...specBrief } = brief;
      const choices = JSON.stringify(body.choices ?? {}).slice(0, 1500);
      const user0 = JSON.stringify({ spec: { brief: specBrief, items, sample_items: !!(sd && sd.sample) }, choices: JSON.parse(choices.length < 1500 ? choices : "{}"), request: instruction });
      const r = await runAI({ task: "ui", json: true, userId: user.id, siteId: site.id, maxTokens: 3000, deadlineMs: 100_000, rules: true, messages: [{ role: "system", content: EDIT_PROMPT }, ...history, { role: "user", content: user0 }] });
      const out = parseJSON(r.text);
      if (!out || typeof out !== "object") return json({ ok: false, error: "invalid_output", detail: "edit_unparseable" });
      const res = applyPatch({ brief, items }, out.patch, img);
      const reply = String(out.reply ?? "").trim().slice(0, 600) || "تم";
      await db.from("modification_requests").insert({ website_id: site.id, user_id: user.id, description: instruction, status: "done", level: "simple", estimated_price: 0, final_price: 0, ai_reason: reply.slice(0, 300) });
      await db.from("audit_logs").insert({ actor_id: user.id, action: "website.ai_edit", entity: "websites", meta: { id: site.id, model: r.model, redesign: res.redesign, items: !!res.items } });
      return json({ ok: true, reply, brief: res.brief, items: res.items, redesign: res.redesign, model: r.model });
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
