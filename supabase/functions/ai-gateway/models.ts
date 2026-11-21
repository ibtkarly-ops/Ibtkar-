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
  return (data?.data ?? []).map((m: any) => ({ id: String(m.id), created: Number(m.created) || 0 }));
}

const NOT_TEXT = /(embed|tts|whisper|audio|realtime|transcribe|image|imagen|veo|video|speech|moderation|dall-e|aqa|learnlm|robotics|computer-use|\blive\b|guard|rerank|search|davinci|babbage|instruct|^ft:|gemma)/i;
const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** 0 = unusable for writing a page, 1..4 = tier (see Ranked.tier). */
export function tierOf(kind: Kind, id: string): number {
  const s = id.toLowerCase();
  if (kind !== "custom" && NOT_TEXT.test(s)) return 0;
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
    .map((f) => ({ ...f, tier: tierOf(kind, f.id), ver: versionOf(f.id), pre: /(preview|exp|beta|thinking)/i.test(f.id) }));

  const best = (list: typeof usable) =>
    [...list].sort((a, b) => Number(a.pre) - Number(b.pre) || cmpVersion(b.ver, a.ver) || b.created - a.created)[0];

  const byTier = (t: number) => usable.filter((u) => u.tier === t);
  const primary = best(byTier(3)) ?? best(byTier(4)) ?? best(byTier(2)) ?? best(byTier(1));
  // up to two automatic fallbacks: the best fast model, then the next-best balanced one
  const fallbacks: typeof usable = [];
  if (primary) {
    const rest = usable.filter((u) => u.id !== primary.id);
    const f1 = best(rest.filter((u) => u.tier === 2)) ?? best(rest.filter((u) => u.tier === 1));
    if (f1) fallbacks.push(f1);
    const f2 = best(rest.filter((u) => u.tier === 3 && (!f1 || u.id !== f1.id)));
    if (f2) fallbacks.push(f2);
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
  const chain = task === "classify"
    ? [...t2.slice(0, 1), ...t3.slice(0, 1), ...t2.slice(1), ...t3.slice(1), ...t1, ...t4]
    : [...t3.slice(0, 1), ...t2.slice(0, 1), ...t3.slice(1), ...t2.slice(1), ...t4, ...t1];
  return [...chain, ...other].map((x) => x.m);
}
