// Helper for .github/workflows/eas-build.yml
//   node scripts/eas-app.mjs fetch  <dir>                 -> writes the app's project files into <dir>
//   node scripts/eas-app.mjs report <status> [build.json]  -> tells the platform the build status / artifact link
// Needs env: EXPORT_URL, BUILD_SECRET, APP_ID, PLATFORM, PROFILE, RUN
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const { EXPORT_URL, BUILD_SECRET, APP_ID, PLATFORM, PROFILE, RUN } = process.env;
const call = async (body) => {
  const r = await fetch(EXPORT_URL, { method: "POST", headers: { "content-type": "application/json", "x-build-secret": BUILD_SECRET }, body: JSON.stringify({ app_id: APP_ID, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`app-export ${r.status}: ${j.error ?? "error"}`);
  return j;
};

const [cmd, arg, file] = process.argv.slice(2);
if (cmd === "fetch") {
  const j = await call({ action: "export" });
  const root = arg || "app";
  for (const [p, code] of Object.entries(j.files ?? {})) {
    const n = normalize(p);
    if (n.startsWith("..") || n.startsWith("/") || !/^[\w./-]+$/.test(n)) throw new Error("bad path " + p);
    mkdirSync(dirname(join(root, n)), { recursive: true });
    writeFileSync(join(root, n), String(code));
  }
  console.log(`wrote ${Object.keys(j.files ?? {}).length} files for ${j.slug}`);
} else if (cmd === "report") {
  let b = {};
  if (file && existsSync(file)) {
    try { const raw = JSON.parse(readFileSync(file, "utf8")); b = Array.isArray(raw) ? raw[0] ?? {} : raw; } catch { b = {}; }
  }
  const st = String(b.status ?? "").toLowerCase();
  let status = arg !== "auto" ? arg : st === "finished" ? "finished" : st === "errored" ? "errored" : st === "canceled" ? "canceled" : st === "in_progress" ? "in_progress" : "queued";
  if (process.env.JOB_STATUS && process.env.JOB_STATUS !== "success" && !["finished", "errored", "canceled"].includes(status)) status = "errored";
  const owner = b.project?.ownerAccount?.name, slug = b.project?.slug;
  await call({
    action: "report",
    build: {
      id: b.id ?? "", run: RUN, platform: PLATFORM, profile: PROFILE, status,
      url: b.artifacts?.buildUrl ?? b.artifacts?.applicationArchiveUrl ?? "",
      page: owner && slug && b.id ? `https://expo.dev/accounts/${owner}/projects/${slug}/builds/${b.id}` : "",
    },
  });
  console.log("reported", status);
} else {
  console.error("usage: eas-app.mjs fetch <dir> | report <status|auto> [build.json]");
  process.exit(2);
}
