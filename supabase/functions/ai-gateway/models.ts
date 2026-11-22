// Model discovery for the "connect an AI provider" flow.
//
// The admin only pastes an API key. We ask the provider itself which models
// that key can use (so a typo like "gpt-6-luna" is impossible), drop the
// ones that cannot write a web page (embeddings, audio, image, reasoning-only
// ...), then pick a PRIMARY model (best balanced one) and a FALLBACK (faster /
// cheaper one, used automatically when the primary is overloaded - e.g. the
// Gemini "503 high demand" the admin hit). Everything here is pure so it can
// be unit tested without network access (see tests in /tests/models.test.ts).

export type Kind = "openai" | "gemini" | "anthropic" | "deepseek" | "xai" | "custom";
export const KINDS: Kind[] = ["openai", "gemini", "anthropic", "deepseek", "xai", "custom"];

export interface Found { id: string; created: number }
export interface Ranked {
  id: string;
  tier: number;            // 1 nano/cheap, 2 fast, 3 balanced, 4 premium
  role: "primary" | "fallback" | "extra";
  selected: boolean;       // enabled by default
  cost_in: number;         // USD per 1M tokens (estimate, editable later)
  cost_out: number;
}

export const BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

export const DISPLAY: Record<string, string> = {
  openai: "OpenAI", gemini: "Gemini", anthropic: "Claude", deepseek: "DeepSeek", xai: "Grok", custom: "Custom",
};

/** The request that lists the models a key can use. */
export function modelsRequest(kind: Kind, endpoint: string | null, key: string) {
  const base = (endpoint || BASES[kind] || "").replace(/\/+$/, "");
  if (kind === "anthropic") return { url: `${base}/v1/models?limit=100`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } as Record<string, string> };
  if (kind === "gemini") return { url: `${base}/v1beta/models?pageSize=200`, headers: { "x-goog-api-key": key } as Record<string, string> };
  // Workers AI has no OpenAI-style /models: its catalogue lives at /ai/models/search
  const cf = base.match(/^(https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32})\/ai\/v1$/);
  if (cf) return { url: `${cf[1]}/ai/models/search?task=Text%20Generation&per_page=100`, headers: { Authorization: `Bearer ${key}` } as Record<string, string> };
  return { url: `${base}/models`, headers: { Authorization: `Bearer ${key}` } as Record<string, string> };
}

