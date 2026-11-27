// One SSH command, with a hard time limit, an output cap, and host-key pinning (trust on first use; a changed key is refused).
import { Client } from "npm:ssh2@1.16.0";

export type Target = { host: string; port: number; user: string; password?: string; privateKey?: string; fingerprint?: string | null };
export type SshResult = { code: number | null; stdout: string; stderr: string; truncated: boolean; fingerprint: string };

export function runSsh(t: Target, command: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<SshResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000, maxBytes = opts.maxBytes ?? 200_000;
  return new Promise((resolve, reject) => {
    const c: any = new (Client as any)();
    let so = "", se = "", trunc = false, seen = "", done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); try { c.end(); } catch { /* ignore */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error("ssh_timeout"))), timeoutMs + 15_000);
    const add = (cur: string, d: Uint8Array) => { if (cur.length >= maxBytes) { trunc = true; return cur; } return cur + new TextDecoder().decode(d).slice(0, maxBytes - cur.length); };
    c.on("ready", () => {
      c.exec(command, (err: Error | undefined, st: any) => {
        if (err) return finish(() => reject(err));
        const kill = setTimeout(() => { trunc = true; se += "\n[stopped: time limit]"; try { st.close(); } catch { /* ignore */ } finish(() => resolve({ code: null, stdout: so, stderr: se, truncated: true, fingerprint: seen })); }, timeoutMs);
        st.on("data", (d: Uint8Array) => { so = add(so, d); });
        st.stderr.on("data", (d: Uint8Array) => { se = add(se, d); });
        st.on("close", (code: number | null) => { clearTimeout(kill); finish(() => resolve({ code, stdout: so, stderr: se, truncated: trunc, fingerprint: seen })); });
      });
    });
    c.on("error", (e: Error) => finish(() => reject(e)));
    try {
      c.connect({
        host: t.host, port: t.port, username: t.user, password: t.password, privateKey: t.privateKey,
        readyTimeout: 15_000, keepaliveInterval: 10_000, tryKeyboard: false,
        hostHash: "sha256",
        hostVerifier: ((hash: string) => { seen = hash; return !t.fingerprint || t.fingerprint === hash; }) as never,
      });
    } catch (e) { finish(() => reject(e)); }
  });
}
