// deno test -A --no-check tests/contract-center.test.ts
// Runs the REAL contract-center function against an in-memory fake of PostgREST/Storage/Auth, with real image bytes and real pdf-lib.
import { PDFDocument } from "npm:pdf-lib@1.17.1";
const SUPA = "https://fake.supabase.co";
Deno.env.set("SUPABASE_URL", SUPA); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc");

const FIXTURE = Deno.env.get("CONTRACT_FIXTURE") ?? "";   // optional: a real contract image to also test with
// a valid 700x1000 white PNG made on the fly (no external fixtures needed)
async function whitePng(w = 700, h = 1000, noise = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create(); doc.addPage([10, 10]); void doc;
  const bytes = new Uint8Array((await new Response(new Blob([]).stream()).arrayBuffer()));
  void bytes;
  // build the PNG by hand: signature + IHDR + one IDAT (stored deflate blocks) + IEND
  const crcT: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Uint8Array) => { const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer); v.setUint32(0, d.length); o.set(new TextEncoder().encode(t), 4); o.set(d, 8); v.setUint32(8 + d.length, crc(o.subarray(4, 8 + d.length))); return o; };
  const ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer); iv.setUint32(0, w); iv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 0;
  const raw = new Uint8Array((w + 1) * h).fill(255); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  if (noise) { let r = 12345; for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 3) { r = (r * 1103515245 + 12345) & 0x7fffffff; if ((r >> 8) % 5 === 0) raw[y * (w + 1) + 1 + x] = (r >> 16) & 255; } }
  const z = new Uint8Array((await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer()));
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
const sigPng = () => whitePng(300, 120, true);   // ink-like noise so it is not a blank image
const b64 = (u: Uint8Array) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };

