// Site settings (editable from the admin panel) + first-run seed.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { all, get, run, tx, nowIso } from './db.js';

/** Defaults are only used when a key was never saved. Nothing here is invented business data:
 *  unknown values (addresses, map links, other branches' phones…) are left empty for the owner to fill in. */
export const DEFAULTS = {
  brand_name_ar: 'عالم البكلاوه',
  brand_name_en: 'Alem Al Bklawa',
  tagline: 'بكلاوه وحلويات وعصائر وباقات للمناسبات',
  meta_description: 'عالم البكلاوه — بكلاوه وحلويات وعصائر وباقات مناسبات. اطلب أونلاين واستلم من أقرب فرع.',
  logo_url: '',
  support_phone: '093158884',
  support_whatsapp: '21893158884',
  main_branch_slug: 'souq-al-jumaa',
  main_phone: '0925006674',
  main_whatsapp: '218925006674',
  tiktok_handle: 'alemalbklawa',
  tiktok_url: 'https://www.tiktok.com/@alemalbklawa',
  currency: 'LYD',
  currency_label: 'د.ل',
  banner_interval_ms: 2500,
  hero_title: 'عالم البكلاوه',
  hero_text: 'بكلاوه وحلويات وعصائر وباقات مناسبات، تُحضَّر بعناية وتصلك من أقرب فروعنا.',
  hero_button_text: 'تصفح المنتجات',
  hero_button_link: '/shop',
  delivery_enabled: false,
  delivery_fee: 0,
  delivery_note: '',
  cash_enabled: true,
  about_title: 'من نحن',
  about_text:
    'عالم البكلاوه محل متخصص في البكلاوه والحلويات والعصائر وباقات المناسبات.\n' +
    'نهتم بجودة ما نقدّمه وبراحة عملائنا، ونستقبل طلباتكم في فروعنا الثلاثة: سوق الجمعة، النوفليين، والسراج.',
  privacy_text:
    'نجمع الحد الأدنى من البيانات اللازمة لتنفيذ طلبك: الاسم ورقم الهاتف، وعنوان التوصيل إن اخترت التوصيل، والبريد الإلكتروني إن أدخلته.\n' +
    'نستخدم هذه البيانات لتجهيز الطلب والتواصل معك بخصوصه فقط، ولا نبيعها ولا نشاركها مع أي جهة لا علاقة لها بتنفيذ طلبك.\n' +
    'لا نخزّن بيانات البطاقات المصرفية على خوادمنا؛ تتم معالجة أي دفع إلكتروني لدى مزوّد الدفع.\n' +
    'يمكنك تعديل بياناتك أو حذف حسابك في أي وقت من صفحة «حسابي». عند حذف الحساب تُزال بياناتك الشخصية من الطلبات المكتملة، وتُحتفظ بالمبالغ والأصناف لأغراض المحاسبة فقط.',
  terms_text:
    'الأسعار المعروضة بالدينار الليبي، ويُعاد احتسابها على الخادم عند تسجيل الطلب.\n' +
    'تسجيل الطلب لا يعني تأكيده نهائيًا؛ يؤكد الفرع الطلب ويتواصل معك عند الحاجة.\n' +
    'يحق للمتجر إلغاء أو تعديل طلب عند عدم توفر صنف، مع إبلاغك بذلك.\n' +
    'استخدامك للموقع يعني موافقتك على هذه الشروط، وقد تُحدَّث من وقت لآخر.',
  rights_text:
    'من حقك معرفة سعر كل صنف وإجمالي طلبك قبل التأكيد.\n' +
    'من حقك الاطلاع على حالة طلبك ومتابعتها من حسابك أو برقم الطلب ورقم هاتفك.\n' +
    'من حقك تعديل بياناتك أو طلب حذفها في أي وقت.\n' +
    'من حقك التواصل مع دعم العملاء لأي استفسار أو شكوى.',
  home_sections: [
    { key: 'hero', enabled: true },
    { key: 'products', enabled: true },
    { key: 'bundles', enabled: true },
    { key: 'branches', enabled: true },
    { key: 'about', enabled: true },
    { key: 'contact', enabled: true },
  ],
};

/** Keys safe to expose to the browser. */
export const PUBLIC_KEYS = Object.keys(DEFAULTS);

let cache = null;
export function getSettings() {
  if (cache) return cache;
  const out = { ...DEFAULTS };
  for (const r of all('SELECT key, value FROM site_settings')) {
    if (r.key in DEFAULTS) { try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ } }
  }
  cache = out;
  return out;
}
export function saveSettings(patch) {
  tx(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) continue;
      run(
        `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        k, JSON.stringify(v), nowIso(),
      );
    }
  });
  cache = null;
}

/** Real data the owner gave us: category names, branch names, the Souq Al-Jumaa phone. No products. */
export function seedIfEmpty() {
  if (!get('SELECT 1 AS x FROM categories LIMIT 1')) {
    const cats = [
      ['bklawa', 'بكلاوه', 'products'],
      ['juice', 'عصير', 'products'],
      ['sweets', 'حلويات', 'products'],
      ['other', 'منتجات أخرى', 'products'],
      ['bundles', 'باقات المناسبات', 'bundles'],
    ];
    tx(() => cats.forEach(([slug, name, kind], i) =>
      run('INSERT INTO categories (slug, name, kind, sort_order) VALUES (?, ?, ?, ?)', slug, name, kind, (i + 1) * 10)));
  }
  if (!get('SELECT 1 AS x FROM branches LIMIT 1')) {
    tx(() => {
      run(`INSERT INTO branches (slug, name, phone, whatsapp, sort_order) VALUES (?, ?, ?, ?, ?)`,
        'souq-al-jumaa', 'سوق الجمعة', '0925006674', '218925006674', 10);
      run(`INSERT INTO branches (slug, name, sort_order) VALUES (?, ?, ?)`, 'nofleen', 'النوفليين', 20);
      run(`INSERT INTO branches (slug, name, sort_order) VALUES (?, ?, ?)`, 'al-siraj', 'السراج', 30);
    });
  }
}

/** The logo actually in use: one uploaded from the admin panel, else the file shipped in public/assets, else ''. */
export function effectiveLogo(settings) {
  if (settings.logo_url) return settings.logo_url;
  for (const f of ['logo.webp', 'logo.png', 'logo.jpg', 'logo.svg']) {
    if (fs.existsSync(path.join(config.publicDir, 'assets', f))) return '/assets/' + f;
  }
  return '';
}
