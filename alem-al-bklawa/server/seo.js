// HTML shell rendering (per-route meta, Open Graph, JSON-LD, embedded bootstrap data), sitemap & robots.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { all } from './db.js';
import { getProduct, getBundle } from './catalog.js';
import { bootstrapData } from './routes/public.js';
import { effectiveLogo } from './settings.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonSafe = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
const abs = (u) => (!u ? '' : /^https?:/.test(u) ? u : config.siteUrl + u);
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

let tpl = { mtime: 0, html: '' };
function template(file) {
  const st = fs.statSync(file);
  if (st.mtimeMs !== tpl.mtime || tpl.file !== file) tpl = { mtime: st.mtimeMs, html: fs.readFileSync(file, 'utf8'), file };
  return tpl.html;
}

export const logoUrl = effectiveLogo;

const PLACEHOLDER_LOGO = '<svg viewBox="0 0 200 200" role="img" aria-label="عالم البكلاوه"><rect width="200" height="200" fill="#800020"/><circle cx="100" cy="100" r="88" fill="none" stroke="#C6A15B" stroke-width="1.5"/><circle cx="100" cy="100" r="81" fill="none" stroke="#C6A15B" stroke-width=".6" opacity=".6"/><text x="100" y="94" text-anchor="middle" font-family="Cairo,sans-serif" font-weight="800" font-size="34" fill="#fff">عالم</text><text x="100" y="134" text-anchor="middle" font-family="Cairo,sans-serif" font-weight="800" font-size="34" fill="#C6A15B">البكلاوه</text></svg>';
function logoInner(settings) {
  const url = logoUrl(settings);
  return url ? `<img src="${esc(url)}" alt="${esc(settings.brand_name_ar)}" width="190" height="190" decoding="async" fetchpriority="high">` : PLACEHOLDER_LOGO;
}

const NOINDEX = /^\/(account|checkout|login|register|forgot|reset|order|cart|search)(\/|$)/;
const KNOWN = /^\/(shop|bundles|branches|about|privacy|terms|rights|track)?\/?$|^\/(product|bundle)\/\d+(\/[^/]*)?$|^\/(account|checkout|login|register|forgot|reset|order|cart|search)(\/|$)/;

export function routeStatus(pathname) { return KNOWN.test(pathname) ? 200 : 404; }

function metaFor(pathname, boot) {
  const s = boot.settings; const brand = s.brand_name_ar;
  const meta = { title: `${brand} | ${s.tagline}`, description: s.meta_description, image: logoUrl(s), canonical: config.siteUrl + (pathname === '/' ? '/' : pathname), type: 'website', noindex: NOINDEX.test(pathname), ld: [] };
  const titled = (t, d) => { meta.title = `${t} | ${brand}`; if (d) meta.description = d; };
  let m;
  if (pathname === '/') {
    meta.ld.push({
      '@context': 'https://schema.org', '@type': 'Store', name: brand, alternateName: s.brand_name_en, url: config.siteUrl + '/',
      ...(meta.image ? { logo: abs(meta.image), image: abs(meta.image) } : {}),
      description: s.meta_description,
      telephone: '+' + (s.main_whatsapp || s.support_whatsapp),
      sameAs: s.tiktok_url ? [s.tiktok_url] : [],
      contactPoint: s.support_whatsapp ? [{ '@type': 'ContactPoint', contactType: 'customer support', telephone: '+' + s.support_whatsapp, availableLanguage: 'ar' }] : undefined,
    });
  } else if (pathname === '/shop') titled('المتجر', 'تصفح بكلاوه وحلويات وعصائر ومنتجات عالم البكلاوه واطلب أونلاين.');
  else if (pathname === '/bundles') titled('باقات المناسبات', 'باقات مناسبات من عالم البكلاوه للأفراح والاجتماعات والهدايا.');
  else if (pathname === '/branches') titled('فروعنا', 'فروع عالم البكلاوه: سوق الجمعة، النوفليين، السراج.');
  else if (pathname === '/about') titled(s.about_title, cut(s.about_text, 160));
  else if (pathname === '/privacy') titled('سياسة الخصوصية');
  else if (pathname === '/terms') titled('شروط الاستخدام');
  else if (pathname === '/rights') titled('حقوق العملاء');
  else if ((m = /^\/product\/(\d+)/.exec(pathname))) {
    const p = getProduct(Number(m[1]));
    if (p) {
      titled(p.name, cut(p.description || `${p.name} من ${brand}`, 160)); meta.type = 'product';
      if (p.image) meta.image = p.image;
      meta.canonical = `${config.siteUrl}/product/${p.id}`;
      meta.ld.push({
        '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: cut(p.description, 300) || undefined,
        image: p.image ? [abs(p.image)] : undefined, category: p.category_name,
        offers: {
          '@type': p.variants.length ? 'AggregateOffer' : 'Offer', priceCurrency: s.currency,
          ...(p.variants.length ? { lowPrice: p.price_from / 1000, offerCount: p.variants.length } : { price: p.price / 1000 }),
          availability: p.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: meta.canonical,
        },
      });
    } else meta.noindex = true;
  } else if ((m = /^\/bundle\/(\d+)/.exec(pathname))) {
    const b = getBundle(Number(m[1]));
    if (b) {
      titled(b.name, cut(b.description || `${b.name} من ${brand}`, 160)); if (b.image) meta.image = b.image; meta.canonical = `${config.siteUrl}/bundle/${b.id}`;
      meta.ld.push({
        '@context': 'https://schema.org', '@type': 'Product', name: b.name, description: cut(b.description, 300) || undefined, image: b.image ? [abs(b.image)] : undefined,
        offers: { '@type': 'Offer', priceCurrency: s.currency, price: b.price / 1000, availability: b.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: meta.canonical },
      });
    } else meta.noindex = true;
  }
  return meta;
}

