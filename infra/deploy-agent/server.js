"use strict";
const crypto = require("crypto");
const express = require("express");
const { validateDeployRequest, sanitizeEnv, SITE_ID_RE } = require("./validate");
const { deploySite, undeploySite, reconcileRoutesFromRunningContainers } = require("./deploy");

const PORT = Number(process.env.AGENT_PORT || 8099);
const SECRET = process.env.DEPLOY_AGENT_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error("FATAL: DEPLOY_AGENT_SECRET is not set or too short (>=32 chars). Refusing to start.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "12mb" }));

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // still do a comparison of equal-length buffers to avoid a length leak
    // being a meaningfully faster timing signal than a full mismatch
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function requireAuth(req, res, next) {
  const hdr = req.get("authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!token || !timingSafeEqual(token, SECRET)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// In-process queue: never run two Docker builds for the SAME site at once
// (a slow double-click or a retry storm could otherwise race two deploys
// against the same container name / data volume). Different sites deploy
// fully in parallel.
const siteLocks = new Map();
function withSiteLock(siteId, fn) {
  const prev = siteLocks.get(siteId) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (siteLocks.get(siteId) === next) siteLocks.delete(siteId); });
  siteLocks.set(siteId, next);
  return next;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/deploy", requireAuth, async (req, res) => {
  const check = validateDeployRequest(req.body);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
  const { site_id, stack, slug, files } = req.body;
  const env = sanitizeEnv(req.body.env);
  try {
    const result = await withSiteLock(site_id, () => deploySite({ siteId: site_id, stack, slug, files, env }));
    res.json(result);
  } catch (e) {
    console.error(`deploy failed for ${site_id}:`, e.message);
    res.status(502).json({ ok: false, error: String(e.message).slice(0, 500) });
  }
});

app.post("/remove", requireAuth, async (req, res) => {
  const siteId = String(req.body && req.body.site_id);
  if (!SITE_ID_RE.test(siteId)) return res.status(400).json({ ok: false, error: "bad_site_id" });
  try {
    const result = await withSiteLock(siteId, () => undeploySite({ siteId }));
    res.json(result);
  } catch (e) {
    console.error(`remove failed for ${siteId}:`, e.message);
    res.status(502).json({ ok: false, error: String(e.message).slice(0, 500) });
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: "not_found" }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("unhandled error:", err);
  res.status(500).json({ ok: false, error: "server_error" });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`ibtikar-deploy-agent listening on 127.0.0.1:${PORT}`);
  // Best-effort self-healing: see reconcileRoutesFromRunningContainers()'s
  // own comment for why this exists. A failure here must never crash the
  // agent — it only means Caddy's own --resume did its job already.
  reconcileRoutesFromRunningContainers()
    .then((n) => { if (n) console.log(`reconciled ${n} route(s) from already-running containers`); })
    .catch((e) => console.error("startup reconciliation failed (non-fatal):", e.message));
});
