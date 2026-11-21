"use strict";
// Validation for an AI-generated multi-file project before it ever touches
// disk or Docker. Everything here is deliberately strict and fails closed:
// a project that doesn't fit the expected shape is rejected, not "fixed up".

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024; // 512KB per file
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8MB per project

const STACKS = ["php", "node"];

function isSafeRelPath(p) {
  if (typeof p !== "string" || !p || p.length > 200) return false;
  if (!SAFE_PATH_RE.test(p)) return false;
  if (p.includes("..")) return false; // blocks path traversal outright
  if (p.startsWith("/")) return false;
  const parts = p.split("/");
  if (parts.some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return true;
}

// The only extra environment variables Supabase is allowed to pass through
// to a site's container. Anything else in `body.env` is silently dropped —
// this is a fixed allowlist, not a generic passthrough, specifically so a
// compromised or buggy caller can never inject arbitrary env into customer
// containers (e.g. to override DB_PATH, PORT, or something Docker-related).
const ALLOWED_ENV_KEYS = ["ADMIN_USER", "ADMIN_PASSWORD"];

function sanitizeEnv(env) {
  const out = {};
  if (!env || typeof env !== "object") return out;
  for (const k of ALLOWED_ENV_KEYS) {
    if (typeof env[k] === "string" && env[k].length > 0 && env[k].length <= 200) out[k] = env[k];
  }
  return out;
}

/** @returns {{ok:true}|{ok:false,error:string}} */
function validateDeployRequest(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "bad_body" };
  const { site_id, stack, slug, files } = body;

  if (!SITE_ID_RE.test(String(site_id ?? ""))) return { ok: false, error: "bad_site_id" };
  if (!STACKS.includes(stack)) return { ok: false, error: "bad_stack" };
  if (!SLUG_RE.test(String(slug ?? ""))) return { ok: false, error: "bad_slug" };
  if (!files || typeof files !== "object" || Array.isArray(files)) return { ok: false, error: "bad_files" };

  const paths = Object.keys(files);
  if (paths.length === 0) return { ok: false, error: "no_files" };
  if (paths.length > MAX_FILES) return { ok: false, error: "too_many_files" };

  let total = 0;
  for (const p of paths) {
    if (!isSafeRelPath(p)) return { ok: false, error: `unsafe_path:${p}` };
    const content = files[p];
    if (typeof content !== "string") return { ok: false, error: `non_string_content:${p}` };
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) return { ok: false, error: `file_too_large:${p}` };
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) return { ok: false, error: "project_too_large" };

  if (stack === "php") {
    if (!("public/index.php" in files)) return { ok: false, error: "missing_entrypoint:public/index.php" };
    // The AI must never be able to ship its own web server config, auth
    // bypass, or reach outside the fixed docroot the base image serves.
    for (const p of paths) {
      if (p === ".htaccess" || p.endsWith("/.htaccess")) return { ok: false, error: "htaccess_not_allowed" };
      if (!p.startsWith("public/") && !p.startsWith("src/")) return { ok: false, error: `path_outside_project_layout:${p}` };
    }
  } else if (stack === "node") {
    if (!("package.json" in files)) return { ok: false, error: "missing_entrypoint:package.json" };
    if (!("server.js" in files)) return { ok: false, error: "missing_entrypoint:server.js" };
    let pkg;
    try { pkg = JSON.parse(files["package.json"]); } catch { return { ok: false, error: "bad_package_json" }; }
    if (pkg.scripts && pkg.scripts.preinstall) return { ok: false, error: "preinstall_script_not_allowed" };
    if (pkg.scripts && pkg.scripts.postinstall) return { ok: false, error: "postinstall_script_not_allowed" };
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    for (const dep of Object.keys(deps)) {
      const ver = String(deps[dep] ?? "");
      if (/^(file:|git|http|github:)/i.test(ver)) return { ok: false, error: `unsafe_dependency_source:${dep}` };
    }
  }

  return { ok: true };
}

module.exports = { validateDeployRequest, isSafeRelPath, sanitizeEnv, SITE_ID_RE, SLUG_RE };
