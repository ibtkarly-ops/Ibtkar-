"use strict";
// Talks to Caddy's local admin API (http://127.0.0.1:2019, loopback-only by
// default) to add/update/remove one reverse-proxy route per site, keyed by
// a stable Caddy "@id" (`site-<site_id>`). This is what gives every newly
// deployed site automatic HTTPS with zero manual Nginx/certbot config: the
// moment a route referencing a new hostname exists, Caddy requests and
// renews its certificate on its own.

const http = require("http");

const ADMIN = process.env.CADDY_ADMIN_URL || "http://127.0.0.1:2019";

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(ADMIN + path);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => resolve({ status: res.statusCode, body: chunks }));
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function routeFor(id, hostname, port) {
  return {
    "@id": id,
    match: [{ host: [hostname] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${port}` }] }],
  };
}

async function upsertRoute({ siteId, hostname, port }) {
  const id = `site-${siteId}`;
  const route = routeFor(id, hostname, port);
  const existing = await req("GET", `/id/${id}`);
  if (existing.status === 200) {
    const r = await req("PUT", `/id/${id}`, route);
    if (r.status >= 300) throw new Error(`caddy PUT /id/${id} -> ${r.status}: ${r.body}`);
  } else {
    const r = await req("POST", "/config/apps/http/servers/ibtikar/routes", route);
    if (r.status >= 300) throw new Error(`caddy POST routes -> ${r.status}: ${r.body}`);
  }
}

async function removeRoute(siteId) {
  const id = `site-${siteId}`;
  const r = await req("DELETE", `/id/${id}`);
  if (r.status >= 300 && r.status !== 404) throw new Error(`caddy DELETE /id/${id} -> ${r.status}: ${r.body}`);
}

module.exports = { upsertRoute, removeRoute };
