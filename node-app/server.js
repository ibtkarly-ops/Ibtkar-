"use strict";
/**
 * ابتكار | IBTIKAR — هيكل Node.js أولي (ليس منفذاً كاملاً).
 *
 * هذا نقطة بداية فقط للغة الثانية التي تحتاجها "إذا كبر المشروع"، تحتوي
 * الصفحة الرئيسية (نفس بيانات الباقات الحقيقية) وتسجيل الدخول فقط، كأمثلة
 * تُبيّن كيف تتصل بنفس Supabase. أكمل الباقي (لوحة العميل، إنشاء موقع،
 * الطلبات...) بنفس الطريقة بالضبط، باتباع php-app/index.php سطراً بسطر —
 * كل الدوال هناك (sb/sbAsUser، المسارات، التعامل مع الأخطاء) لها مرادف
 * شبه حرفي هنا، فقط بصياغة Node.js بدل PHP.
 *
 * بلا أي حزمة خارجية عمداً (فقط http/https المدمجتان في Node) — إن احتجت
 * محرّك قوالب أو إطار عمل (Express...) لاحقاً، أضفه حين يتوسّع هذا الملف.
 */
const http = require("http");
const https = require("https");

const SB_URL = "https://ppegbmqkcdwopakewetl.supabase.co";
const SB_KEY = "sb_publishable_5Ch9XW29qSLTxPuqvVVBnA_jjHsHtu0";

function sb(method, path, body, token) {
  return new Promise((resolve) => {
    const url = new URL(SB_URL + path);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${token || SB_KEY}`,
          "content-type": "application/json",
          ...(data ? { "content-length": data.length } : {}),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(chunks); } catch { /* non-JSON body */ }
          resolve({ code: res.statusCode, data: parsed, ok: res.statusCode >= 200 && res.statusCode < 300 });
        });
      }
    );
    req.on("error", () => resolve({ code: 0, data: null, ok: false }));
    if (data) req.write(data);
    req.end();
  });
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout(title, body) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ابتكار</title>
  <style>body{font-family:system-ui,sans-serif;max-width:800px;margin:30px auto;padding:0 20px;line-height:1.6}
  .card{border:1px solid #eaecef;border-radius:14px;padding:18px;margin-bottom:12px}.price{font-size:26px;font-weight:700}
  .btn{display:inline-block;background:#2433ff;color:#fff;padding:9px 18px;border-radius:10px;text-decoration:none}</style>
  </head><body>${body}</body></html>`;
}

async function handleHome() {
  const plans = await sb("GET", "/rest/v1/plans?select=*&active=eq.true&order=sort");
  let html = "<h1>ابتكر موقعك بمحادثة (Node.js)</h1><p>صف ما تريد بكلماتك، ونجهّز لك موقعاً كاملاً.</p><h2>الباقات</h2>";
  if (!plans.ok) {
    html += `<div class="card">تعذّر تحميل الباقات (HTTP ${plans.code})</div>`;
  } else {
    for (const p of plans.data || []) {
      html += `<div class="card"><b>${esc(p.name_ar)}</b><div class="price">$${esc(String(p.price))}</div></div>`;
    }
  }
  return layout("الرئيسية", html);
}

function handleLoginForm() {
  return layout("دخول", `<h1>تسجيل الدخول</h1>
    <form method="post" action="/login">
      <p><input name="email" type="email" placeholder="البريد الإلكتروني" required style="width:100%;padding:8px"></p>
      <p><input name="pass" type="password" placeholder="كلمة المرور" required style="width:100%;padding:8px"></p>
      <button class="btn">دخول</button>
    </form>`);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await handleHome());
    } else if (url.pathname === "/login" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(handleLoginForm());
    } else if (url.pathname === "/login" && req.method === "POST") {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const r = await sb("POST", "/auth/v1/token?grant_type=password", {
        email: params.get("email"), password: params.get("pass"),
      });
      if (r.ok && r.data?.access_token) {
        // TODO (mirror php-app): store access_token/refresh_token in a
        // session (e.g. a signed cookie + a server-side session store)
        // and build the dashboard route the same way php-app/index.php
        // does with sbAsUser().
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(layout("دخول", "<h1>تم تسجيل الدخول</h1><p>أكمل لوحة العميل هنا بنفس منطق php-app/index.php.</p>"));
      } else {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        res.end(layout("دخول", "<h1>فشل تسجيل الدخول</h1>"));
      }
    } else {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(layout("404", "<h1>404</h1>"));
    }
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("server_error");
  }
});

server.listen(process.env.PORT || 3000, () => console.log("listening"));
