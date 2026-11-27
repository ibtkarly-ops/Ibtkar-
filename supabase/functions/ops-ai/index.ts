// AI operations centre (owner only). The owner saves a server ONCE (credentials are encrypted and never shown again) and then talks to the AI,
// which inspects and fixes the servers over SSH. Every command is classified, logged, and the destructive ones wait for the owner's approval
// unless that server was switched to full autonomy. A scheduled sweep checks the servers, restarts watched services that died, and raises alerts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { clip, redact } from "./risk.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { runSsh, type Target } from "./ssh.ts";
import { converse, healthCheck, runCommand, type Deps, type ExecOut, type Msg, type RunRow, type Srv } from "./core.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const SUPA = Deno.env.get("SUPABASE_URL")!, ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SUPA, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SVC = /^[A-Za-z0-9@._-]{1,60}$/;

const hits = new Map<string, number[]>();
function limited(k: string, max = 60): boolean { const n = Date.now(), a = (hits.get(k) ?? []).filter((t) => n - t < 300_000); a.push(n); hits.set(k, a); return a.length > max; }

function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) { const a = +v4[1], b = +v4[2]; return a === 127 || a === 10 || a === 0 || a >= 224 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(l) || (l.startsWith("::ffff:") && isPrivateIp(l.slice(7)));
}
/** A server must be a real public host: no internal addresses (this function must never become a way into the platform's own network). */
export async function safeHost(host: string): Promise<string | null> {
  const h = String(host ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) && !/^[0-9a-f:]{2,45}$/.test(h)) return null;
  if (h === "localhost" || h.endsWith(".internal") || h.endsWith(".local")) return null;
  if (/^[\d.]+$/.test(h)) return isPrivateIp(h) ? null : h;
  if (h.includes(":")) return isPrivateIp(h) ? null : h;
  const recs: string[] = [];
  try { recs.push(...(await Deno.resolveDns(h, "A"))); } catch { /* none */ }
  try { recs.push(...(await Deno.resolveDns(h, "AAAA"))); } catch { /* none */ }
  if (!recs.length || recs.some(isPrivateIp)) return null;
  return h;
}

async function loadTarget(s: { id: string; host: string; port: number; ssh_user: string; auth_type: string; host_fingerprint: string | null }): Promise<Target> {
  const k = Deno.env.get("OPS_ENC_KEY");
  if (!k) throw new Error("ops_key_missing");
  const { data } = await db.from("ops_server_secrets").select("ciphertext").eq("server_id", s.id).maybeSingle();
  if (!data) throw new Error("secret_missing");
  const secret = await decrypt(data.ciphertext, s.id, k);
  return { host: s.host, port: s.port, user: s.ssh_user, ...(s.auth_type === "key" ? { privateKey: secret } : { password: secret }), fingerprint: s.host_fingerprint };
}
async function execOn(id: string, cmd: string, timeoutMs = 60_000): Promise<ExecOut> {
  const { data: s } = await db.from("ops_servers").select("id,host,port,ssh_user,auth_type,host_fingerprint").eq("id", id).maybeSingle();
  if (!s) throw new Error("server_not_found");
  try {
    const r = await runSsh(await loadTarget(s), cmd, { timeoutMs });
    if (!s.host_fingerprint && r.fingerprint) await db.from("ops_servers").update({ host_fingerprint: r.fingerprint }).eq("id", id);   // trust on first use
    return r;
  } catch (e) {
    const m = String((e as Error).message ?? e);
    if (s.host_fingerprint && /handshake|host key|verif/i.test(m)) throw new Error("host_key_changed: the server key differs from the one saved on first connect (possible interception). If you reinstalled the server, reset its fingerprint.");
    throw e;
  }
}

const notifyOwners = async (type: string, title: string, body: string) => {
  const { data } = await db.from("profiles").select("id").eq("role", "super_admin").eq("status", "active");
  if (data?.length) await db.from("notifications").insert(data.map((p: any) => ({ user_id: p.id, type, title, body })));
};

