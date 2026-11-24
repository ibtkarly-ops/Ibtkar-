// deno test -A --no-check tests/contract.test.ts
// The old token-based public contract function is retired: every call says "moved" (410) and exposes nothing.
let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import("../supabase/functions/contract-file/index.ts");
function assert(c: unknown, msg: string) { if (!c) throw new Error("ASSERT: " + msg); }
Deno.test("retired contract-file: GET and POST answer 410 and nothing else; CORS preflight still works", async () => {
  for (const m of ["GET", "POST"]) {
    const r = await handler(new Request("https://x.supabase.co/functions/v1/contract-file?token=61066f39-8c51-4649-be21-c4d52ca562a6&which=meta", { method: m, body: m === "POST" ? JSON.stringify({ token: "x", which: "esign" }) : undefined }));
    const j = await r.json();
    assert(r.status === 410 && j.error === "moved" && !("contract" in j) && !("url" in j), m + " → " + r.status + JSON.stringify(j));
  }
  assert((await handler(new Request("https://x.supabase.co/functions/v1/contract-file", { method: "OPTIONS" }))).status === 200, "OPTIONS");
});
