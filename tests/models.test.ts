// deno test --no-check tests/models.test.ts
import { guessCost, keyHint, listError, modelsRequest, parseModels, rankModels, safeEndpoint, versionOf } from "../supabase/functions/ai-gateway/models.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}\n got  ${JSON.stringify(a)}\n want ${JSON.stringify(b)}`);
}
const sel = (r: ReturnType<typeof rankModels>) => r.filter((x) => x.selected).map((x) => x.id);

Deno.test("anthropic: sonnet primary, haiku fallback, opus listed but not enabled, dated alias dropped", () => {
  const f = parseModels("anthropic", { data: [
    { id: "claude-opus-5-5", created_at: "2026-02-01T00:00:00Z" }, { id: "claude-sonnet-5-5", created_at: "2026-02-01T00:00:00Z" },
    { id: "claude-haiku-5-5", created_at: "2026-02-01T00:00:00Z" }, { id: "claude-sonnet-4-5-20250929", created_at: "2025-09-29T00:00:00Z" },
    { id: "claude-sonnet-4-5", created_at: "2025-09-29T00:00:00Z" }, { id: "claude-3-5-haiku-20241022", created_at: "2024-10-22T00:00:00Z" },
  ] });
  const r = rankModels("anthropic", f);
  eq(r[0].id, "claude-sonnet-5-5", "primary");
  eq(sel(r), ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5"], "enabled set");
  eq(r.some((x) => x.id === "claude-sonnet-4-5-20250929"), false, "dated snapshot dropped when alias exists");
  eq(r.find((x) => x.id === "claude-opus-5-5")?.selected, false, "opus not auto-enabled");
});

Deno.test("gemini: only generateContent models, no tts/image/embedding/gemma, latest-alias is primary, lite is fallback", () => {
  const m = (name: string, gen = true) => ({ name: "models/" + name, supportedGenerationMethods: gen ? ["generateContent"] : ["embedContent"] });
  const f = parseModels("gemini", { models: [
    m("gemini-2.5-pro"), m("gemini-2.5-flash"), m("gemini-2.5-flash-lite"), m("gemini-flash-latest"), m("gemini-2.0-flash"),
    m("text-embedding-004", false), m("gemini-2.5-flash-preview-tts"), m("gemini-2.5-flash-image"), m("gemma-3-27b-it"),
  ] });
  const r = rankModels("gemini", f);
  eq(r[0].id, "gemini-flash-latest", "primary");
  eq(sel(r), ["gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"], "enabled set");
  for (const bad of ["text-embedding-004", "gemini-2.5-flash-preview-tts", "gemini-2.5-flash-image", "gemma-3-27b-it"]) eq(r.some((x) => x.id === bad), false, bad + " excluded");
});

Deno.test("openai: gpt family only, newest balanced primary, mini fallback, no o-series/audio/image/embeddings/chatgpt snapshots", () => {
  const ids = ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4o", "gpt-4o-2024-08-06", "o3", "o4-mini", "text-embedding-3-large", "whisper-1", "tts-1", "dall-e-3", "gpt-image-1", "gpt-4o-audio-preview", "gpt-4o-realtime-preview", "omni-moderation-latest", "gpt-5-pro", "chatgpt-4o-latest"];
  const r = rankModels("openai", parseModels("openai", { data: ids.map((id) => ({ id, created: 1 })) }));
  eq(r[0].id, "gpt-5", "primary");
  eq(sel(r), ["gpt-5", "gpt-5-mini", "gpt-4.1"], "enabled set");
  for (const bad of ["o3", "o4-mini", "text-embedding-3-large", "whisper-1", "tts-1", "dall-e-3", "gpt-image-1", "gpt-4o-audio-preview", "gpt-4o-realtime-preview", "omni-moderation-latest", "chatgpt-4o-latest", "gpt-4o-2024-08-06"]) eq(r.some((x) => x.id === bad), false, bad + " excluded");
  eq(r.find((x) => x.id === "gpt-5-pro")?.selected, false, "pro not auto-enabled");
});

Deno.test("deepseek / xai / custom", () => {
  eq(sel(rankModels("deepseek", parseModels("deepseek", { data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }))), ["deepseek-chat"], "deepseek");
  eq(sel(rankModels("xai", parseModels("xai", { data: [{ id: "grok-4" }, { id: "grok-3" }, { id: "grok-3-mini" }, { id: "grok-2-image-1212" }] }))), ["grok-4", "grok-3-mini", "grok-3"], "xai");
  eq(rankModels("custom", parseModels("custom", { data: [{ id: "llama-3.1-70b" }, { id: "qwen2" }] })).length, 2, "custom keeps all");
  eq(rankModels("openai", []).length, 0, "empty list -> nothing");
});

Deno.test("requests / hints / safety / errors", () => {
  eq(modelsRequest("gemini", null, "K").url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", "gemini url");
  eq(modelsRequest("anthropic", null, "K").headers["x-api-key"], "K", "anthropic header");
  eq(modelsRequest("openai", null, "K").url, "https://api.openai.com/v1/models", "openai url");
  eq(modelsRequest("custom", "https://x.example/v1/", "K").url, "https://x.example/v1/models", "custom url");
  eq(keyHint("anthropic", "sk-proj-abc"), "wrong_key_for_claude", "claude hint");
  eq(keyHint("anthropic", "sk-ant-api03-x"), null, "claude ok");
  eq(keyHint("gemini", "AIzaSyX"), null, "gemini ok");
  eq(safeEndpoint("http://example.com"), null, "http blocked");
  eq(safeEndpoint("https://127.0.0.1/v1"), null, "loopback blocked");
  eq(safeEndpoint("https://192.168.1.5/v1"), null, "private blocked");
  eq(safeEndpoint("https://api.example.com/v1/"), "https://api.example.com/v1", "good endpoint normalised");
  eq([listError(401), listError(403), listError(404), listError(429), listError(500)], ["invalid_key", "invalid_key", "endpoint_not_found", "rate_limited", "provider_error"], "status map");
  eq(versionOf("gemini-flash-latest"), [9999], "alias newest");
  eq(versionOf("claude-3-5-sonnet-latest"), [3, 5], "latest with digits");
  eq(guessCost("anthropic", 3), { cost_in: 3, cost_out: 15 }, "cost");
});

import { orderModels } from "../supabase/functions/ai-gateway/models.ts";
Deno.test("orderModels: balanced -> best fast -> other balanced; classify starts fast", () => {
  const pool = ["claude-sonnet-4-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((model_id) => ({ model_id }));
  eq(orderModels("ui", "anthropic", pool).map((m) => m.model_id), ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5", "claude-opus-5-5"], "ui chain");
  eq(orderModels("classify", "anthropic", pool).map((m) => m.model_id)[0], "claude-haiku-5-5", "classify starts fast");
  eq(orderModels("ui", "gemini", ["gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"].map((model_id) => ({ model_id }))).map((m) => m.model_id), ["gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"], "gemini chain avoids retrying the same backend first");
});

import { PRESETS, cleanKey, detectPick, parseCurl, presetRpm, rankModels as rk, resolveTarget, targetFromCurl } from "../supabase/functions/ai-gateway/models.ts";

Deno.test("presets: groq is stored as custom + endpoint; key prefix detects the real provider", () => {
  eq(resolveTarget("groq"), { kind: "custom", endpoint: "https://api.groq.com/openai/v1", name: "Groq" }, "groq target");
  eq(resolveTarget("openai"), { kind: "openai", endpoint: null, name: "OpenAI" }, "openai target");
  eq(resolveTarget("nope"), null, "unknown pick");
  eq(detectPick("gsk_abc"), "groq", "gsk_"); eq(detectPick("sk-ant-x"), "anthropic", "sk-ant"); eq(detectPick("AIzaSyX"), "gemini", "AIza"); eq(detectPick("sk-or-v1-x"), "openrouter", "sk-or"); eq(detectPick("sk-proj-1"), null, "openai is ambiguous");
  eq(cleanKey('  "Bearer gsk_abc"\n'), "gsk_abc", "paste noise removed");
});

Deno.test("groq model list: chat models ranked, whisper/guard/tts dropped, instant is the fallback", () => {
  const ids = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "whisper-large-v3", "whisper-large-v3-turbo", "meta-llama/llama-guard-4-12b", "playai-tts", "openai/gpt-oss-120b", "meta-llama/llama-4-scout-17b-16e-instruct"];
  const r = rk("custom", ids.map((id) => ({ id, created: 1 })));
  for (const bad of ["whisper-large-v3", "whisper-large-v3-turbo", "meta-llama/llama-guard-4-12b", "playai-tts"]) eq(r.some((x) => x.id === bad), false, bad + " excluded");
  eq(r.some((x) => x.id === "llama-3.3-70b-versatile"), true, "70b kept");
  eq(r.find((x) => x.id === "llama-3.1-8b-instant")?.tier, 2, "instant is the fast tier");
  eq(r.find((x) => x.role === "primary")?.tier === 3 || r.find((x) => x.role === "primary")?.tier === 4, true, "primary is a big model");
});

Deno.test("groq live list: the strongest open model is primary, tiny/tts models are never auto-enabled", () => {
  const ids = ["allam-2-7b", "canopylabs/orpheus-arabic-saudi", "canopylabs/orpheus-v1-english", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b", "groq/compound"];
  const r = rk("custom", ids.map((id) => ({ id, created: 1 })));
  eq(r.find((x) => x.role === "primary")?.id, "openai/gpt-oss-120b", "120b is primary");
  eq(r.filter((x) => x.selected).map((x) => x.id).includes("allam-2-7b"), false, "7b not enabled");
  for (const bad of ["canopylabs/orpheus-arabic-saudi", "canopylabs/orpheus-v1-english", "groq/compound"]) eq(r.some((x) => x.id === bad), false, bad + " excluded");
  eq(orderModels("ui", "custom", ["allam-2-7b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"].map((model_id) => ({ model_id }))).map((m) => m.model_id), ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "allam-2-7b"], "runtime chain: strongest first");
});

Deno.test("curl: OpenAI, Anthropic, Gemini, Groq and an unknown OpenAI-compatible host are understood", () => {
  const groq = parseCurl(`curl https://api.groq.com/openai/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer gsk_TESTKEY123" \\
  -d '{"model": "llama-3.3-70b-versatile", "messages": [{"role": "user", "content": "hi"}]}'`);
  if ("error" in groq) throw new Error(groq.error);
  eq([groq.key, groq.model], ["gsk_TESTKEY123", "llama-3.3-70b-versatile"], "groq key+model");
  eq(targetFromCurl(groq), { kind: "custom", endpoint: "https://api.groq.com/openai/v1", name: "Groq" }, "groq preset");
  const an = parseCurl(`curl https://api.anthropic.com/v1/messages --header "x-api-key: sk-ant-abc" --header "anthropic-version: 2023-06-01" --data '{"model":"claude-sonnet-5-5","max_tokens":10,"messages":[]}'`);
  if ("error" in an) throw new Error(an.error);
  eq([an.key, an.model, (targetFromCurl(an) as any).kind], ["sk-ant-abc", "claude-sonnet-5-5", "anthropic"], "anthropic");
  const gm = parseCurl(`curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaXYZ" -H 'Content-Type: application/json' -d '{"contents":[]}'`);
  if ("error" in gm) throw new Error(gm.error);
  eq([gm.key, gm.model, (targetFromCurl(gm) as any).kind], ["AIzaXYZ", "gemini-2.5-flash", "gemini"], "gemini");
  const oa = parseCurl(`curl https://api.openai.com/v1/chat/completions -H "Authorization: Bearer sk-proj-1" -d '{"model":"gpt-5"}'`);
  if ("error" in oa) throw new Error(oa.error);
  eq((targetFromCurl(oa) as any).kind, "openai", "openai");
  const cu = parseCurl(`curl https://api.myhost.ai/v1/chat/completions -H "Authorization: Bearer k-123456789" -d '{"model":"m1"}'`);
  if ("error" in cu) throw new Error(cu.error);
  eq(targetFromCurl(cu), { kind: "custom", endpoint: "https://api.myhost.ai/v1", name: "Myhost" }, "unknown host");
  const bad = parseCurl(`curl http://127.0.0.1/v1/chat/completions -H "Authorization: Bearer abcdefgh1"`);
  if ("error" in bad) throw new Error(bad.error);
  eq((targetFromCurl(bad) as any).error, "endpoint_required", "internal address refused");
  eq((parseCurl("echo hi") as any).error, "curl_not_found", "not a curl");
  const nonb = parseCurl(`curl https://x.ai-host.com/v1/chat/completions -H "x-token: abc"`);
  if ("error" in nonb) throw new Error(nonb.error);
  eq((targetFromCurl(nonb) as any).error, "curl_unsupported_auth", "unsupported auth header at unknown host");
});

Deno.test("free providers from the awesome-freellm list are presets; OpenRouter keeps only :free models", () => {
  for (const id of ["nvidia", "cohere", "llm7", "ovh", "ollama", "zai", "chutes", "glhf", "siliconflow", "modelscope", "kilo", "opencode", "aion", "agnes", "gonka"]) {
    const t = resolveTarget(id);
    eq(!!t && t.kind === "custom" && /^https:\/\//.test(t.endpoint!), true, id + " preset");
  }
  eq(detectPick("nvapi-abc"), "nvidia", "nvapi- prefix");
  const r = rk("custom", ["meta-llama/llama-3.1-405b-instruct", "deepseek/deepseek-chat-v3:free", "qwen/qwen3-235b-a22b:free", "openai/gpt-4o"].map((id) => ({ id, created: 1 })));
  eq(r.every((x) => x.id.endsWith(":free")), true, "only free models kept");
  eq(r.find((x) => x.role === "primary")?.id, "qwen/qwen3-235b-a22b:free", "biggest free model is primary");
});

Deno.test("every preset has a public https endpoint, a button and a 'get a key' link in the Engine page", async () => {
  const html = await Deno.readTextFile(new URL("../public/index.html", import.meta.url));
  const kindL = html.match(/const KIND_L=\{([^}]*)\}/)![1], info = html.match(/const PROV_INFO=\{([\s\S]*?)\};/)![1];
  for (const [id, p] of Object.entries(PRESETS)) {
    eq(/^https:\/\/[a-z0-9.-]+\//.test(p.endpoint) && new URL(p.endpoint.replace("{account_id}", "0".repeat(32))).hostname === p.host, true, id + " endpoint/host");
    eq(new RegExp("\\b" + id + ":'").test(kindL), true, id + " has a button");
    eq(new RegExp("\\b" + id + ":\\['https://").test(info), true, id + " has a key link");
  }
});

Deno.test("Cloudflare Workers AI: account id goes in the URL, a bad one is refused, models come from /ai/models/search", () => {
  const acc = "0123456789abcdef0123456789abcdef";
  eq(resolveTarget("cloudflare"), null, "no account id");
  eq(resolveTarget("cloudflare", { account_id: "nope" }), null, "bad account id");
  eq(resolveTarget("cloudflare", { account_id: "../../x" + "a".repeat(25) }), null, "path injection refused");
  const t = resolveTarget("cloudflare", { account_id: " " + acc.toUpperCase() + " " })!;
  eq(t.endpoint, `https://api.cloudflare.com/client/v4/accounts/${acc}/ai/v1`, "endpoint with account id");
  eq(modelsRequest("custom", t.endpoint, "tok").url, `https://api.cloudflare.com/client/v4/accounts/${acc}/ai/models/search?task=Text%20Generation&per_page=100`, "catalogue url");
  const found = parseModels("custom", { success: true, result: [{ name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }, { name: "@cf/meta/llama-3.1-8b-instruct" }] });
  eq(found.map((f) => f.id), ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"], "cloudflare model list");
  eq(rk("custom", found).find((x) => x.role === "primary")?.id, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "70b is primary");
  // a pasted Cloudflare curl keeps its own account URL instead of the {account_id} template
  const c = parseCurl(`curl https://api.cloudflare.com/client/v4/accounts/${acc}/ai/v1/chat/completions -H "Authorization: Bearer tok" -d '{"model":"@cf/meta/llama-3.1-8b-instruct"}'`);
  if ("error" in c) throw new Error(c.error);
  eq((targetFromCurl(c) as any).endpoint, `https://api.cloudflare.com/client/v4/accounts/${acc}/ai/v1`, "curl target");
});

Deno.test("free-tier limits: a new provider gets its preset requests-per-minute; unknown hosts keep the default", () => {
  eq(presetRpm("https://integrate.api.nvidia.com/v1"), 40, "nvidia");
  eq(presetRpm("https://oai.endpoints.kepler.ai.cloud.ovh.net/v1"), 2, "ovh");
  eq(presetRpm("https://api.kilo.ai/api/gateway"), 3, "kilo 200/h");
  eq(presetRpm("https://api.groq.com/openai/v1"), undefined, "groq keeps the default");
  eq(presetRpm("https://example.com/v1"), undefined, "unknown");
  eq(presetRpm(null), undefined, "native kinds");
});