/** Normalise each provider's list-models response. */
export function parseModels(kind: Kind, data: any): Found[] {
  if (kind === "anthropic") return (data?.data ?? []).map((m: any) => ({ id: String(m.id), created: Date.parse(m.created_at) || 0 }));
  if (kind === "gemini") {
    return (data?.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => ({ id: String(m.name).replace(/^models\//, ""), created: 0 }));
  }
  if (Array.isArray(data?.result)) return data.result.map((m: any) => ({ id: String(m.name ?? m.id), created: Date.parse(m.created_at) || 0 })).filter((m: Found) => m.id && m.id !== "undefined");   // Cloudflare
  return (data?.data ?? []).map((m: any) => ({ id: String(m.id), created: Number(m.created) || 0 }));
}

const NOT_TEXT = /(embed|tts|whisper|audio|realtime|transcribe|image|imagen|veo|video|speech|moderation|dall-e|aqa|learnlm|robotics|computer-use|\blive\b|guard|rerank|search|davinci|babbage|instruct|^ft:|gemma)/i;
const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;
// OpenAI-compatible third parties (Groq, Mistral, OpenRouter, ...): their ids are free-form, so only drop what clearly cannot chat.
const NOT_CHAT_COMPAT = /(embed|tts|whisper|audio|transcribe|speech|moderation|guard|rerank|image|diffusion|flux|stable|dall|ocr|vision-preview|orpheus|playai|compound)/i;

/** Parameter count in billions from an open-model id ("gpt-oss-120b" -> 120, "qwen3.8-27b" -> 27), 0 when unknown. */
export function sizeOf(id: string): number {
  return Math.max(0, ...[...id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/g)].map((m) => Number(m[1])));
}

/** 0 = unusable for writing a page, 1..4 = tier (see Ranked.tier). */
export function tierOf(kind: Kind, id: string): number {
  const s = id.toLowerCase();
  if (kind === "custom") {
    // free/open hosts (Groq, Cerebras, OpenRouter...): size decides; small models write broken JSON/code
    if (NOT_CHAT_COMPAT.test(s)) return 0;
    const b = sizeOf(s);
    if (b >= 60 || /(kimi|maverick|opus|\bpro\b|ultra|large-?\d*$)/.test(s)) return 4;
    if (b >= 15) return 3;
    if (/(instant|flash|lite|haiku|mini)/.test(s)) return 2;
    if (b > 0 || /(nano|tiny|small)/.test(s)) return 1;
    return 3;
  }
  if (NOT_TEXT.test(s)) return 0;
  switch (kind) {
    case "anthropic": return s.includes("haiku") ? 2 : s.includes("sonnet") ? 3 : s.includes("opus") ? 4 : 0;
    case "gemini": return s.includes("lite") ? 2 : s.includes("flash") ? 3 : s.includes("pro") ? 4 : 0;
    case "openai":
      if (/^o\d/.test(s) || !/^gpt-/.test(s)) return 0;                  // reasoning-only / ChatGPT snapshots / non chat models
      return s.includes("nano") ? 1 : s.includes("mini") ? 2 : /(^|-)pro(-|$)/.test(s) ? 4 : 3;
    case "deepseek": return s.includes("reasoner") ? 0 : s.includes("chat") ? 3 : 0;
    case "xai":
      if (/image|vision/.test(s)) return 0;
      return s.includes("mini") || s.includes("fast") ? 2 : s.startsWith("grok") ? 3 : 0;
    default: return 3;
  }
}

/** Numeric version of a model id, "latest" aliases rank newest. */
export function versionOf(id: string): number[] {
  const s = id.toLowerCase();
  if (/latest/.test(s) && !/\d/.test(s)) return [9999];              // e.g. gemini-flash-latest = always the newest flash
  const m = s.replace(DATED, "").replace(/latest/, "").match(/(\d+)(?:[.-](\d{1,2}))?/);
  if (!m) return [0];
  return m[2] !== undefined ? [Number(m[1]), Number(m[2])] : [Number(m[1])];
}
function cmpVersion(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Rough public list prices, only so the per-site AI budget means something. Editable by the admin. */
export function guessCost(kind: Kind, tier: number): { cost_in: number; cost_out: number } {
  const T: Record<string, Record<number, [number, number]>> = {
    anthropic: { 2: [1, 5], 3: [3, 15], 4: [15, 75] },
    gemini: { 2: [0.1, 0.4], 3: [0.3, 2.5], 4: [1.25, 10] },
    openai: { 1: [0.1, 0.4], 2: [0.4, 1.6], 3: [2, 8], 4: [15, 60] },
    deepseek: { 3: [0.27, 1.1] },
    xai: { 2: [0.3, 0.5], 3: [3, 15] },
  };
  const [i, o] = T[kind]?.[tier] ?? [0, 0];
  return { cost_in: i, cost_out: o };
}

/** Choose what to enable. Returns candidates sorted best first (max 12). */
export function rankModels(kind: Kind, found: Found[]): Ranked[] {
  const ids = new Set(found.map((f) => f.id));
  const seen = new Set<string>();
  const usable = found
    .filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      // keep a dated snapshot only when its undated alias is not listed
      if (DATED.test(f.id) && ids.has(f.id.replace(DATED, ""))) return false;
      return tierOf(kind, f.id) > 0;
    })
    .map((f) => ({ ...f, tier: tierOf(kind, f.id), ver: versionOf(f.id), pre: /(preview|exp|beta|thinking)/i.test(f.id) }))
    // hosts that mark free models (OpenRouter ":free"): only those, a paid one would fail on a free key
    .filter((f, _i, all) => kind !== "custom" || !all.some((x) => /:free$/i.test(x.id)) || /:free$/i.test(f.id));

  const best = (list: typeof usable) =>
    [...list].sort((a, b) => Number(a.pre) - Number(b.pre) || cmpVersion(b.ver, a.ver) || b.created - a.created)[0];

  const byTier = (t: number) => usable.filter((u) => u.tier === t);
  const fallbacks: typeof usable = [];
  let primary: (typeof usable)[number] | undefined;
  if (kind === "custom") {
    // open models cost nothing extra per size on these hosts: strongest first, then the next big one, then a fast one
    primary = best(byTier(4)) ?? best(byTier(3)) ?? best(byTier(2)) ?? best(byTier(1));
    if (primary) {
      const rest = usable.filter((u) => u.id !== primary!.id);
      const f1 = best(rest.filter((u) => u.tier >= 3)) ?? best(rest.filter((u) => u.tier === 2));
      if (f1) fallbacks.push(f1);
      const left = rest.filter((u) => u.id !== f1?.id);
      const f2 = best(left.filter((u) => u.tier === 2)) ?? best(left.filter((u) => u.tier >= 3));
      if (f2) fallbacks.push(f2);
    }
  } else {
    primary = best(byTier(3)) ?? best(byTier(4)) ?? best(byTier(2)) ?? best(byTier(1));
    // up to two automatic fallbacks: the best fast model, then the next-best balanced one
    if (primary) {
      const rest = usable.filter((u) => u.id !== primary!.id);
      const f1 = best(rest.filter((u) => u.tier === 2)) ?? best(rest.filter((u) => u.tier === 1));
      if (f1) fallbacks.push(f1);
      const f2 = best(rest.filter((u) => u.tier === 3 && (!f1 || u.id !== f1.id)));
      if (f2) fallbacks.push(f2);
    }
  }
  const fbIds = new Set(fallbacks.map((f) => f.id));
  const role = (id: string): Ranked["role"] => (primary && id === primary.id ? "primary" : fbIds.has(id) ? "fallback" : "extra");
  const out: Ranked[] = usable.map((u) => ({
    id: u.id, tier: u.tier, role: role(u.id), selected: role(u.id) !== "extra", ...guessCost(kind, u.tier),
  }));
  // selected ones keep their chain order (primary, fallback 1, fallback 2); the rest: premium/newest first
  const chain = [primary?.id, ...fallbacks.map((f) => f.id)].filter(Boolean) as string[];
  const pos = (id: string) => { const i = chain.indexOf(id); return i < 0 ? 99 : i; };
  out.sort((a, b) => pos(a.id) - pos(b.id) || b.tier - a.tier || cmpVersion(versionOf(b.id), versionOf(a.id)));
  return out.slice(0, 12);
}

/** Most common copy/paste mistake: a key from another provider. */
export function keyHint(kind: Kind, key: string): string | null {
  const k = key.trim();
  if (kind === "anthropic" && !k.startsWith("sk-ant")) return "wrong_key_for_claude";
  if (kind === "gemini" && !k.startsWith("AIza")) return "wrong_key_for_gemini";
  if (kind === "openai" && k.startsWith("sk-ant")) return "wrong_key_for_openai";
  if (kind === "xai" && !k.startsWith("xai-")) return "wrong_key_for_xai";
  return null;
}

/** Block obvious internal targets for the admin-supplied "custom" endpoint (same spirit as uptime-check). */
export function safeEndpoint(u: string): string | null {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return null;
    const h = x.hostname;
    if (h === "localhost" || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || h.endsWith(".internal") || h.includes(":")) return null;
    return x.origin + x.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

/** Map a failed list-models HTTP status to a stable error code the UI can translate. */
export function listError(status: number): string {
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 404) return "endpoint_not_found";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

/**
 * Runtime order of the enabled models of ONE provider - the same chain the connect screen shows:
 * best balanced model, then the best fast one (a DIFFERENT model, so a per-model overload like Gemini's
 * "503 high demand" is bypassed), then the remaining balanced ones, premium, cheapest.
 * Cheap classification jobs start from the fast tier instead.
 */
export function orderModels<T extends { model_id: string }>(task: string, kind: Kind, pool: T[]): T[] {
  const withInfo = pool.map((m) => ({ m, tier: tierOf(kind, m.model_id), ver: versionOf(m.model_id) }));
  const desc = (a: { ver: number[] }, b: { ver: number[] }) => cmpVersion(b.ver, a.ver);
  const tier = (t: number) => withInfo.filter((x) => x.tier === t).sort(desc);
  const t3 = tier(3), t2 = tier(2), t4 = tier(4), t1 = tier(1), other = withInfo.filter((x) => x.tier === 0);
  if (kind === "custom") {
    const big = [...t4, ...t3];
    const chain = task === "classify" ? [...t3, ...t2, ...t4, ...t1] : [...big.slice(0, 1), ...big.slice(1, 2), ...t2.slice(0, 1), ...big.slice(2), ...t2.slice(1), ...t1];
    return [...chain, ...other].map((x) => x.m);
  }
  const chain = task === "classify"
    ? [...t2.slice(0, 1), ...t3.slice(0, 1), ...t2.slice(1), ...t3.slice(1), ...t1, ...t4]
    : [...t3.slice(0, 1), ...t2.slice(0, 1), ...t3.slice(1), ...t2.slice(1), ...t4, ...t1];
  return [...chain, ...other].map((x) => x.m);
}

// ---------------------------------------------------------------------------
// Presets: OpenAI-compatible providers are stored as kind="custom" + endpoint (the DB kind check only knows 6 kinds).
// ---------------------------------------------------------------------------
/** rpm = the provider's free-tier requests per minute (from awesome-freellm-apis); the router never exceeds it.
 *  needs = extra value the admin must give (Cloudflare puts the account id inside the URL). */
export const PRESETS: Record<string, { name: string; endpoint: string; host: string; rpm?: number; needs?: "account_id" }> = {
  groq: { name: "Groq", endpoint: "https://api.groq.com/openai/v1", host: "api.groq.com" },
  mistral: { name: "Mistral", endpoint: "https://api.mistral.ai/v1", host: "api.mistral.ai" },
  openrouter: { name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", host: "openrouter.ai" },
  together: { name: "Together", endpoint: "https://api.together.xyz/v1", host: "api.together.xyz" },
  fireworks: { name: "Fireworks", endpoint: "https://api.fireworks.ai/inference/v1", host: "api.fireworks.ai" },
  cerebras: { name: "Cerebras", endpoint: "https://api.cerebras.ai/v1", host: "api.cerebras.ai", rpm: 30 },
  // free tiers from github.com/open-free-llm-api/awesome-freellm-apis (all OpenAI-compatible)
  nvidia: { name: "NVIDIA NIM", endpoint: "https://integrate.api.nvidia.com/v1", host: "integrate.api.nvidia.com", rpm: 40 },
  cohere: { name: "Cohere", endpoint: "https://api.cohere.ai/compatibility/v1", host: "api.cohere.ai", rpm: 20 },
  llm7: { name: "LLM7", endpoint: "https://api.llm7.io/v1", host: "api.llm7.io", rpm: 60 },
  ovh: { name: "OVHcloud", endpoint: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", host: "oai.endpoints.kepler.ai.cloud.ovh.net", rpm: 2 },
  ollama: { name: "Ollama Cloud", endpoint: "https://ollama.com/v1", host: "ollama.com" },
  zai: { name: "Z AI", endpoint: "https://open.bigmodel.cn/api/paas/v4", host: "open.bigmodel.cn" },
  chutes: { name: "Chutes", endpoint: "https://llm.chutes.ai/v1", host: "llm.chutes.ai" },
  glhf: { name: "Glhf", endpoint: "https://glhf.chat/api/openai/v1", host: "glhf.chat" },
  siliconflow: { name: "SiliconFlow", endpoint: "https://api.siliconflow.cn/v1", host: "api.siliconflow.cn" },
  modelscope: { name: "ModelScope", endpoint: "https://api-inference.modelscope.cn/v1", host: "api-inference.modelscope.cn" },
  kilo: { name: "Kilo Code", endpoint: "https://api.kilo.ai/api/gateway", host: "api.kilo.ai", rpm: 3 },
  opencode: { name: "OpenCode Zen", endpoint: "https://opencode.ai/zen/v1", host: "opencode.ai" },
  aion: { name: "Aion Labs", endpoint: "https://api.aionlabs.ai/v1", host: "api.aionlabs.ai", rpm: 15 },
  agnes: { name: "Agnes AI", endpoint: "https://apihub.agnes-ai.com/v1", host: "apihub.agnes-ai.com" },
  gonka: { name: "Gonka", endpoint: "https://proxy.gonkabroker.com/v1", host: "proxy.gonkabroker.com" },
  // Workers AI through the OpenAI-compatible endpoint; the account id is part of the URL
  cloudflare: { name: "Cloudflare Workers AI", endpoint: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", host: "api.cloudflare.com", needs: "account_id" },
};
export const CF_ACCOUNT = /^[0-9a-f]{32}$/;

export interface Target { kind: Kind; endpoint: string | null; name: string }

/** Turn what the admin picked (a DB kind or a preset id) into the row we store. */
export function resolveTarget(pick: string, extra: { account_id?: unknown } = {}): Target | null {
  if ((KINDS as string[]).includes(pick) && pick !== "custom") return { kind: pick as Kind, endpoint: null, name: DISPLAY[pick] };
  const pr = PRESETS[pick];
  if (!pr) return null;
  if (pr.needs === "account_id") {
    const id = String(extra.account_id ?? "").trim().toLowerCase();
    if (!CF_ACCOUNT.test(id)) return null;
    return { kind: "custom", endpoint: pr.endpoint.replace("{account_id}", id), name: pr.name };
  }
  return { kind: "custom", endpoint: pr.endpoint, name: pr.name };
}

/** The free-tier requests-per-minute of the preset that owns this endpoint (undefined when unknown). */
export function presetRpm(endpoint: string | null): number | undefined {
  if (!endpoint) return undefined;
  return Object.values(PRESETS).find((p) => !p.needs && endpoint.startsWith(p.endpoint))?.rpm;
}

/** Recognise the provider from the key's own prefix (the usual mistake is a Groq key pasted under OpenAI, etc.). */
export function detectPick(key: string): string | null {
  const k = key.trim();
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("AIza")) return "gemini";
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("xai-")) return "xai";
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("csk-")) return "cerebras";
  if (k.startsWith("fw_")) return "fireworks";
  if (k.startsWith("nvapi-")) return "nvidia";
  return null;
}

/** Strip the usual paste noise: quotes, "Bearer ", line breaks. */
export function cleanKey(raw: string): string {
  return String(raw ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").replace(/^Bearer\s+/i, "").trim();
}

/** Minimal shell-like tokenizer for pasted curl commands (quotes, backslash/caret line continuations). */
export function shellSplit(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const out: string[] = [];
  let cur = "", q: string | null = null, has = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) cur += src[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { q = c; has = true; }
    else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ""; has = false; } }
    else if (c === "\\" && i + 1 < src.length) cur += src[++i];
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

export interface CurlInfo { url: URL; headers: Record<string, string>; body: any; key: string; model: string }

export function parseCurl(text: string): CurlInfo | { error: string } {
  const t = shellSplit(String(text ?? ""));
  if (!t.length || !/^curl(\.exe)?$/i.test(t[0])) return { error: "curl_not_found" };
  let url = "", body: string | null = null;
  const headers: Record<string, string> = {};
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    if (a === "-H" || a === "--header") { const h = t[++i] ?? ""; const k = h.indexOf(":"); if (k > 0) headers[h.slice(0, k).trim().toLowerCase()] = h.slice(k + 1).trim(); }
    else if (/^(-d|--data|--data-raw|--data-binary|--data-ascii|--json)$/.test(a)) body = t[++i] ?? "";
    else if (/^(-X|--request|-u|--user|-A|--user-agent|--url|-o|--output|-m|--max-time|--connect-timeout|-e|--referer)$/.test(a)) { const v = t[++i] ?? ""; if (a === "--url") url = v; if (a === "-u" || a === "--user") headers["authorization"] ??= "Basic " + btoa(v); }
    else if (/^https?:\/\//i.test(a)) url = a;
  }
  if (!url) return { error: "curl_no_url" };
  let u: URL;
  try { u = new URL(url); } catch { return { error: "curl_bad_url" }; }
  let parsed: any = null;
  if (body) { try { parsed = JSON.parse(body); } catch { /* not json */ } }
  let key = "";
  const auth = headers["authorization"] ?? "";
  if (/^bearer\s+/i.test(auth)) key = auth.replace(/^bearer\s+/i, "").trim();
  else if (headers["x-api-key"]) key = headers["x-api-key"];
  else if (headers["x-goog-api-key"]) key = headers["x-goog-api-key"];
  else if (u.searchParams.get("key")) key = u.searchParams.get("key")!;
  const gm = /\/models\/([^/:?]+)(?::|$)/.exec(u.pathname);
  const model = String(parsed?.model ?? (gm && !u.pathname.endsWith("/models") ? gm[1] : "") ?? "");
  return { url: u, headers, body: parsed, key: cleanKey(key), model };
}

/** Decide which provider a curl targets. Unknown hosts are treated as OpenAI-compatible (Bearer token). */
export function targetFromCurl(c: CurlInfo): Target | { error: string } {
  const h = c.url.hostname.toLowerCase();
  const known: Record<string, string> = { "api.openai.com": "openai", "api.anthropic.com": "anthropic", "generativelanguage.googleapis.com": "gemini", "api.deepseek.com": "deepseek", "api.x.ai": "xai" };
  if (known[h]) return resolveTarget(known[h])!;
  for (const [id, p] of Object.entries(PRESETS)) if (h === p.host && !p.needs) return resolveTarget(id)!;
  const usesBearer = /^bearer\s+/i.test(c.headers["authorization"] ?? "");
  if (!usesBearer) return { error: "curl_unsupported_auth" };
  const base = c.url.origin + c.url.pathname.replace(/\/(chat\/completions|completions|responses|models)\/?$/, "").replace(/\/+$/, "");
  const safe = safeEndpoint(base);
  if (!safe) return { error: "endpoint_required" };
  return { kind: "custom", endpoint: safe, name: h.replace(/^(api|www)\./, "").split(".")[0].replace(/^./, (x) => x.toUpperCase()).slice(0, 40) };
}
