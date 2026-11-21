import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE = {
  status: 1, contract_number: 1, title: 1, created_at: 1, sent_at: 1, received_at: 1, approved_at: 1,
  original_mime: 1, signed_mime: 1, esign_name: 1, esign_at: 1,
};

function pick(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(SAFE)) out[k] = row[k];
  out.has_original = !!row.original_path;
  out.has_signed = !!row.signed_path;
  out.has_esign = !!row.esign_image_path;
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]+,/, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
const extFor = (mime: string) => (mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg");

// ---------------------------------------------------------------------------
// Light rate limiting (2026-11-21 hardening).
//
// This endpoint is intentionally public (no JWT: a customer opens the link
// from an email/WhatsApp message and may not be signed in). The share_token
// is an unguessable UUIDv4, so brute-forcing it is not realistic — but there
// was previously *no* throttle at all on repeated attempts against a single
// token, which is still worth closing off (e.g. someone hammering a known
// token with garbage uploads to spam notifications or storage).
//
// This is a per-isolate in-memory sliding window, not a distributed limiter
// backed by a table/Redis: under Supabase's edge runtime a burst of requests
// can land on different isolates and each gets its own counter, so this is
// best-effort friction, not a hard guarantee. It costs nothing to add and
// stops the simple case (one client hammering one token from one isolate).
// For a stronger guarantee, move this to a DB-backed counter (e.g. a
// `contract_file_attempts` table checked the same way `track`'s site_events
// throttle already works).
// ---------------------------------------------------------------------------
const ATTEMPTS = new Map<string, number[]>();
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 20;
function rateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (ATTEMPTS.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  ATTEMPTS.set(key, hits);
  if (ATTEMPTS.size > 5000) { // cheap cap so this never grows unbounded
    for (const [k, v] of ATTEMPTS) if (v.every((t) => now - t >= WINDOW_MS)) ATTEMPTS.delete(k);
  }
  return hits.length > MAX_ATTEMPTS;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(req.url);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";

  if (req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const which = url.searchParams.get("which") ?? "";
    if (!UUID.test(token)) return json({ error: "bad_token" }, 400);
    if (rateLimited(`get:${token}:${ip}`)) return json({ error: "rate_limited" }, 429);
    const { data: c } = await db.from("contracts").select("*").eq("share_token", token).maybeSingle();
    if (!c) return json({ error: "not_found" }, 404);
    if (which === "meta" || !which) return json({ contract: pick(c) });
    const path = which === "original" ? c.original_path : which === "signed" ? c.signed_path : which === "esign" ? c.esign_image_path : null;
    if (!path) return json({ error: "no_file" }, 404);
    const { data: signed, error } = await db.storage.from("contracts").createSignedUrl(path, 300);
    if (error || !signed) return json({ error: "sign_failed" }, 500);
    return json({ url: signed.signedUrl });
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const token = String(b.token ?? "");
  if (!UUID.test(token)) return json({ error: "bad_token" }, 400);
  if (rateLimited(`post:${token}:${ip}`)) return json({ error: "rate_limited" }, 429);
  const { data: c } = await db.from("contracts").select("*").eq("share_token", token).maybeSingle();
  if (!c) return json({ error: "not_found" }, 404);
  if (!["sent", "awaiting_signature"].includes(c.status)) return json({ error: "not_awaiting_signature" }, 409);
  if (c.signed_path || c.esign_image_path) return json({ error: "already_signed" }, 409);

  const which = String(b.which ?? "");
  if (which === "signed") {
    const mime = String(b.mime ?? "");
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(mime)) return json({ error: "bad_mime" }, 400);
    let bytes: Uint8Array;
    try { bytes = b64ToBytes(String(b.file_base64 ?? "")); } catch { return json({ error: "bad_file" }, 400); }
    if (bytes.length < 200 || bytes.length > 8 * 1024 * 1024) return json({ error: "bad_size" }, 400);
    const path = `signed/${c.id}.${extFor(mime)}`;
    const up = await db.storage.from("contracts").upload(path, bytes, { contentType: mime, upsert: false });
    if (up.error) return json({ error: "upload_failed" }, 500);
    await db.from("contracts").update({ signed_path: path, signed_mime: mime, status: "received_signed", received_at: new Date().toISOString() }).eq("id", c.id);
    await db.from("notifications").insert({ user_id: c.customer_id, type: "contract", title: "contract_received" });
    return json({ ok: true });
  }

  if (which === "esign") {
    const name = String(b.name ?? "").trim().slice(0, 120);
    if (name.length < 2) return json({ error: "name_required" }, 400);
    let bytes: Uint8Array;
    try { bytes = b64ToBytes(String(b.image_base64 ?? "")); } catch { return json({ error: "bad_file" }, 400); }
    if (bytes.length < 200 || bytes.length > 1024 * 1024) return json({ error: "bad_size" }, 400);
    const path = `esign/${c.id}.png`;
    const up = await db.storage.from("contracts").upload(path, bytes, { contentType: "image/png", upsert: false });
    if (up.error) return json({ error: "upload_failed" }, 500);
    await db.from("contracts").update({
      esign_image_path: path, esign_name: name, esign_at: new Date().toISOString(),
      status: "received_signed", received_at: new Date().toISOString(),
    }).eq("id", c.id);
    await db.from("notifications").insert({ user_id: c.customer_id, type: "contract", title: "contract_received" });
    return json({ ok: true });
  }

  return json({ error: "unknown_which" }, 400);
});