const USERS: Record<string, string> = { "tok-super": "super", "tok-c1": "c1", "tok-c2": "c2" };
const PROFILES: Record<string, any> = { super: { role: "super_admin", status: "active" }, c1: { role: "customer", status: "active" }, c2: { role: "customer", status: "active" } };
let T: Record<string, any[]>, files: Map<string, Uint8Array>, rpcs: any[];
const reset = () => {
  T = { project_contracts: [{ id: "11111111-1111-4111-8111-111111111111", customer_id: "c1", status: "viewed", template_version_id: "v1", contract_number: "IBT-C-2026-0001", website_id: "w1", final_pdf_path: null }],
    contract_events: [{ id: 1, contract_id: "11111111-1111-4111-8111-111111111111", type: "all_pages_viewed" }], contract_signatures: [], contract_template_versions: [], audit_logs: [] };
  files = new Map(); rpcs = [];
};
const ok = (d: unknown, s = 200) => new Response(d === undefined ? null : JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const req = new Request(input, init), url = new URL(req.url), p = url.pathname;
  if (url.origin !== SUPA) return ok({}, 404);
  if (p === "/auth/v1/user") { const id = USERS[(req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")]; return id ? ok({ id, aud: "authenticated", role: "authenticated" }) : ok({ msg: "bad" }, 401); }
  if (p.startsWith("/rest/v1/rpc/")) { const fn = p.split("/").pop()!, body = JSON.parse(await req.text() || "{}"); rpcs.push({ fn, body });
    if (fn === "ct_create_template_version") { const id = "v" + (T.contract_template_versions.length + 1); T.contract_template_versions.push({ id, version: T.contract_template_versions.length + 1, pages: body.p_pages, layout: body.p_layout, original_sha256: "ab".repeat(32) }); return ok(id); }
    if (fn === "ct_finalize_signature") { const c = T.project_contracts.find((x) => x.id === body.p_contract); if (c.status === "signed") return ok({ message: "already_signed" }, 400); c.status = "signed"; c.final_pdf_path = body.p_pdf_path; T.contract_signatures.push({ contract_id: c.id }); return ok({ ok: true }); }
    return ok(null); }
  if (p.startsWith("/storage/v1/object/sign/")) return ok({ signedURL: "/object/sign/x?token=t" });
  if (p.startsWith("/storage/v1/object/")) { const key = p.replace("/storage/v1/object/", "");
    if (req.method === "POST") { files.set(key, new Uint8Array(await req.arrayBuffer())); return ok({ Key: key }); }
    const f = files.get(key); return f ? new Response(f) : ok({ message: "not found" }, 404); }
  if (p.startsWith("/rest/v1/")) { const table = p.split("/")[3];
    if (req.method === "POST") { const b = JSON.parse(await req.text()); (T[table] ??= []).push(...(Array.isArray(b) ? b : [b])); return new Response(null, { status: 201 }); }
    let rows = (T[table] ?? []).slice(); for (const [k, v] of url.searchParams) { if (typeof v === "string" && v.startsWith("eq.")) rows = rows.filter((r) => String(r[k]) === v.slice(3)); }
    if (table === "profiles") { const id = url.searchParams.get("id")?.slice(3) ?? ""; rows = PROFILES[id] ? [PROFILES[id]] : []; }
    return (req.headers.get("accept") ?? "").includes("vnd.pgrst.object") ? (rows.length ? ok(rows[0]) : ok({ code: "PGRST116" }, 406)) : ok(rows); }
  return ok({});
}) as typeof fetch;

let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import("../supabase/functions/contract-center/index.ts");
const call = async (tok: string, body: unknown) => { const r = await handler(new Request(SUPA + "/functions/v1/contract-center", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify(body) })); return { status: r.status, json: await r.json() }; };
function assert(c: unknown, msg: string) { if (!c) throw new Error("ASSERT: " + msg); }
// calibrated on the official IBTIKAR contract image (client block, bottom-right of the last page)
export const REAL_LAYOUT = { sig: { page: 0, x: 0.565, y: 0.892, w: 0.31, h: 0.025 }, name: { x: 0.565, y: 0.869, w: 0.31, h: 0.018 }, date: { x: 0.62, y: 0.924, h: 0.013 } };
const LAYOUT = { sig: { page: 0, x: 0.55, y: 0.89, w: 0.34, h: 0.04 }, name: { x: 0.57, y: 0.86, w: 0.31, h: 0.028 }, date: { x: 0.58, y: 0.94, h: 0.016 } };

Deno.test("template upload: only the Super Admin, only real PNG/JPEG bytes, originals stored untouched with their SHA-256", async () => {
  reset(); const png = await whitePng();
  assert((await call("tok-c1", { action: "template_upload", pages: [{ b64: b64(png) }], layout: LAYOUT })).status === 403, "customer refused");
  assert((await call("tok-super", { action: "template_upload", pages: [{ b64: btoa("<html><script>alert(1)</script></html>".repeat(40)) }], layout: LAYOUT })).json.error === "unsupported_file_type", "html disguised as an image refused");
  const half = png.slice(0, 200); assert((await call("tok-super", { action: "template_upload", pages: [{ b64: b64(half) }], layout: LAYOUT })).json.error === "corrupt_image", "truncated image refused");
  assert((await call("tok-super", { action: "template_upload", pages: [{ b64: b64(png) }], layout: { ...LAYOUT, sig: { page: 0, x: 0.9, y: 0.9, w: 0.5, h: 0.5 } } })).json.error === "bad_layout", "box outside the page refused");
  const r = await call("tok-super", { action: "template_upload", pages: [{ b64: b64(png) }, { b64: b64(png) }], layout: { ...LAYOUT, sig: { ...LAYOUT.sig, page: 1 } } });
  assert(r.json.ok && T.contract_template_versions.length === 1, "uploaded " + JSON.stringify(r.json));
  const stored = [...files.entries()].filter(([k]) => k.includes("/templates/"));
  assert(stored.length === 2 && stored.every(([, v]) => v.length === png.length && v.every((x, i) => x === png[i])), "original bytes stored exactly as uploaded");
  assert(T.contract_template_versions[0].pages[0].sha256.length === 64 && T.contract_template_versions[0].layout.sig.page === 1, "hash + layout recorded");
});

async function seedVersion() { const png = await whitePng(); await call("tok-super", { action: "template_upload", pages: [{ b64: b64(png) }], layout: LAYOUT }); T.project_contracts[0].template_version_id = T.contract_template_versions[0].id; return png; }

Deno.test("sign: another customer gets 'not found' (and it is logged); empty/forged/unreviewed signatures are refused", async () => {
  reset(); await seedVersion(); const id = T.project_contracts[0].id, sig = b64(await sigPng());
  assert((await call("tok-c2", { action: "sign", contract_id: id, signature_b64: sig, name_text: "عميل", agree: true })).status === 404, "customer 2 cannot sign customer 1's contract");
  assert(T.audit_logs.some((a) => a.action === "contract.sign_denied"), "attempt is audited");
  assert((await call("tok-c1", { action: "sign", contract_id: id, signature_b64: b64(new Uint8Array(200)), name_text: "عميل", agree: true })).json.error === "empty_signature", "blank/fake signature");
  assert((await call("tok-c1", { action: "sign", contract_id: id, signature_b64: sig, name_text: "عميل", agree: false })).json.error === "agree_required", "must agree");
  T.contract_events.length = 0;
  assert((await call("tok-c1", { action: "sign", contract_id: id, signature_b64: sig, name_text: "عميل", agree: true })).json.error === "review_required", "cannot sign without reviewing every page");
  assert(T.contract_signatures.length === 0 && T.project_contracts[0].status === "viewed", "nothing stored");
});

Deno.test("sign: builds the final PDF from the ORIGINAL pages + certificate page, hashes it, finalizes atomically, and a repeat is refused", async () => {
  reset(); const png = await seedVersion(); const id = T.project_contracts[0].id, sig = b64(await sigPng());
  const r = await call("tok-c1", { action: "sign", contract_id: id, signature_b64: sig, name_b64: b64(await sigPng()), name_text: "عميل تجريبي", agree: true });
  assert(r.status === 200 && r.json.ok && r.json.final_sha256.length === 64, "signed " + JSON.stringify(r.json));
  const pdfKey = [...files.keys()].find((k) => k.endsWith(`/contracts/${id}/final.pdf`))!;
  const pdf = await PDFDocument.load(files.get(pdfKey)!);
  assert(pdf.getPageCount() === 2, "1 original page + 1 certificate page: " + pdf.getPageCount());
  assert(Math.abs(pdf.getPage(0).getHeight() / pdf.getPage(0).getWidth() - 1000 / 700) < 0.001, "page keeps the original aspect ratio (no distortion)");
  assert(T.project_contracts[0].status === "signed" && T.contract_signatures.length === 1, "database finalized");
  assert([...files.entries()].filter(([k]) => k.includes("/templates/")).every(([, v]) => v.length === png.length), "template originals untouched by signing");
  const again = await call("tok-c1", { action: "sign", contract_id: id, signature_b64: sig, name_text: "عميل", agree: true });
  assert(again.status === 409, "second signature refused " + JSON.stringify(again.json));
});

Deno.test("urls: owner and staff get short-lived links, another customer does not; the final PDF link only after signing", async () => {
  reset(); await seedVersion(); const id = T.project_contracts[0].id;
  assert((await call("tok-c2", { action: "urls", contract_id: id })).status === 404, "other customer: 404");
  const mine = await call("tok-c1", { action: "urls", contract_id: id });
  assert(mine.json.ok && mine.json.pages.length === 1 && !mine.json.final_url && !mine.json.layout, "owner sees pages only, no layout, no final yet");
  assert((await call("tok-super", { action: "urls", contract_id: id })).json.layout, "staff also get the layout");
  assert((await call("tok-c1", { action: "urls", version_id: "v1" })).status === 400, "a customer cannot browse templates");
});

if (FIXTURE) Deno.test("real contract image: stamping works on the actual uploaded contract", async () => {
  reset(); const real = await Deno.readFile(FIXTURE); const r = await call("tok-super", { action: "template_upload", pages: [{ b64: b64(real) }], layout: REAL_LAYOUT });
  assert(r.json.ok, "real image accepted " + JSON.stringify(r.json));
  T.project_contracts[0].template_version_id = T.contract_template_versions[0].id;
  const s = await call("tok-c1", { action: "sign", contract_id: T.project_contracts[0].id, signature_b64: b64(await sigPng()), name_b64: b64(await sigPng()), name_text: "Test", agree: true });
  assert(s.json.ok, "signed real contract");
  await Deno.writeFile(Deno.env.get("CONTRACT_OUT") ?? "/tmp/final-test.pdf", files.get([...files.keys()].find((k) => k.endsWith("final.pdf"))!)!);
});
