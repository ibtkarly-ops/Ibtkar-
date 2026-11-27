// Write-only secret storage: AES-256-GCM with a key that only the edge function holds (secret OPS_ENC_KEY, base64 of 32 bytes).
// The database only ever sees ciphertext bound to its server id (AAD), and no API returns the plaintext.
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (u: Uint8Array) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };

async function key(raw: string): Promise<CryptoKey> {
  const k = b64d(raw);
  if (k.length !== 32) throw new Error("ops_key_invalid");
  return await crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(plain: string, aad: string, rawKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await key(rawKey), new TextEncoder().encode(plain)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64e(out);
}
export async function decrypt(blob: string, aad: string, rawKey: string): Promise<string> {
  const all = b64d(blob);
  if (all.length < 29) throw new Error("ops_cipher_invalid");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), additionalData: new TextEncoder().encode(aad) }, await key(rawKey), all.slice(12));
  return new TextDecoder().decode(pt);
}
