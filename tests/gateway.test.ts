// Runs the REAL supabase/functions/ai-gateway/index.ts in-process against an in-memory fake of
// PostgREST + Auth and fake AI providers (global fetch is replaced, nothing touches the network).
//   deno test -A --no-check tests/gateway.test.ts
const SUPA = "https://fake.supabase.co";
Deno.env.set("SUPABASE_URL", SUPA);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");

// ---------- in-memory database ----------
type Row = Record<string, any>;
let T: Record<string, Row[]>;
let secrets: Record<string, string>;
let seq = 0;
const log: { url: string; method: string; body?: any; auth?: string }[] = [];
let providerBehavior: (req: { url: string; headers: Headers; body: any }) => { status: number; body: any };

function reset() {
  seq = 0; secrets = {}; log.length = 0;
  T = {
    profiles: [{ id: "admin", role: "super_admin", status: "active" }, { id: "cust", role: "customer", status: "active" }],
    ai_providers: [], ai_models: [], ai_usage: [], audit_logs: [], platform_settings: [], subscriptions: [], plans: [{ code: "free", ai_requests_limit: 50, price: 0 }],
    ai_prompts: [{ key: "master", body: "MASTER" }, { key: "company", body: "COMPANY" }],
    websites: [{ id: "site1", owner_id: "cust", org_id: null, name: "الملكي", site_type: "company", config: { brief: { name: "الملكي", phone: "0912345678" } } }],
    website_versions: [],
  };
}
const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

