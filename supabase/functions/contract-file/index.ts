// Retired: the old token-based public contract page was replaced by the central contract system (contract-center,
// signed in with the customer's own account). Kept only so old links fail clearly instead of exposing anything.
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
Deno.serve((req) => req.method === "OPTIONS"
  ? new Response(null, { headers: cors })
  : new Response(JSON.stringify({ error: "moved", detail: "contracts now live inside your IBTIKAR account" }), { status: 410, headers: { ...cors, "Content-Type": "application/json" } }));