function headTags(meta) {
  const t = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(cut(meta.description, 300))}">`,
    `<link rel="canonical" href="${esc(meta.canonical)}">`,
    meta.noindex ? '<meta name="robots" content="noindex,nofollow">' : '<meta name="robots" content="index,follow,max-image-preview:large">',
    `<meta property="og:type" content="${meta.type}">`, `<meta property="og:locale" content="ar_LY">`,
    `<meta property="og:title" content="${esc(meta.title)}">`, `<meta property="og:description" content="${esc(cut(meta.description, 200))}">`,
    `<meta property="og:url" content="${esc(meta.canonical)}">`,
    meta.image ? `<meta property="og:image" content="${esc(abs(meta.image))}">` : '',
    `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`,
  ];
  for (const ld of meta.ld) t.push(`<script type="application/ld+json">${jsonSafe(ld)}</script>`);
  return t.filter(Boolean).join('\n');
}

export function renderApp(pathname) {
  const boot = bootstrapData();
  const html = template(path.join(config.publicDir, 'index.html'));
  const logo = logoUrl(boot.settings);
  boot.settings = { ...boot.settings, logo_url: logo };
  return html
    .replace('<!--SEO-->', () => headTags(metaFor(pathname, boot)))
    .replace('<!--LOGO-->', () => logoInner(boot.settings))
    .replace('<!--BOOT-->', () => `<script id="boot" type="application/json">${jsonSafe(boot)}</script>`);
}

export function sitemapXml() {
  const now = new Date().toISOString().slice(0, 10);
  const urls = ['/', '/shop', '/bundles', '/branches', '/about', '/privacy', '/terms', '/rights'].map((p) => ({ loc: p, mod: now }));
  for (const p of all("SELECT p.id, p.updated_at FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND c.active = 1")) urls.push({ loc: `/product/${p.id}`, mod: p.updated_at.slice(0, 10) });
  for (const b of all('SELECT id, updated_at FROM bundles WHERE active = 1')) urls.push({ loc: `/bundle/${b.id}`, mod: b.updated_at.slice(0, 10) });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(config.siteUrl + u.loc)}</loc><lastmod>${u.mod}</lastmod></url>`).join('\n')}\n</urlset>\n`;
}

export const robotsTxt = () =>
  `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /account\nDisallow: /checkout\nDisallow: /order/\nDisallow: /pay/\nDisallow: /sandbox/\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`;
