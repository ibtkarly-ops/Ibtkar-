"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const docker = require("./docker");
const caddy = require("./caddy");

const APPS_DOMAIN = process.env.APPS_DOMAIN || "apps.ibtkar.ly";
const TEMPLATES_DIR = path.join(__dirname, "templates");
const SITE_LABEL = "ibtikar.site";

function volumeNameFor(siteId) { return `ibtikar-data-${siteId}`; }
function imageTagFor(siteId, deployId) { return `ibtikar-site-${siteId}:${deployId}`; }
function hostnameFor(slug) { return `${slug}.${APPS_DOMAIN}`; }

function writeFilesToDir(baseDir, files) {
  const resolvedBase = fs.realpathSync(baseDir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.resolve(baseDir, rel);
    // Belt-and-suspenders: even though validate.js already rejected any
    // unsafe path, re-confirm the resolved path never escapes baseDir
    // before writing anything to disk.
    if (full !== resolvedBase && !full.startsWith(resolvedBase + path.sep)) {
      throw new Error(`refusing to write outside build context: ${rel}`);
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

/**
 * Builds and runs the new version alongside whatever is currently live,
 * health-checks it, and only then flips Caddy's route over and tears the
 * previous container(s)+image(s) for this site down (found by the
 * `ibtikar.site=<siteId>` Docker label, not by guessing a name — this is
 * what makes cleanup correct across repeated deploys and agent restarts).
 * If anything fails, whatever was already live keeps serving traffic
 * untouched and the error is reported back to the caller.
 */
async function deploySite({ siteId, stack, slug, files, env = {} }) {
  const deployId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), `ibtikar-build-${siteId}-`));
  try {
    writeFilesToDir(buildDir, files);
    const dockerfile = path.join(TEMPLATES_DIR, stack === "php" ? "Dockerfile.php" : "Dockerfile.node");
    const tag = imageTagFor(siteId, deployId);
    await docker.buildImage({ contextDir: buildDir, dockerfile, tag });

    const dataVolume = volumeNameFor(siteId);
    await docker.ensureVolume(dataVolume);

    const newContainerName = `ibtikar-site-${siteId}-${deployId}`;
    const internalPort = stack === "php" ? 80 : 3000;
    // Apache's master process must be able to create its pidfile/lockfile
    // and drop its worker processes from root to www-data (SETUID/SETGID)
    // despite --read-only and --cap-drop ALL; verified against the real
    // php:8.3-apache image — without these, every worker silently stays
    // root instead of www-data. Node needs neither: the official image's
    // `node` user already owns the process end to end.
    const stackExtras = stack === "php"
      ? { extraTmpfs: ["/var/run/apache2:rw,nosuid,size=16m", "/var/lock/apache2:rw,nosuid,size=4m"], capAdd: ["SETUID", "SETGID"] }
      : { extraTmpfs: [], capAdd: [] };
    let hostPort;
    try {
      hostPort = await docker.runContainer({
        name: newContainerName,
        image: tag,
        internalPort,
        dataVolume,
        env: { DB_PATH: "/data/app.sqlite", ...env },
        labels: { [SITE_LABEL]: siteId, "ibtikar.deploy": deployId, "ibtikar.hostname": hostnameFor(slug) },
        ...stackExtras,
      });
    } catch (e) {
      await docker.removeImage(tag);
      throw e;
    }

    const healthy = await docker.waitHealthy(hostPort, { path: "/" });
    if (!healthy) {
      await docker.stopRemoveContainer(newContainerName);
      await docker.removeImage(tag);
      throw new Error("new_deployment_failed_health_check");
    }

    const hostname = hostnameFor(slug);
    await caddy.upsertRoute({ siteId, hostname, port: hostPort });

    // Now that the new version is live and taking traffic, clean up every
    // other container that belongs to this site (previous deploys).
    const siblings = await docker.listContainersByLabel(`${SITE_LABEL}=${siteId}`);
    for (const name of siblings) {
      if (name === newContainerName) continue;
      const oldImage = await docker.imageOfContainer(name);
      await docker.stopRemoveContainer(name);
      if (oldImage) await docker.removeImage(oldImage);
    }

    return { ok: true, url: `https://${hostname}`, port: hostPort, deployId };
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

async function undeploySite({ siteId }) {
  await caddy.removeRoute(siteId).catch(() => {});
  const names = await docker.listContainersByLabel(`${SITE_LABEL}=${siteId}`);
  for (const name of names) {
    const image = await docker.imageOfContainer(name);
    await docker.stopRemoveContainer(name);
    if (image) await docker.removeImage(image);
  }
  // The data volume (customer's SQLite DB) is deliberately kept so a site
  // that gets unpublished and republished later does not lose its data.
  return { ok: true };
}

/**
 * Self-healing step run once when the agent process starts (e.g. after a
 * VPS reboot). Caddy is started with `--resume`, so it normally restores
 * its own last-known routes on its own — but if that ever fails (first
 * boot, a corrupted autosave, Caddy reinstalled), any site container that
 * is still running (thanks to `--restart unless-stopped`) would otherwise
 * be unreachable with no record of why. This re-reads each running
 * container's own `ibtikar.hostname` label — not any external
 * database — and re-registers its Caddy route, so a site that is already
 * running never silently goes dark.
 */
async function reconcileRoutesFromRunningContainers() {
  const names = await docker.listContainersByLabel(SITE_LABEL);
  let restored = 0;
  for (const name of names) {
    try {
      const siteId = await docker.inspectLabel(name, SITE_LABEL);
      const hostname = await docker.inspectLabel(name, "ibtikar.hostname");
      const port = await docker.publishedHostPort(name);
      if (!siteId || !hostname || !port) continue;
      await caddy.upsertRoute({ siteId, hostname, port });
      restored++;
    } catch (e) {
      console.error(`reconcile: failed for ${name}: ${e.message}`);
    }
  }
  return restored;
}

module.exports = { deploySite, undeploySite, hostnameFor, reconcileRoutesFromRunningContainers };
