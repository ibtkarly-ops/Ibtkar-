"use strict";
// Thin wrapper around the `docker` CLI. Every call uses execFile with an
// argument array (never a shell string), so nothing here is vulnerable to
// shell injection even though some arguments (site ids, tags) are derived
// from caller input — they're already validated in validate.js before they
// ever reach this module, but execFile's no-shell behaviour is a second,
// independent layer of the same protection.

const { execFile } = require("child_process");
const net = require("net");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      resolve(String(stdout).trim());
    });
  });
}

async function buildImage({ contextDir, dockerfile, tag }) {
  // No --pull here on purpose: a transient registry hiccup should not take
  // down redeploys of sites whose base image is already cached locally.
  // Refresh base images deliberately and separately (e.g. a periodic
  // `docker pull php:8.3-apache && docker pull node:22-alpine` cron job
  // on the VPS), not implicitly on every single site deploy.
  await run("docker", ["build", "-f", dockerfile, "-t", tag, contextDir], { timeout: 180_000 });
}

async function removeImage(tag) {
  try { await run("docker", ["rmi", "-f", tag]); } catch { /* best effort */ }
}

async function containerExists(name) {
  try {
    const out = await run("docker", ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]);
    return out.split("\n").includes(name);
  } catch { return false; }
}

async function stopRemoveContainer(name) {
  if (!(await containerExists(name))) return;
  await run("docker", ["rm", "-f", name]).catch(() => {});
}

/** Finds a free TCP port on loopback by asking the OS for one, then releasing it. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Runs a freshly built image as a hardened, isolated container.
 * - read-only root filesystem (except a small noexec tmpfs and the named
 *   data volume the app itself asked for)
 * - all Linux capabilities dropped, no-new-privileges
 * - hard memory/CPU/pids caps so one bad site can't starve the VPS
 * - published only to 127.0.0.1 on a random port (Caddy is the only thing
 *   that talks to it from the host; it is never reachable directly from
 *   the internet)
 */
async function runContainer({ name, image, internalPort, dataVolume, env = {}, labels = {}, extraTmpfs = [], capAdd = [] }) {
  const hostPort = await findFreePort();
  const args = [
    "run", "-d", "--name", name,
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${hostPort}:${internalPort}`,
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--pids-limit", "128",
    "--memory", "256m",
    "--memory-swap", "256m",
    "--cpus", "0.5",
  ];
  for (const t of extraTmpfs) args.push("--tmpfs", t);
  for (const c of capAdd) args.push("--cap-add", c);
  if (dataVolume) args.push("-v", `${dataVolume}:/data`);
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  args.push(image);
  await run("docker", args);
  return hostPort;
}

/** Lists containers (running or stopped) carrying a given label=value, newest first. */
async function listContainersByLabel(label) {
  const out = await run("docker", ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

async function imageOfContainer(name) {
  try { return await run("docker", ["inspect", "--format", "{{.Config.Image}}", name]); } catch { return null; }
}

async function inspectLabel(name, label) {
  try {
    const out = await run("docker", ["inspect", "--format", `{{ index .Config.Labels "${label}" }}`, name]);
    return out || null;
  } catch { return null; }
}

/** The host-side port Docker published this container's main port to, or null. */
async function publishedHostPort(name) {
  try {
    const out = await run("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]);
    const ports = JSON.parse(out);
    for (const bindings of Object.values(ports || {})) {
      if (Array.isArray(bindings) && bindings[0] && bindings[0].HostPort) return Number(bindings[0].HostPort);
    }
    return null;
  } catch { return null; }
}

function httpGetOk(port, path = "/") {
  return new Promise((resolve) => {
    const http = require("http");
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 4000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500); // 4xx still proves the app answered
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(port, { tries = 10, delayMs = 1500, path = "/" } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await httpGetOk(port, path)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function ensureVolume(name) {
  await run("docker", ["volume", "create", name]).catch(() => {});
}

module.exports = { buildImage, removeImage, stopRemoveContainer, runContainer, waitHealthy, ensureVolume, containerExists, listContainersByLabel, imageOfContainer, inspectLabel, publishedHostPort };
