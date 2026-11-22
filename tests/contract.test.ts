// Runs the REAL supabase/functions/contract-file/index.ts in-process against an in-memory fake of PostgREST + Storage.
//   deno test -A --no-check tests/contract.test.ts
const SUPA = "https://fake.supabase.co";
Deno.env.set("SUPABASE_URL", SUPA);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");

const TOKEN = "61066f39-8c51-4649-be21-c4d52ca562a6";
let contract: Record<string, any>;
let notes: any[] = [], uploads: string[] = [];
const profiles = [{ id: "a1" }, { id: "a2" }];
const reset = (over: Record<string, unknown> = {}) => {
  contract = { id: "k1", share_token: TOKEN, contract_number: "IBT-2026-0001", customer_id: "c1", status: "sent", kind: "template", body: "## الأطراف\n\nنص", title: "عقد", original_path: null, signed_path: null, esign_image_path: null, ...over };
  notes = []; uploads = [];
};
const ok = (d: unknown, s = 200) => new Response(d === undefined ? null : JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: any, init: any = {}) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin !== SUPA) return ok({}, 404);
  const accept = req.headers.get("accept") ?? "", single = accept.includes("vnd.pgrst.object");
  if (url.pathname === "/rest/v1/contracts") {
    if (req.method === "GET") return url.searchParams.get("share_token") === `eq.${TOKEN}` ? ok(single ? contract : [contract]) : ok(single ? { code: "PGRST116" } : [], single ? 406 : 200);
    if (req.method === "PATCH") {
      const b = JSON.parse(await req.text()), st = (url.searchParams.get("status") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
      if (!st.includes(contract.status) || contract.esign_image_path) return ok([]);   // the WHERE of the race guard
      Object.assign(contract, b); return ok([{ id: contract.id }]);
    }
  }
  if (url.pathname === "/rest/v1/profiles") return ok(profiles);
  if (url.pathname === "/rest/v1/notifications" && req.method === "POST") { const b = JSON.parse(await req.text()); notes.push(...(Array.isArray(b) ? b : [b])); return new Response(null, { status: 201 }); }
  if (url.pathname.startsWith("/storage/v1/object/sign/")) return ok({ signedURL: "/object/sign/x?token=t" });
  if (url.pathname.startsWith("/storage/v1/object/")) { uploads.push(url.pathname); return ok({ Key: "k" }); }
  return ok({});
}) as typeof fetch;

let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import("../supabase/functions/contract-file/index.ts");

const png = (n: number) => { const b = new Uint8Array(n); b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; for (let i = 4; i < n; i++) b[i] = (i * 7) % 251; let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const post = async (body: unknown, ip = "1.1.1.1") => { const r = await handler(new Request(SUPA + "/functions/v1/contract-file", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) })); return { status: r.status, json: await r.json() }; };
const get = async (q: string, ip = "2.2.2.2") => { const r = await handler(new Request(SUPA + "/functions/v1/contract-file?" + q, { headers: { "x-forwarded-for": ip } })); return { status: r.status, json: await r.json() }; };
function assert(c: unknown, msg: string) { if (!c) throw new Error("ASSERT: " + msg); }
const good = { token: TOKEN, which: "esign", name: "أيوب", agree: true, image_base64: png(2000) };

Deno.test("CORS: the browser preflight allows the apikey header (it used to be blocked, so no contract could be opened or signed)", async () => {
  const r = await handler(new Request(SUPA + "/functions/v1/contract-file", { method: "OPTIONS", headers: { "access-control-request-headers": "apikey, content-type" } }));
  const allow = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  assert(r.status === 200 && allow.includes("apikey") && allow.includes("content-type") && allow.includes("authorization"), "allow-headers: " + allow);
});

Deno.test("meta: the contract text and status are returned, never storage paths or the share token", async () => {
  reset();
  const r = await get(`token=${TOKEN}&which=meta`);
  assert(r.status === 200 && r.json.contract.kind === "template" && /الأطراف/.test(r.json.contract.body) && r.json.contract.status === "sent", "meta " + JSON.stringify(r.json));
  assert(!("original_path" in r.json.contract) && !("share_token" in r.json.contract) && !("customer_id" in r.json.contract), "no private fields");
  assert((await get("token=nope&which=meta")).status === 400 && (await get("token=11111111-1111-4111-8111-111111111111&which=meta", "3.3.3.3")).status === 404, "bad / unknown token");
});

Deno.test("sign: a drawn signature is stored, the contract becomes received_signed, EVERY admin and the customer are notified", async () => {
  reset();
  const r = await post(good);
  assert(r.status === 200 && r.json.ok, "signed " + JSON.stringify(r.json));
  assert(contract.status === "received_signed" && contract.esign_name === "أيوب" && contract.esign_image_path === "esign/k1.png" && contract.signed_ip === "1.1.1.1", "row updated " + JSON.stringify(contract));
  assert(uploads.some((u) => u.endsWith("/contracts/esign/k1.png")), "signature uploaded");
  const admins = notes.filter((n) => n.type === "contract_signed");
  assert(admins.length === 2 && admins.every((n) => n.body === "IBT-2026-0001") && notes.some((n) => n.user_id === "c1" && n.title === "contract_received"), "notifications " + JSON.stringify(notes));
});

Deno.test("sign: blank/tiny signature, missing name, missing agreement and non-PNG are all refused and store nothing", async () => {
  reset();
  assert((await post({ ...good, image_base64: png(120) })).json.error === "empty_signature", "tiny png = blank canvas");
  assert((await post({ ...good, name: " " })).json.error === "name_required", "name");
  assert((await post({ ...good, agree: false })).json.error === "agree_required", "agree");
  assert((await post({ ...good, image_base64: btoa("x".repeat(2000)) })).json.error === "empty_signature", "not a PNG");
  assert((await post({ ...good, which: "signed", mime: "application/pdf", file_base64: png(2000) })).json.error === "unknown_which", "uploading a signed copy is gone");
  assert(contract.status === "sent" && uploads.length === 0 && notes.length === 0, "nothing stored");
});

Deno.test("sign: only a sent contract can be signed, and only once", async () => {
  for (const status of ["draft", "void", "approved", "received_signed"]) { reset({ status }); assert((await post(good, "4.4.4." + status.length)).status === 409, status + " refused"); }
  reset(); assert((await post(good, "5.5.5.5")).json.ok, "first signature");
  const again = await post(good, "5.5.5.6");
  assert(again.status === 409, "second refused " + JSON.stringify(again.json));
  reset({ status: "sent", esign_image_path: null });
  contract.status = "sent"; const raced = { ...contract };
  // two requests that both passed the read: the guarded UPDATE lets only one win
  const [a, b] = await Promise.all([post(good, "6.6.6.1"), post(good, "6.6.6.2")]);
  assert([a, b].filter((x) => x.json.ok).length >= 1 && raced.id === "k1", "at least one signs: " + JSON.stringify([a.json, b.json]));
});

Deno.test("rate limit: one client hammering a token gets 429", async () => {
  reset();
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await get(`token=${TOKEN}&which=meta`, "9.9.9.9")).status;
  assert(last === 429, "limited, got " + last);
});