function matches(row: Row, params: URLSearchParams) {
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset", "columns"].includes(k)) continue;
    const val = row[k];
    if (v.startsWith("eq.")) { if (String(val) !== v.slice(3)) return false; }
    else if (v === "not.is.null") { if (val === null || val === undefined) return false; }
    else if (v.startsWith("in.(")) { if (!v.slice(4, -1).split(",").includes(String(val))) return false; }
    else if (v.startsWith("gte.")) { if (!(String(val) >= v.slice(4))) return false; }
  }
  return true;
}
function rest(req: Request, url: URL, body: any) {
  const table = url.pathname.split("/")[3];
  const rows = (T[table] ??= []);
  const accept = req.headers.get("accept") ?? "";
  const pref = req.headers.get("prefer") ?? "";
  if (req.method === "GET" || req.method === "HEAD") {
    let out = rows.filter((r) => matches(r, url.searchParams));
    const ord = url.searchParams.get("order");
    if (ord) { const [c, d] = ord.split("."); out = [...out].sort((a, b) => (a[c] > b[c] ? 1 : -1) * (d === "desc" ? -1 : 1)); }
    const lim = url.searchParams.get("limit"); if (lim) out = out.slice(0, Number(lim));
    const range = { "content-range": `0-${Math.max(out.length - 1, 0)}/${out.length}` };
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: range });
    if (accept.includes("vnd.pgrst.object")) return out.length === 1 ? ok(out[0]) : ok({ code: "PGRST116", message: "rows" }, 406);
    return ok(out, 200, range);
  }
  if (req.method === "POST") {
    const list = (Array.isArray(body) ? body : [body]).map((b) => ({ id: `${table}-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...b }));
    rows.push(...list);
    if (!pref.includes("return=representation")) return new Response(null, { status: 201 });
    return accept.includes("vnd.pgrst.object") ? ok(list[0], 201) : ok(list, 201);
  }
  if (req.method === "PATCH") {
    const hit = rows.filter((r) => matches(r, url.searchParams)); hit.forEach((r) => Object.assign(r, body));
    return pref.includes("return=representation") ? ok(hit) : new Response(null, { status: 204 });
  }
  if (req.method === "DELETE") { T[table] = rows.filter((r) => !matches(r, url.searchParams)); return new Response(null, { status: 204 }); }
  return ok({}, 405);
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  let body: any = null;
  try { const t = await req.clone().text(); body = t ? JSON.parse(t) : null; } catch { /* not json */ }
  log.push({ url: req.url, method: req.method, body, auth: req.headers.get("authorization") ?? undefined });
  if (url.origin === SUPA) {
    if (url.pathname === "/auth/v1/user") {
      const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      return tok.startsWith("tok-") ? ok({ id: tok.slice(4), email: "x@y.z" }) : ok({ msg: "bad" }, 401);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/")[4];
      if (fn === "get_provider_key") return ok(secrets[body.p_provider] ?? null);
      if (fn === "admin_set_provider_key") {
        const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (tok !== "tok-admin") return ok({ message: "forbidden" }, 400);           // like the real is_super() check
        secrets[body.p_provider] = body.p_key;
        T.ai_providers.find((p) => p.id === body.p_provider)!.secret_id = "sec-" + body.p_provider;
        return new Response(null, { status: 204 });
      }
      return ok(true);
    }
    if (url.pathname.startsWith("/rest/v1/")) return rest(req, url, body);
    return ok({});
  }
  // ---- fake AI providers ----
  const r = providerBehavior({ url: req.url, headers: req.headers, body });
  return ok(r.body, r.status);
}) as typeof fetch;

let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import("../supabase/functions/ai-gateway/index.ts");

async function call(who: string, body: unknown) {
  const res = await handler(new Request(SUPA + "/functions/v1/ai-gateway", { method: "POST", headers: { authorization: "Bearer tok-" + who, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
function assert(c: unknown, msg: string) { if (!c) throw new Error("ASSERT: " + msg); }

// A provider fake: lists models for the right key, answers chats per model.
const ANTHROPIC_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5"].map((id) => ({ id, created_at: "2026-01-01T00:00:00Z" }));
const SD = (items: unknown) => `<section id="items"><div id="items-list"></div></section><script type="application/json" id="site-data">${JSON.stringify({ items })}</script>`;
const GOOD_ITEMS = [{ n: "أ", c: "", p: "", d: "" }, { n: "ب", c: "", p: "", d: "" }, { n: "ج", c: "", p: "", d: "" }];
const HTML = "<!doctype html><html><head><title>الملكي</title></head><body>" + "<p>الملكي 0912345678</p>".repeat(80) + SD(GOOD_ITEMS) + "</body></html>";
const HTML_NO_SD = "<!doctype html><html><head><title>الملكي</title></head><body>" + "<p>الملكي 0912345678</p>".repeat(80) + "</body></html>";
function anthropicFake(opts: { goodKey?: string; failModels?: Record<string, number>; text?: string } = {}) {
  return ({ url, headers, body }: { url: string; headers: Headers; body: any }) => {
    if (url.includes("api.anthropic.com/v1/models")) {
      return headers.get("x-api-key") === (opts.goodKey ?? "sk-ant-good") ? { status: 200, body: { data: ANTHROPIC_MODELS } } : { status: 401, body: { error: { type: "authentication_error", message: "invalid x-api-key" } } };
    }
    if (url.includes("api.anthropic.com/v1/messages")) {
      if (headers.get("x-api-key") !== (opts.goodKey ?? "sk-ant-good")) return { status: 401, body: { error: { message: "invalid x-api-key" } } };
      const code = opts.failModels?.[body.model];
      if (code) return { status: code, body: { error: { message: "overloaded" } } };
      return { status: 200, body: { content: [{ type: "text", text: body.max_tokens <= 16 ? "pong" : (opts.text ?? HTML) }], usage: { input_tokens: 100, output_tokens: 200 } } };
    }
    return { status: 404, body: {} };
  };
}

Deno.test("connect: discovers real models, picks primary+fallbacks, stores key as the admin, tests, enables", async () => {
  reset(); providerBehavior = anthropicFake();
  const r = await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  assert(r.json.ok === true, "connect ok " + JSON.stringify(r.json));
  assert(r.json.tested.ok === true, "test ping ok");
  assert(T.ai_providers.length === 1 && T.ai_providers[0].name === "Claude" && T.ai_providers[0].enabled === true, "one enabled provider");
  assert(T.ai_providers[0].health === "healthy" && T.ai_providers[0].last_error === null, "healthy");
  assert(secrets[T.ai_providers[0].id] === "sk-ant-good", "key stored through admin_set_provider_key as admin");
  const enabled = T.ai_models.filter((m) => m.enabled).map((m) => m.model_id).sort();
  assert(JSON.stringify(enabled) === JSON.stringify(["claude-haiku-5-5", "claude-sonnet-4-5", "claude-sonnet-5-5"]), "enabled models " + enabled);
  assert(T.ai_models.find((m) => m.model_id === "claude-opus-5-5")?.enabled === false, "opus stays off");
  assert(Number(T.ai_models.find((m) => m.model_id === "claude-sonnet-5-5")?.cost_in_per_1m) === 3, "price estimate filled");
});

Deno.test("connect is idempotent: no duplicate provider or models", async () => {
  reset(); providerBehavior = anthropicFake();
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  const before = T.ai_models.length;
  const r = await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  assert(r.json.ok, "second connect ok");
  assert(T.ai_providers.length === 1, "still one provider");
  assert(T.ai_models.length === before, "no duplicate models");
});

Deno.test("bad key: clear error + hint, nothing saved", async () => {
  reset(); providerBehavior = anthropicFake();
  const r = await call("admin", { action: "connect", kind: "anthropic", key: "sk-proj-wrong-provider-key" });
  assert(r.json.ok === false && r.json.error === "invalid_key", "invalid_key " + JSON.stringify(r.json));
  assert(r.json.hint === "wrong_key_for_claude", "hint says it is not a Claude key");
  assert(T.ai_providers.length === 0 && Object.keys(secrets).length === 0, "nothing saved");
});

Deno.test("only the super admin can connect providers", async () => {
  reset(); providerBehavior = anthropicFake();
  const r = await call("cust", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  assert(r.status === 403, "customer forbidden");
});

Deno.test("models: re-detect adds new models and switches off ids the provider does not list (typos)", async () => {
  reset(); providerBehavior = anthropicFake();
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  const pid = T.ai_providers[0].id;
  T.ai_models.push({ id: "m-typo", provider_id: pid, model_id: "claude-sonnet-9-9-luna", enabled: true, usage_type: "general", cost_in_per_1m: 0, cost_out_per_1m: 0 });
  ANTHROPIC_MODELS.push({ id: "claude-haiku-6-0", created_at: "2026-06-01T00:00:00Z" });
  const r = await call("admin", { action: "models", provider_id: pid });
  ANTHROPIC_MODELS.pop();
  assert(r.json.ok, "models ok " + JSON.stringify(r.json));
  assert(T.ai_models.find((m) => m.model_id === "claude-sonnet-9-9-luna")?.enabled === false, "typo model switched off");
  assert(T.ai_models.some((m) => m.model_id === "claude-haiku-6-0"), "new model discovered");
});

Deno.test("build: primary overloaded (503) -> automatically uses the fallback model, provider ends healthy", async () => {
  reset(); providerBehavior = anthropicFake();
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  providerBehavior = anthropicFake({ failModels: { "claude-sonnet-5-5": 503 } });
  const r = await call("cust", { action: "build", website_id: "site1" });
  assert(r.json.ok === true, "build ok " + JSON.stringify(r.json));
  assert(r.json.model === "claude-haiku-5-5", "fell back to haiku, got " + r.json.model);
  assert(T.ai_providers[0].health === "healthy", "health reset after success");
  assert(T.website_versions.length === 1, "version saved");
});

Deno.test("build: provider with a rejected key is tried once and skipped, the next provider answers", async () => {
  reset();
  T.ai_providers.push({ id: "bad", name: "Claude-old", kind: "anthropic", enabled: true, secret_id: "s1", priority: 1, health: "healthy", max_rpm: 60 });
  T.ai_providers.push({ id: "good", name: "Claude", kind: "anthropic", enabled: true, secret_id: "s2", priority: 5, health: "healthy", max_rpm: 60 });
  secrets.bad = "sk-ant-expired"; secrets.good = "sk-ant-good";
  for (const id of ["bad", "good"]) for (const m of ["claude-sonnet-5-5", "claude-haiku-5-5"]) T.ai_models.push({ id: id + m, provider_id: id, model_id: m, enabled: true, usage_type: "general", cost_in_per_1m: 3, cost_out_per_1m: 15 });
  providerBehavior = anthropicFake();
  const r = await call("cust", { action: "build", website_id: "site1" });
  assert(r.json.ok === true, "build ok " + JSON.stringify(r.json));
  const calls401 = log.filter((l) => l.url.includes("/v1/messages") && l.body?.model).length;
  assert(calls401 === 2, "bad provider tried once + good provider once, saw " + calls401);
  assert(T.ai_providers.find((p) => p.id === "bad")!.health === "down", "rejected key marked down");
});

Deno.test("build: everything failing reports all_providers_failed with a readable reason", async () => {
  reset(); providerBehavior = anthropicFake();
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  providerBehavior = anthropicFake({ failModels: { "claude-sonnet-5-5": 503, "claude-haiku-5-5": 503, "claude-sonnet-4-5": 503 } });
  const r = await call("cust", { action: "build", website_id: "site1" });
  assert(r.status === 502 && r.json.error === "all_providers_failed", "all failed " + JSON.stringify(r.json));
  assert(/503/.test(r.json.detail), "detail has the reason: " + r.json.detail);
});

Deno.test("chat without a website is staff-only (was open to every customer)", async () => {
  reset(); providerBehavior = anthropicFake();
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  const c = await call("cust", { action: "chat", messages: [{ role: "user", content: "hi" }] });
  assert(c.status === 403, "customer blocked");
  T.profiles.push({ id: "adm2", role: "admin", status: "active" });
  const a = await call("adm2", { action: "chat", messages: [{ role: "user", content: "hi" }] });
  assert(a.status === 200 && a.json.text, "admin allowed");
});

Deno.test("build: a company page without a valid site-data block is rejected (so the customer can always edit items)", async () => {
  reset();
  for (const bad of [HTML_NO_SD, HTML.replace(/"n":"ب",/, ""), HTML.replace("id=\"items-list\"", "id=\"x\"")]) {
    providerBehavior = anthropicFake({ text: bad });
    await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" }).catch(() => {});
    const r = await call("cust", { action: "build", website_id: "site1" });
    assert(r.json.error === "invalid_output", "rejected: " + JSON.stringify(r.json).slice(0, 120));
    reset();
  }
});

Deno.test("build: our own storage images are allowed, any other remote image is rejected", async () => {
  for (const [img, expected] of [[`${SUPA}/storage/v1/object/public/site-assets/s/a.webp`, true], ["https://evil.example/a.png", false]] as const) {
    reset();
    const page = HTML.replace("</body>", `<img src="${img}" alt=""></body>`);
    providerBehavior = anthropicFake({ text: page });
    await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
    const r = await call("cust", { action: "build", website_id: "site1" });
    assert((r.json.ok === true) === expected, `${img} -> ${JSON.stringify(r.json).slice(0, 100)}`);
  }
});

Deno.test("build: items the customer edited (and logo/currency) are handed to the AI so a rebuild keeps them", async () => {
  reset();
  const items = [{ n: "عطر", c: "عطور", p: "45", d: "", img: "x" }, { n: "ب", p: "" }, { n: "ج", p: "" }];
  T.websites[0].config.html = `<html>${SD(items).replace('{"items"', '{"logo":"L","cur":"د.ل","items"')}</html>`;
  let sent = "";
  const base = anthropicFake();
  providerBehavior = (req) => { if (req.url.includes("/v1/messages") && req.body.max_tokens > 16) sent = JSON.stringify(req.body.messages); return base(req); };
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  await call("cust", { action: "build", website_id: "site1" });
  assert(sent.includes("existing_items") && sent.includes("عطر") && sent.includes("currency"), "existing items passed: " + sent.slice(0, 200));
});

// ---- Groq (OpenAI-compatible) + curl paste + diagnostics ----
const GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "whisper-large-v3", "meta-llama/llama-guard-4-12b"].map((id) => ({ id, created: 1 }));
function groqFake(goodKey = "gsk_GOODKEY123", listStatus = 200) {
  return ({ url, headers }: { url: string; headers: Headers; body: any }) => {
    const good = headers.get("authorization") === "Bearer " + goodKey;
    if (url.endsWith("/models")) return !good ? { status: 401, body: { error: { message: "Invalid API Key" } } } : listStatus !== 200 ? { status: listStatus, body: {} } : { status: 200, body: { data: GROQ_MODELS } };
    if (url.endsWith("/chat/completions")) return good ? { status: 200, body: { choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } } : { status: 401, body: {} };
    return { status: 404, body: {} };
  };
}

Deno.test("groq: a key pasted under the wrong provider is auto-switched to Groq; stored as custom + endpoint; whisper/guard dropped", async () => {
  reset(); providerBehavior = groqFake();
  const r = await call("admin", { action: "connect", kind: "openai", key: "gsk_GOODKEY123" });
  assert(r.json.ok === true && r.json.switched === "groq", "switched to groq: " + JSON.stringify(r.json));
  const p = T.ai_providers[0];
  assert(p.name === "Groq" && p.kind === "custom" && p.endpoint === "https://api.groq.com/openai/v1", "stored as custom groq");
  assert(r.json.models.every((m: any) => !/whisper|guard/.test(m.id)), "non-chat models dropped");
  assert(T.ai_models.some((m) => m.model_id === "llama-3.3-70b-versatile" && m.enabled), "primary enabled");
});

Deno.test("curl: a full curl command is enough (url + key + model are taken from it)", async () => {
  reset(); providerBehavior = groqFake();
  const curl = `curl https://api.groq.com/openai/v1/chat/completions \\\n -H "Authorization: Bearer gsk_GOODKEY123" -H "Content-Type: application/json" \\\n -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}]}'`;
  const r = await call("admin", { action: "connect", curl });
  assert(r.json.ok === true && r.json.tested.ok === true, "curl connect ok " + JSON.stringify(r.json));
  assert(T.ai_providers[0].name === "Groq", "recognised as Groq");
  assert(T.ai_models.some((m) => m.model_id === "llama-3.3-70b-versatile" && m.enabled), "model from the curl enabled");
});

Deno.test("curl: unknown host without a model list endpoint still connects using the model named in the curl", async () => {
  reset();
  providerBehavior = ({ url, headers }) => url.endsWith("/models") ? { status: 404, body: {} } : url.endsWith("/chat/completions") && headers.get("authorization") === "Bearer k-123456789" ? { status: 200, body: { choices: [{ message: { content: "pong" } }] } } : { status: 401, body: {} };
  const r = await call("admin", { action: "connect", curl: `curl https://api.myhost.ai/v1/chat/completions -H "Authorization: Bearer k-123456789" -d '{"model":"my-model-1"}'` });
  assert(r.json.ok === true && r.json.tested.ok === true, "connected via curl model " + JSON.stringify(r.json));
  assert(T.ai_providers[0].endpoint === "https://api.myhost.ai/v1" && T.ai_models[0].model_id === "my-model-1", "custom endpoint + model stored");
});

Deno.test("failures are explained with the provider's own answer AND recorded without the key", async () => {
  reset(); providerBehavior = groqFake();
  const r = await call("admin", { action: "connect", kind: "groq", key: "gsk_WRONGKEY123" });
  assert(r.json.ok === false && r.json.error === "invalid_key" && r.json.status === 401 && /Invalid API Key/.test(r.json.detail), "provider answer shown " + JSON.stringify(r.json));
  const log = T.audit_logs.find((a) => a.action === "ai_provider.connect_failed");
  assert(log && log.meta.status === 401 && log.meta.key_len === 15 && log.meta.key_head === "gsk_", "failure recorded");
  assert(!JSON.stringify(T.audit_logs).includes("WRONGKEY"), "the key itself is never logged");
  assert(T.ai_providers.length === 0, "nothing saved");
  const c = await call("admin", { action: "connect", curl: "not a curl" });
  assert(c.json.error === "curl_not_found", "bad curl explained");
});

// ---- Expo app chat ----
const APP_CODE = "import React, { useState } from 'react';\nimport { View, Text } from 'react-native';\nimport { StatusBar } from 'expo-status-bar';\nimport { Ionicons } from '@expo/vector-icons';\nexport default function App() { const [n] = useState(0); return (<View><Text>مرحبا {n}</Text><StatusBar /><Ionicons name=\"home\" /></View>); }";
const reply = (code: string) => "بنيت لك الشاشة الرئيسية مع شريط تبويب.\n\n```jsx\n" + code + "\n```";
function appSite() { T.websites.push({ id: "app1", owner_id: "admin", org_id: null, name: "تطبيق", site_type: "app", config: {} }); }

Deno.test("app_chat: super admin only; code extracted, validated, saved with the chat", async () => {
  reset(); appSite(); providerBehavior = anthropicFake({ text: reply(APP_CODE) });
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  const deny = await call("cust", { action: "app_chat", website_id: "app1", messages: [{ role: "user", content: "تطبيق حجوزات" }] });
  assert(deny.status === 403, "customer refused");
  const r = await call("admin", { action: "app_chat", website_id: "app1", messages: [{ role: "user", content: "تطبيق حجوزات لعيادة" }] });
  assert(r.json.ok === true && r.json.code.includes("export default") && /بنيت/.test(r.json.reply) && !r.json.reply.includes("```"), "reply split: " + JSON.stringify(r.json).slice(0, 150));
  const saved = T.websites.find((w) => w.id === "app1").config.app;
  assert(saved.code === APP_CODE && saved.chat.length === 2 && saved.chat[0].role === "user", "chat + code saved");
  assert(T.website_versions.some((v) => v.snapshot?.app?.code === APP_CODE), "version recorded");
});

Deno.test("app_chat: imports outside the allow-list and unsafe code are rejected; an edit receives the current code", async () => {
  reset(); appSite();
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" }).catch(() => {});
  for (const bad of [APP_CODE.replace("expo-status-bar", "expo-file-system"), APP_CODE + "\neval('1')", "```jsx\nconst x = 1;\n```", "no code block here"]) {
    providerBehavior = anthropicFake({ text: bad.startsWith("```") || bad === "no code block here" ? bad : reply(bad) });
    if (!T.ai_providers.length) await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
    const r = await call("admin", { action: "app_chat", website_id: "app1", messages: [{ role: "user", content: "x" }] });
    assert(r.json.error === "invalid_output", "rejected: " + JSON.stringify(r.json).slice(0, 120));
  }
  T.websites.find((w) => w.id === "app1").config = { app: { code: APP_CODE, chat: [] } };
  let sent = "";
  const base = anthropicFake({ text: reply(APP_CODE) });
  providerBehavior = (q) => { if (q.url.includes("/v1/messages") && q.body.max_tokens > 16) sent = JSON.stringify(q.body.system); return base(q); };
  const ok = await call("admin", { action: "app_chat", website_id: "app1", messages: [{ role: "user", content: "غيّر اللون" }] });
  assert(ok.json.ok === true && sent.includes("export default function App"), "current code sent as context");
});

// ---- must-have checks, plan and repair ----
Deno.test("build reports which customer-requested features are missing; repair adds them", async () => {
  reset(); T.websites[0].site_type = "store"; T.websites[0].config.brief = { ...T.websites[0].config.brief, banner: "خصم على كل القطع", bg: "aurora", motion: "strong", float: "1", wa: "0912345678", banners: [{ t: "عروض الصيف", img: "https://x.supabase.co/storage/v1/object/public/site-assets/s1/b.webp", u: "javascript:alert(1)" }] };
  providerBehavior = anthropicFake({ text: HTML });   // a plain page: no banner, no animated bg, ...
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  let sent = "";
  const base = anthropicFake({ text: HTML });
  providerBehavior = (q) => { if (q.url.includes("/v1/messages") && q.body.max_tokens > 16) sent = JSON.stringify(q.body.messages); return base(q); };
  const r = await call("cust", { action: "build", website_id: "site1" });
  assert(r.json.ok === true && ["banner", "bg", "motion", "float", "cart"].every((x) => r.json.missing.includes(x)), "missing reported: " + JSON.stringify(r.json));
  assert(sent.includes("promo-banner") && sent.includes("خصم على كل القطع") && sent.includes("must_have"), "requirements sent to the AI with the customer's own banner text");
  assert(sent.includes("cart-btn") && sent.includes("أرسل الطلب عبر واتساب"), "cart requirement sent for a store with WhatsApp");
  assert(sent.includes("banners") && sent.includes("عروض الصيف") && sent.includes("site-assets/s1/b.webp") && !sent.includes("javascript:"), "customer banners (text + own image) sent to the AI, unsafe links dropped");
  const FIXED = HTML.replace("<body>", `<body><div id="promo-banner">x</div><div data-animated-bg="aurora"></div><style>@keyframes a{}</style><script>new IntersectionObserver(()=>{})</script><a id="wa-float" href="https://wa.me/218912345678"></a><button id="cart-btn"></button><aside id="cart"></aside><script>encodeURIComponent("x")</script>`);
  providerBehavior = anthropicFake({ text: FIXED });
  const f = await call("cust", { action: "repair", website_id: "site1" });
  assert(f.json.ok === true && f.json.missing.length === 0, "repaired: " + JSON.stringify(f.json));
  assert(/promo-banner/.test(T.websites[0].config.html), "repaired page saved");
  const again = await call("cust", { action: "repair", website_id: "site1" });
  assert(again.json.ok === true && again.json.missing.length === 0, "nothing to repair the second time");
});

Deno.test("plan: creative plan is generated and stored, then used by the build", async () => {
  reset(); providerBehavior = anthropicFake({ text: '{"headline":"أسرع قطع الباتيناج","banner_text":"عروض الأسبوع","sections":[],"why_us":["أرخص سعر"],"faq":[],"vibe":"حيوي"}' });
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  const r = await call("cust", { action: "plan", website_id: "site1" });
  assert(r.json.ok === true && T.websites[0].config.plan.headline === "أسرع قطع الباتيناج", "plan stored " + JSON.stringify(r.json));
  let sent = "";
  const base = anthropicFake({ text: HTML });
  providerBehavior = (q) => { if (q.url.includes("/v1/messages") && q.body.max_tokens > 16) sent = JSON.stringify(q.body.messages); return base(q); };
  await call("cust", { action: "build", website_id: "site1" });
  assert(sent.includes("design_plan") && sent.includes("أسرع قطع الباتيناج"), "plan fed to the build");
});

Deno.test("a provider with no credit (429 insufficient_quota) is skipped after one try, the next provider answers", async () => {
  reset();
  providerBehavior = ({ url, headers }) => {
    if (url.includes("api.openai.com/v1/models")) return { status: 200, body: { data: ["gpt-5", "gpt-5-mini", "gpt-5-pro"].map((id) => ({ id, created: 1 })) } };
    if (url.includes("api.openai.com")) return { status: 429, body: { error: { message: "You have no credits remaining", code: "credit_balance_exhausted", type: "insufficient_quota" } } };
    return anthropicFake()({ url, headers, body: {} } as any);
  };
  await call("admin", { action: "connect", kind: "openai", key: "sk-proj-abc12345" });
  providerBehavior = ({ url, headers, body }) => url.includes("api.openai.com") ? { status: 429, body: { error: { message: "You have no credits remaining", type: "insufficient_quota" } } } : anthropicFake()({ url, headers, body });
  T.ai_providers[0].priority = 1; T.ai_providers[0].health = "healthy"; T.ai_providers[0].last_error = null;   // OpenAI is tried first
  T.ai_providers.push({ id: "p-claude", name: "Claude", kind: "anthropic", endpoint: null, priority: 100, enabled: true, health: "healthy", secret_id: "s-claude", max_rpm: 60, created_at: "2026-01-01" });
  secrets["p-claude"] = "sk-ant-good";
  T.ai_models.push({ id: "mm", provider_id: "p-claude", model_id: "claude-sonnet-5-5", usage_type: "general", enabled: true, cost_in_per_1m: 0, cost_out_per_1m: 0 });
  const r = await call("cust", { action: "build", website_id: "site1" });
  assert(r.json.ok === true && /claude/.test(r.json.model), "claude answered: " + JSON.stringify(r.json));
  const openaiTries = T.ai_usage.filter((u) => u.status === "error" && /gpt/.test(u.model)).length;
  assert(openaiTries === 1, "OpenAI tried once, not once per model (" + openaiTries + ")");
});

// ---- design / edit: the AI returns small JSON, validated before use (no HTML, fits free providers) ----
Deno.test("design: AI copy is validated; sample items generated without prices only when the site has none", async () => {
  reset();
  const reply = { copy: { hero: { t: "عنوان", s: "وصف" }, why: [{ t: "أ", d: "ب" }], faq: [{ q: "س", a: "ج" }, { q: "", a: "x" }], sections: [{ type: "evil", body: "نص" }] }, items: [{ n: "أ", p: "99" }, { n: "ب" }, { n: "ج" }, { n: "" }] };
  let req: any = null;
  const base = anthropicFake({ text: JSON.stringify(reply) });
  providerBehavior = (r) => { if (r.url.includes("/v1/messages") && r.body.max_tokens > 16) req = r.body; return base(r); };
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  const r = await call("cust", { action: "design", website_id: "site1" });
  assert(r.json.ok && r.json.copy.hero.t === "عنوان", "copy " + JSON.stringify(r.json));
  assert(r.json.copy.faq.length === 1, "empty faq dropped");
  assert(r.json.copy.sections[0].type === "text", "unknown section type falls back to text");
  assert(r.json.items.length === 3 && r.json.items.every((x: any) => x.p === ""), "3 items, prices stripped");
  assert(req.max_tokens <= 3000, "small output budget: " + req.max_tokens);
  assert(!T.websites[0].config.html, "design does not write HTML itself");
});

Deno.test("design: a site that already has its own items gets no invented ones", async () => {
  reset();
  T.websites[0].config.html = `<html>${SD([{ n: "عطر" }, { n: "ب" }, { n: "ج" }])}</html>`;
  providerBehavior = anthropicFake({ text: JSON.stringify({ copy: { hero: { t: "ع" } }, items: [{ n: "x" }, { n: "y" }, { n: "z" }] }) });
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  const r = await call("cust", { action: "design", website_id: "site1" });
  assert(r.json.ok && r.json.items === null, "no items");
});

Deno.test("edit: patch merged and sanitised, logged as a done request, daily cap for customers, not for staff", async () => {
  reset();
  T.websites[0].config.html = `<html>${SD(GOOD_ITEMS)}</html>`;
  const patch = { reply: "غيّرت اللون", patch: { brief: { color: "#ff0000", phone: "not a phone", lang: "fr", name: "" }, copy: { hero: { t: "جديد" } }, custom_css: "a{color:red}</style><script>x</script>", items: [{ n: "واحد", img: "https://evil.example/a.png" }], banners: [{ t: "خصم", u: "javascript:alert(1)" }], dna: { hero: "mesh", font: 3, x: "<b>" } } };
  providerBehavior = anthropicFake({ text: "```json\n" + JSON.stringify(patch) + "\n```" });
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  const r = await call("cust", { action: "edit", website_id: "site1", instruction: "غيّر اللون للأحمر" });
  assert(r.json.ok && r.json.reply === "غيّرت اللون", "ok " + JSON.stringify(r.json));
  const b = r.json.brief;
  assert(b.color === "#ff0000" && b.phone === "0912345678" && !b.lang && b.name === "الملكي", "brief fields validated " + JSON.stringify(b));
  assert(b.copy.hero.t === "جديد", "copy merged");
  assert(!/[<>]/.test(b.custom_css), "css cannot close the style tag");
  assert(r.json.items.length === 1 && !r.json.items[0].img, "foreign image dropped");
  assert(b.banners.length === 1 && !b.banners[0].u, "unsafe link dropped");
  assert(b.dna.hero === "mesh" && b.dna.font === 3 && !("x" in b.dna), "dna shape-checked");
  assert(T.modification_requests.length === 1 && T.modification_requests[0].status === "done" && T.modification_requests[0].final_price === 0, "logged as done, free");
  T.platform_settings.push({ key: "ai.edits_per_day", value: "1" });
  const r2 = await call("cust", { action: "edit", website_id: "site1", instruction: "تعديل ثاني" });
  assert(r2.status === 429 && r2.json.error === "edits_limit", "customer capped");
  const r3 = await call("admin", { action: "edit", website_id: "site1", instruction: "تعديل الأدمن" });
  assert(r3.json.ok, "staff not capped");
});

Deno.test("edit: other customers cannot edit someone else's site; apps are not websites", async () => {
  reset();
  T.profiles.push({ id: "other", role: "customer", status: "active" });
  T.websites.push({ id: "app1", owner_id: "cust", name: "تطبيق", site_type: "app", config: {} });
  providerBehavior = anthropicFake({ text: "{}" });
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  assert((await call("other", { action: "edit", website_id: "site1", instruction: "x y" })).status === 403, "forbidden");
  assert((await call("cust", { action: "edit", website_id: "app1", instruction: "x y" })).status === 404, "app is not a website");
});

Deno.test("openai-compatible hosts get max_tokens within the per-minute cap, JSON mode and low reasoning for gpt-oss", async () => {
  reset();
  let chat: any = null;
  providerBehavior = ({ url, headers, body }) => {
    if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "openai/gpt-oss-120b", created: 1 }] } };
    if (url.endsWith("/chat/completions")) { if (body.max_tokens > 64) chat = body; return headers.get("authorization") === "Bearer gsk_GOODKEY123" ? { status: 200, body: { choices: [{ message: { content: JSON.stringify({ copy: { hero: { t: "ع" } }, items: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } } : { status: 401, body: {} }; }
    return { status: 404, body: {} };
  };
  await call("admin", { action: "connect", kind: "groq", key: "gsk_GOODKEY123" });
  const r = await call("cust", { action: "design", website_id: "site1" });
  assert(r.json.ok, "design ok " + JSON.stringify(r.json));
  assert(chat.model === "openai/gpt-oss-120b", "strongest model first");
  assert(chat.response_format?.type === "json_object" && chat.reasoning_effort === "low", "json + low reasoning");
  assert(chat.max_tokens >= 900 && chat.max_tokens <= 2600, "max_tokens sent and capped: " + chat.max_tokens);
});

Deno.test("IBTIKAR AI rules: core sent to capped free hosts, full text to uncapped providers", async () => {
  reset();
  T.platform_settings.push({ key: "ai.master_rules", value: "FULL RULES TEXT" });
  let sys = "";
  const base = anthropicFake({ text: JSON.stringify({ copy: { hero: { t: "ع" } }, items: [] }) });
  providerBehavior = (r) => { if (r.url.includes("/v1/messages") && r.body.max_tokens > 16) sys = r.body.system; return base(r); };
  await call("admin", { action: "connect", kind: "anthropic", key: "sk-ant-good" });
  await call("cust", { action: "design", website_id: "site1" });
  assert(sys.startsWith("FULL RULES TEXT"), "uncapped provider gets the full rules: " + sys.slice(0, 40));
  reset();
  let groqSys = "";
  providerBehavior = ({ url, headers, body }) => {
    if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "openai/gpt-oss-120b", created: 1 }] } };
    if (url.endsWith("/chat/completions")) { if (body.max_tokens > 64) groqSys = body.messages[0].content; return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ copy: { hero: { t: "ع" } }, items: [] }) } }], usage: {} } }; }
    return { status: 404, body: {} };
  };
  T.platform_settings.push({ key: "ai.master_rules", value: "FULL RULES TEXT" });
  await call("admin", { action: "connect", kind: "groq", key: "gsk_GOODKEY123" });
  await call("cust", { action: "design", website_id: "site1" });
  assert(groqSys.startsWith("أنت IBTIKAR AI") && !groqSys.includes("FULL RULES TEXT"), "capped free host gets the core rules");
});