function makeDeps(authHeader: string | null, userId: string): Deps {
  return {
    servers: async () => ((await db.from("ops_servers").select("id,name,host,os_info,status,autonomy,watch_services").order("created_at")).data ?? []) as Srv[],
    saveRun: async (r) => {
      const { data, error } = await db.from("ops_runs").insert({ ...r, actor_id: userId }).select("id,server_id,server_name,command,why,risk,status,source,exit_code,output,created_at").single();
      if (error) throw new Error("run_log_failed: " + error.message);
      return data as RunRow;
    },
    finishRun: async (id, p) => { await db.from("ops_runs").update({ ...p, finished_at: new Date().toISOString() }).eq("id", id); },
    exec: (s, cmd) => execOn(s.id, cmd),
    ai: async (messages: Msg[]) => {
      const r = await fetch(`${SUPA}/functions/v1/ai-gateway`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: authHeader ?? "", apikey: ANON }, body: JSON.stringify({ action: "chat", messages, usage_type: "general" }), signal: AbortSignal.timeout(100_000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || typeof j.text !== "string") throw new Error("ai_failed:" + (j.error ?? r.status));
      return j.text;
    },
    now: () => Date.now(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const authHeader = req.headers.get("Authorization");

  // ---------- scheduled sweep (pg_cron with the shared secret) ----------
  const cron = req.headers.get("x-cron-secret");
  if (cron && b.action === "health") {
    const { data: cs } = await db.from("platform_settings").select("value").eq("key", "cron.secret").maybeSingle();
    if (!cs?.value || cs.value !== cron) return json({ error: "unauthorized" }, 401);
    return json(await sweep());
  }

  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  const user = u?.user;
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: prof } = await db.from("profiles").select("role,status").eq("id", user.id).maybeSingle();
  if (!prof || prof.status !== "active" || prof.role !== "super_admin") return json({ error: "forbidden" }, 403);   // the keys to every server: Super Admin only
  if (limited(user.id)) return json({ error: "rate_limited" }, 429);
  const audit = (action: string, meta: Record<string, unknown>) => db.from("audit_logs").insert({ actor_id: user.id, action, entity: "ops_servers", meta });

  try {
    if (b.action === "add_server") {
      const name = String(b.name ?? "").trim(), user_ = String(b.user ?? "root").trim() || "root", auth = b.auth === "key" ? "key" : "password";
      const port = Number(b.port ?? 22) || 22;
      let secret = String(b.secret ?? "");
      if (name.length < 2 || name.length > 60) return json({ error: "bad_name" }, 400);
      if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user_)) return json({ error: "bad_user" }, 400);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ error: "bad_port" }, 400);
      if (!secret || secret.length > 8000) return json({ error: "bad_secret" }, 400);
      if (auth === "key") { secret = secret.replace(/\r\n/g, "\n").trim() + "\n"; if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret)) return json({ error: "bad_key_format" }, 400); if (/ENCRYPTED/.test(secret.split("\n", 3).join(" "))) return json({ error: "key_has_passphrase" }, 400); }
      const host = await safeHost(String(b.host ?? ""));
      if (!host) return json({ error: "bad_host" }, 400);
      const key = Deno.env.get("OPS_ENC_KEY");
      if (!key) return json({ error: "ops_key_missing" }, 500);
      const watch = (Array.isArray(b.watch_services) ? b.watch_services : []).map(String).filter((x: string) => SVC.test(x)).slice(0, 12);
      const { data: ins, error } = await db.from("ops_servers").insert({ name, host, port, ssh_user: user_, auth_type: auth, watch_services: watch, created_by: user.id }).select("id").single();
      if (error) return json({ error: /duplicate/.test(error.message) ? "name_taken" : "save_failed" }, error.message.includes("duplicate") ? 409 : 500);
      await db.from("ops_server_secrets").insert({ server_id: ins.id, ciphertext: await encrypt(secret, ins.id, key) });
      secret = "";
      await audit("ops.server_added", { id: ins.id, name, host });
      return json({ ok: true, server_id: ins.id, ...(await probe(ins.id)) });
    }

    if (b.action === "test" || b.action === "update_secret" || b.action === "remove_server" || b.action === "set_autonomy" || b.action === "reset_fingerprint" || b.action === "set_watch") {
      if (!UUID.test(String(b.server_id ?? ""))) return json({ error: "bad_request" }, 400);
      const id = String(b.server_id);
      const { data: s } = await db.from("ops_servers").select("id,name").eq("id", id).maybeSingle();
      if (!s) return json({ error: "not_found" }, 404);
      if (b.action === "test") return json({ ok: true, ...(await probe(id)) });
      if (b.action === "update_secret") {
        const secret = String(b.secret ?? ""); const key = Deno.env.get("OPS_ENC_KEY");
        if (!key) return json({ error: "ops_key_missing" }, 500);
        if (!secret || secret.length > 8000) return json({ error: "bad_secret" }, 400);
        await db.from("ops_server_secrets").upsert({ server_id: id, ciphertext: await encrypt(secret.replace(/\r\n/g, "\n"), id, key), updated_at: new Date().toISOString() });
        await audit("ops.secret_updated", { id, name: s.name });
        return json({ ok: true, ...(await probe(id)) });
      }
      if (b.action === "remove_server") {
        if (b.confirm !== s.name) return json({ error: "confirm_name_required" }, 400);   // typing the server's name prevents an accidental delete
        await db.from("ops_servers").delete().eq("id", id);
        await audit("ops.server_removed", { id, name: s.name });
        return json({ ok: true });
      }
      if (b.action === "set_autonomy") {
        const level = b.level === "full_auto" ? "full_auto" : "ask_destructive";
        if (level === "full_auto" && b.confirm !== "FULL AUTO") return json({ error: "confirm_phrase_required" }, 400);
        await db.from("ops_servers").update({ autonomy: level }).eq("id", id);
        await audit("ops.autonomy", { id, name: s.name, level });
        return json({ ok: true, level });
      }
      if (b.action === "reset_fingerprint") { await db.from("ops_servers").update({ host_fingerprint: null }).eq("id", id); await audit("ops.fingerprint_reset", { id, name: s.name }); return json({ ok: true }); }
      if (b.action === "set_watch") {
        const watch = (Array.isArray(b.services) ? b.services : []).map(String).filter((x: string) => SVC.test(x)).slice(0, 12);
        await db.from("ops_servers").update({ watch_services: watch }).eq("id", id);
        return json({ ok: true, services: watch });
      }
    }

    if (b.action === "chat") {
      const message = String(b.message ?? "").trim();
      if (!message || message.length > 4000) return json({ error: "bad_message" }, 400);
      const serverId = UUID.test(String(b.server_id ?? "")) ? String(b.server_id) : null;
      const { data: hist } = await db.from("ops_chat").select("role,content").eq("user_id", user.id).order("id", { ascending: false }).limit(12);
      const history = (hist ?? []).reverse().map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 3000) })) as Msg[];
      await db.from("ops_chat").insert({ user_id: user.id, role: "user", content: message });
      const r = await converse(makeDeps(authHeader, user.id), { message, history, serverId, deadline: Date.now() + 120_000 });
      const reply = r.reply || (r.pending.length ? "أحتاج موافقتك على الأوامر المعلّقة أدناه." : "تم.");
      await db.from("ops_chat").insert({ user_id: user.id, role: "assistant", content: reply, run_ids: [...r.runs, ...r.pending].map((x) => x.id) });
      return json({ ok: true, reply, runs: r.runs, pending: r.pending });
    }

    if (b.action === "approve" || b.action === "reject") {
      if (!UUID.test(String(b.run_id ?? ""))) return json({ error: "bad_request" }, 400);
      const { data: run } = await db.from("ops_runs").select("*").eq("id", b.run_id).maybeSingle();
      if (!run || run.status !== "pending_approval") return json({ error: "not_pending" }, 409);
      if (b.action === "reject") { await db.from("ops_runs").update({ status: "rejected", decided_by: user.id, finished_at: new Date().toISOString() }).eq("id", run.id); return json({ ok: true }); }
      const { data: claimed } = await db.from("ops_runs").update({ status: "running", decided_by: user.id }).eq("id", run.id).eq("status", "pending_approval").select("id");   // one approval = one execution
      if (!claimed?.length) return json({ error: "not_pending" }, 409);
      let out: ExecOut | null = null, err = "";
      try { out = await execOn(run.server_id, run.command, 90_000); } catch (e) { err = redact(String((e as Error).message)).slice(0, 400); }
      const output = out ? clip(redact([out.stdout, out.stderr ? "[stderr]\n" + out.stderr : ""].filter(Boolean).join("\n")), 20000) : "ssh_error: " + err;
      await db.from("ops_runs").update({ status: out && out.code === 0 ? "done" : "failed", exit_code: out?.code ?? null, output, finished_at: new Date().toISOString() }).eq("id", run.id);
      await audit("ops.approved_run", { run: run.id, server: run.server_name });
      return json({ ok: true, exit_code: out?.code ?? null, output });
    }

    if (b.action === "health") return json(await sweep());
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: "server_error", detail: redact(String((e as Error).message ?? e)).slice(0, 200) }, 500);
  }
});

