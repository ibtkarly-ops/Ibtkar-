// Central contract-image system (service-role side). The browser never touches the private bucket:
//   template_upload  Super Admin: validates the REAL image bytes, hashes them, stores the originals untouched, activates a new version
//   urls             owner of a contract (or staff): short-lived signed links to the page images / final PDF
//   sign             the customer only: validates the drawn signature, builds the final PDF (original pages + signature + certificate page),
//                    stores it and finalizes everything atomically in the database (ct_finalize_signature)
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, type PDFImage, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const BUCKET = "ibtkar-contracts-private";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const MAX_PAGE_BYTES = 6 * 1024 * 1024, MAX_PAGES = 10, MIN_SIG = 600, MAX_SIG = 400 * 1024, MAX_NAME_IMG = 200 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function b64(s: unknown): Uint8Array | null {
  try { const bin = atob(String(s ?? "").replace(/^data:[^,]+,/, "")); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; } catch { return null; }
}
export const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
// pdf-lib's PNG reader can spin forever on a truncated/forged file, so every image is walked structurally BEFORE it reaches pdf-lib:
// chunk lengths must fit, IHDR first, IDAT present, IEND last, and the zlib stream must inflate completely to exactly the expected size.
export async function validPng(b: Uint8Array): Promise<boolean> {
  try {
    if (!isPng(b) || b.length < 57) return false;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 8, first = true, ended = false, w = 0, h = 0, bd = 0, ct = 0, il = 0; const idat: Uint8Array[] = [];
    while (o + 12 <= b.length) {
      const len = v.getUint32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (len > b.length - o - 12) return false;
      const d = b.subarray(o + 8, o + 8 + len);
      if (first) { if (type !== "IHDR" || len !== 13) return false; const dv = new DataView(d.buffer, d.byteOffset, 13); w = dv.getUint32(0); h = dv.getUint32(4); bd = d[8]; ct = d[9]; il = d[12]; first = false; }
      else if (type === "IDAT") idat.push(d);
      if (type === "IEND") { ended = o + 12 + len === b.length; break; }
      o += 12 + len;
    }
    if (!ended || !idat.length || !w || !h || w > 12000 || h > 12000 || il !== 0) return false;
    const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ct]; if (!ch) return false;
    const expect = (Math.ceil((w * ch * bd) / 8) + 1) * h;
    const all = new Uint8Array(idat.reduce((a, x) => a + x.length, 0)); let p = 0; for (const x of idat) { all.set(x, p); p += x.length; }
    const out = await new Response(new Blob([all]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
    return out.byteLength === expect;
  } catch { return false; }
}
export const validJpeg = (b: Uint8Array) => isJpeg(b) && b.length > 200 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

export async function sha256(b: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as unknown as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join(""); }

type Box = { x: number; y: number; w: number; h: number };
export type Layout = { sig: Box & { page: number }; name: Box & { page?: number }; date: { x: number; y: number; h: number; page?: number } };
const frac = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
export function cleanLayout(l: any, pages: number): Layout | null {
  const box = (b: any) => b && frac(b.x) && frac(b.y) && frac(b.w) && frac(b.h) && b.w > 0.01 && b.h > 0.005 && b.x + b.w <= 1.001 && b.y + b.h <= 1.001;
  if (!l || !box(l.sig) || !box(l.name) || !l.date || !frac(l.date.x) || !frac(l.date.y) || !frac(l.date.h) || l.date.h < 0.005) return null;
  const pg = (p: unknown) => (Number.isInteger(p) && (p as number) >= 0 && (p as number) < pages ? (p as number) : pages - 1);
  return { sig: { x: l.sig.x, y: l.sig.y, w: l.sig.w, h: l.sig.h, page: pg(l.sig.page) }, name: { x: l.name.x, y: l.name.y, w: l.name.w, h: l.name.h, page: pg(l.name.page ?? l.sig.page) }, date: { x: l.date.x, y: l.date.y, h: l.date.h, page: pg(l.date.page ?? l.sig.page) } };
}

const hits = new Map<string, number[]>();
function limited(k: string): boolean { const n = Date.now(), a = (hits.get(k) ?? []).filter((t) => n - t < 300_000); a.push(n); hits.set(k, a); if (hits.size > 3000) for (const [x, v] of hits) if (v.every((t) => n - t >= 300_000)) hits.delete(x); return a.length > 40; }

/** Original page images + the customer's signature, name and date at the configured spots, then one certificate page. Original images are embedded as-is. */
export async function buildFinalPdf(pages: { bytes: Uint8Array; mime: string }[], layout: Layout, sig: Uint8Array, nameImg: Uint8Array | null, info: { number: string; signedAt: Date; userId: string; version: number; originalSha: string; contractId: string }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sigImg = await pdf.embedPng(sig), nmImg = nameImg ? await pdf.embedPng(nameImg) : null;
  const W = 595.28;
  const fit = (img: { width: number; height: number }, bx: number, by: number, bw: number, bh: number) => { const s = Math.min(bw / img.width, bh / img.height); const w = img.width * s, h = img.height * s; return { x: bx + (bw - w) / 2, y: by + (bh - h) / 2, width: w, height: h }; };
  for (let i = 0; i < pages.length; i++) {
    const img = pages[i].mime === "image/png" ? await pdf.embedPng(pages[i].bytes) : await pdf.embedJpg(pages[i].bytes);
    const H = W * img.height / img.width, page = pdf.addPage([W, H]);
    page.drawImage(img, { x: 0, y: 0, width: W, height: H });
    const place = (im: PDFImage, b: Box) => page.drawImage(im, fit(im, b.x * W, H - (b.y + b.h) * H, b.w * W, b.h * H));
    if (layout.sig.page === i) place(sigImg, layout.sig);
    if (nmImg && (layout.name.page ?? layout.sig.page) === i) place(nmImg, layout.name);
    if ((layout.date.page ?? layout.sig.page) === i) {
      const d = info.signedAt, txt = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`, size = Math.max(7, layout.date.h * H);
      page.drawText(txt, { x: layout.date.x * W, y: H - layout.date.y * H - size, size, font: helv, color: rgb(0, 0, 0) });
    }
  }
  const c = pdf.addPage([595.28, 841.89]); let y = 780;
  c.drawText("IBTIKAR - Electronic signature certificate", { x: 50, y, size: 16, font: bold }); y -= 34;
  const row = (k: string, v: string) => { c.drawText(k, { x: 50, y, size: 9, font: bold }); c.drawText(v, { x: 190, y, size: 9, font: helv }); y -= 18; };
  row("Contract number", info.number); row("Contract id", info.contractId); row("Template version", String(info.version));
  row("Signed at (UTC)", info.signedAt.toISOString()); row("Signer account id", info.userId);
  c.drawText("Original pages SHA-256", { x: 50, y, size: 9, font: bold }); y -= 14;
  c.drawText(info.originalSha.slice(0, 32), { x: 50, y, size: 9, font: helv }); y -= 12; c.drawText(info.originalSha.slice(32), { x: 50, y, size: 9, font: helv }); y -= 28;
  for (const l of ["The contract pages in this document are the unaltered original images approved by IBTIKAR.", "The signature, name and date were added by the customer through the customer's own IBTIKAR account.", "A drawn signature is a record of the customer's consent and does not by itself prove identity;", "the platform keeps the account, time, device and event trail with the signed file."]) { c.drawText(l, { x: 50, y, size: 9, font: helv }); y -= 14; }
  return await pdf.save();
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
  const staff = ["super_admin", "admin"].includes(prof.role), isSuper = prof.role === "super_admin";
  if (limited(user.id)) return json({ error: "rate_limited" }, 429);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  try {
    // ---------- Super Admin: upload the official contract once (new version each time) ----------
    if (b.action === "template_upload") {
      if (!isSuper) return json({ error: "forbidden" }, 403);
      const inPages = Array.isArray(b.pages) ? b.pages : [];
      if (!inPages.length || inPages.length > MAX_PAGES) return json({ error: "bad_page_count" }, 400);
      const checked: { bytes: Uint8Array; mime: string; w: number; h: number; sha: string }[] = [];
      const probe = await PDFDocument.create();
      for (const p of inPages) {
        const bytes = b64(p?.b64);
        if (!bytes || bytes.length > MAX_PAGE_BYTES) return json({ error: "file_too_large_or_invalid" }, 400);
        const mime = isPng(bytes) ? "image/png" : isJpeg(bytes) ? "image/jpeg" : "";
        if (!mime) return json({ error: "unsupported_file_type" }, 400);   // the real bytes decide, never the extension
        if (!(mime === "image/png" ? await validPng(bytes) : validJpeg(bytes))) return json({ error: "corrupt_image" }, 400);
        let im; try { im = mime === "image/png" ? await probe.embedPng(bytes) : await probe.embedJpg(bytes); } catch { return json({ error: "corrupt_image" }, 400); }
        if (im.width < 600 || im.height < 600 || im.width > 8000 || im.height > 12000) return json({ error: "bad_dimensions" }, 400);
        checked.push({ bytes, mime, w: im.width, h: im.height, sha: await sha256(bytes) });
      }
      const layout = cleanLayout(b.layout, checked.length);
      if (!layout) return json({ error: "bad_layout" }, 400);
      const folder = `templates/${crypto.randomUUID()}`, pages: unknown[] = [];
      for (let i = 0; i < checked.length; i++) {
        const path = `${folder}/${i + 1}.${checked[i].mime === "image/png" ? "png" : "jpg"}`;
        const up = await db.storage.from(BUCKET).upload(path, checked[i].bytes, { contentType: checked[i].mime, upsert: false });
        if (up.error) return json({ error: "upload_failed" }, 500);
        pages.push({ path, sha256: checked[i].sha, bytes: checked[i].bytes.length, w: checked[i].w, h: checked[i].h, mime: checked[i].mime });
      }
      const { data: vid, error } = await db.rpc("ct_create_template_version", { p_pages: pages, p_layout: layout, p_by: user.id });
      if (error) return json({ error: "save_failed", detail: error.message }, 500);
      return json({ ok: true, version_id: vid });
    }

    // ---------- signed links for viewing ----------
    if (b.action === "urls") {
      let versionId = "", contract: any = null;
      if (UUID.test(String(b.contract_id ?? ""))) {
        const { data: c } = await db.from("project_contracts").select("id,customer_id,status,template_version_id,final_pdf_path,contract_number").eq("id", b.contract_id).maybeSingle();
        if (!c || (c.customer_id !== user.id && !staff)) {
          await db.from("audit_logs").insert({ actor_id: user.id, action: "contract.access_denied", entity: "project_contracts", meta: { id: String(b.contract_id) } });
          return json({ error: "not_found" }, 404);
        }
        contract = c; versionId = c.template_version_id;
      } else if (UUID.test(String(b.version_id ?? "")) && staff) versionId = b.version_id;
      else return json({ error: "bad_request" }, 400);
      const { data: v } = await db.from("contract_template_versions").select("id,version,pages,layout").eq("id", versionId).maybeSingle();
      if (!v) return json({ error: "not_found" }, 404);
      const pages: { url: string | null; w: number; h: number }[] = [];
      for (const p of v.pages as any[]) { const s = await db.storage.from(BUCKET).createSignedUrl(p.path, 600); pages.push({ url: s.data?.signedUrl ?? null, w: p.w, h: p.h }); }
      const out: Record<string, unknown> = { ok: true, version: v.version, pages };
      if (staff) out.layout = v.layout;
      if (contract && ["signed", "approved"].includes(contract.status) && contract.final_pdf_path) out.final_url = (await db.storage.from(BUCKET).createSignedUrl(contract.final_pdf_path, 600)).data?.signedUrl ?? null;
      return json(out);
    }

    // ---------- customer signs ----------
    if (b.action === "sign") {
      if (!UUID.test(String(b.contract_id ?? ""))) return json({ error: "bad_request" }, 400);
      if (b.agree !== true) return json({ error: "agree_required" }, 400);
      const name = String(b.name_text ?? "").trim().slice(0, 120);
      if (name.length < 2) return json({ error: "name_required" }, 400);
      const sig = b64(b.signature_b64);
      if (!sig || !isPng(sig) || sig.length < MIN_SIG || sig.length > MAX_SIG || !(await validPng(sig))) return json({ error: "empty_signature" }, 400);
      const nm = b.name_b64 ? b64(b.name_b64) : null;
      if (b.name_b64 && (!nm || !isPng(nm) || nm.length > MAX_NAME_IMG || !(await validPng(nm)))) return json({ error: "bad_name_image" }, 400);
      const { data: c } = await db.from("project_contracts").select("*").eq("id", b.contract_id).maybeSingle();
      if (!c || c.customer_id !== user.id) {
        await db.from("audit_logs").insert({ actor_id: user.id, action: "contract.sign_denied", entity: "project_contracts", meta: { id: String(b.contract_id) } });
        return json({ error: "not_found" }, 404);   // a customer can never sign (or even learn about) someone else's contract
      }
      if (!["awaiting_signature", "viewed"].includes(c.status)) return json({ error: "not_awaiting_signature" }, 409);
      const { data: ev } = await db.from("contract_events").select("id").eq("contract_id", c.id).eq("type", "all_pages_viewed").limit(1);
      if (!ev?.length) return json({ error: "review_required" }, 409);
      const { data: exists } = await db.from("contract_signatures").select("id").eq("contract_id", c.id).maybeSingle();
      if (exists) return json({ error: "already_signed" }, 409);
      const { data: v } = await db.from("contract_template_versions").select("*").eq("id", c.template_version_id).maybeSingle();
      if (!v) return json({ error: "template_missing" }, 500);
      const pages: { bytes: Uint8Array; mime: string }[] = [];
      for (const p of v.pages as any[]) { const d = await db.storage.from(BUCKET).download(p.path); if (d.error || !d.data) return json({ error: "storage_error" }, 502); pages.push({ bytes: new Uint8Array(await d.data.arrayBuffer()), mime: p.mime }); }
      const now = new Date();
      const pdf = await buildFinalPdf(pages, v.layout as Layout, sig, nm, { number: c.contract_number, signedAt: now, userId: user.id, version: v.version, originalSha: v.original_sha256, contractId: c.id });
      const finalSha = await sha256(pdf), base = `contracts/${c.id}`;
      for (const [path, bytes, type] of [[`${base}/signature.png`, sig, "image/png"], ...(nm ? [[`${base}/name.png`, nm, "image/png"]] : []), [`${base}/final.pdf`, pdf, "application/pdf"]] as [string, Uint8Array, string][]) {
        const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: true });   // upsert: a crash after upload and before the DB step can be retried
        if (up.error) return json({ error: "storage_error" }, 502);
      }
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "", ua = req.headers.get("user-agent") ?? "";
      const { error } = await db.rpc("ct_finalize_signature", { p_contract: c.id, p_user: user.id, p_name: name, p_sig_path: `${base}/signature.png`, p_name_path: nm ? `${base}/name.png` : null, p_pdf_path: `${base}/final.pdf`, p_final_sha: finalSha, p_ip: ip, p_ua: ua });
      if (error) { const m = error.message; const code = /review_required/.test(m) ? "review_required" : /already_signed/.test(m) ? "already_signed" : /not_awaiting/.test(m) ? "not_awaiting_signature" : /forbidden/.test(m) ? "not_found" : "finalize_failed"; return json({ error: code }, code === "finalize_failed" ? 500 : 409); }
      return json({ ok: true, number: c.contract_number, final_sha256: finalSha });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error).message).slice(0, 200) }, 500);
  }
});