/** Connect, read basic facts, store them. Never returns credentials. */
async function probe(id: string) {
  try {
    const r = await execOn(id, `uname -sr; (lsb_release -ds 2>/dev/null || head -1 /etc/os-release); uptime -p; df -h / | tail -1; free -m | sed -n 2p`, 30_000);
    await db.from("ops_servers").update({ status: "online", last_seen: new Date().toISOString(), last_error: null, os_info: redact(r.stdout).slice(0, 600), fail_streak: 0, alerted: false }).eq("id", id);
    return { status: "online", info: redact(r.stdout).slice(0, 600) };
  } catch (e) {
    const m = redact(String((e as Error).message ?? e)).slice(0, 300);
    await db.from("ops_servers").update({ status: "error", last_error: m }).eq("id", id);
    return { status: "error", error: m };
  }
}

/** Reachability + watched services for every server, with automatic restart and owner alerts only when the state changes. */
async function sweep() {
  const { data: list } = await db.from("ops_servers").select("id,name,host,os_info,status,autonomy,watch_services,fail_streak,alerted").order("created_at");
  const out: unknown[] = [];
  for (const s of (list ?? []) as any[]) {
    const deps = makeDeps(null, "00000000-0000-0000-0000-000000000000");
    deps.saveRun = async (r) => { const { data } = await db.from("ops_runs").insert({ ...r, actor_id: null }).select("id,server_id,server_name,command,why,risk,status,source,exit_code,output,created_at").single(); return data as RunRow; };
    const h = await healthCheck(deps, s);
    if (h.ok) {
      await db.from("ops_servers").update({ status: "online", last_seen: new Date().toISOString(), last_error: null, fail_streak: 0, alerted: false }).eq("id", s.id);
      if (s.alerted) await notifyOwners("server_recovered", "server_recovered", s.name);
      const healed = h.services.filter((x) => x.healed), still = h.services.filter((x) => !x.active);
      if (healed.length) await notifyOwners("server_healed", "server_healed", `${s.name}: ${healed.map((x) => x.name).join(", ")}`);
      if (still.length) await notifyOwners("service_down", "service_down", `${s.name}: ${still.map((x) => x.name).join(", ")}`);
    } else {
      const streak = (s.fail_streak ?? 0) + 1, down = streak >= 2;
      await db.from("ops_servers").update({ fail_streak: streak, status: down ? "offline" : s.status, last_error: h.error, ...(down && !s.alerted ? { alerted: true } : {}) }).eq("id", s.id);
      if (down && !s.alerted) await notifyOwners("server_down", "server_down", `${s.name} (${s.host})`);   // one alert per outage, not one per sweep
    }
    out.push({ server: s.name, ok: h.ok, services: h.services });
  }
  return { ok: true, checked: out.length, servers: out };
}
