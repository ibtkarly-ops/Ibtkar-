<?php
/**
 * ابتكار | IBTIKAR — نسخة PHP (منفذ جزئي للوحة الحالية)
 *
 * يتصل بنفس مشروع Supabase الذي تستعمله public/index.html — نفس البيانات،
 * نفس القواعد (RLS)، نفس دوال الذكاء الاصطناعي (ai-gateway). هذا ليس
 * تطبيقاً منفصلاً بقاعدة بيانات أخرى، بل واجهة أخرى لنفس المنصة بالضبط.
 *
 * ما هو مُنفَّذ هنا (مُختبَر فعلياً بطلبات حقيقية ضد المشروع الحي وقت الكتابة):
 *   - الصفحة الرئيسية (الأسعار من جدول plans الحقيقي)
 *   - تسجيل الدخول / إنشاء حساب (عبر Supabase Auth REST مباشرة)
 *   - لوحة العميل: قائمة مواقعي، إنشاء موقع جديد (يستدعي نفس دالة
 *     ai-gateway التي تبنيه بالذكاء الاصطناعي وتنشره تلقائياً)، عرض موقع
 *     واحد ومعاينته، طلبات التعديل، الإشعارات
 *
 * ما هو غير مُنفَّذ عمداً في هذا الإصدار (ولا يُفترض أنه موجود):
 *   - أي صفحة من لوحة الإدارة (عملاء، مزودو AI، باقات، عقود، تذاكر...)
 *   - الفواتير والعقود من جهة العميل
 *   - اختيار قالب جاهز (المسار الوحيد هنا هو البناء بالذكاء الاصطناعي)
 *   - تبديل اللغة الكامل (الواجهة هنا عربية فقط لتبسيط هذا الإصدار)
 *
 * راجع php-app/README.md لقائمة كاملة وواضحة بما تم وما تبقّى.
 */

declare(strict_types=1);
session_start();

// --------------------------------------------------------------------------
// إعداد الاتصال بـSupabase — نفس القيم المستخدمة في public/index.html تماماً.
// المفتاح هنا "publishable" (عام، مخصَّص للمتصفح) — لا يوجد أي سر هنا، كل
// القيود الحقيقية مفروضة داخل قاعدة البيانات نفسها (RLS)، كما في النسخة الأصلية.
// --------------------------------------------------------------------------
const SB_URL = 'https://ppegbmqkcdwopakewetl.supabase.co';
const SB_KEY = 'sb_publishable_5Ch9XW29qSLTxPuqvVVBnA_jjHsHtu0';

/**
 * طلب REST بسيط لـSupabase (PostgREST أو Auth). يستخدم توكن المستخدم
 * المسجَّل دخوله إن وُجد (لتُطبَّق صلاحياته الحقيقية عبر RLS)، وإلا المفتاح
 * العام (كزائر غير مسجّل، تماماً كما تفعل الواجهة الأصلية).
 */
function sb(string $method, string $path, ?array $body = null, bool $asUser = true): array {
    $token = $asUser ? ($_SESSION['access_token'] ?? SB_KEY) : SB_KEY;
    $ch = curl_init(SB_URL . $path);
    $headers = [
        'apikey: ' . SB_KEY,
        'Authorization: Bearer ' . $token,
        'Content-Type: application/json',
    ];
    if (str_starts_with($path, '/rest/')) $headers[] = 'Prefer: return=representation';
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $data = json_decode((string)$res, true);
    return ['code' => $code, 'data' => $data, 'ok' => $code >= 200 && $code < 300];
}

/** Supabase access tokens expire (~1h). One silent retry via refresh_token on a 401. */
function sbAsUser(string $method, string $path, ?array $body = null): array {
    $r = sb($method, $path, $body, true);
    if ($r['code'] === 401 && !empty($_SESSION['refresh_token'])) {
        $ref = sb('POST', '/auth/v1/token?grant_type=refresh_token', ['refresh_token' => $_SESSION['refresh_token']], false);
        if ($ref['ok'] && !empty($ref['data']['access_token'])) {
            $_SESSION['access_token'] = $ref['data']['access_token'];
            $_SESSION['refresh_token'] = $ref['data']['refresh_token'];
            $r = sb($method, $path, $body, true);
        } else {
            unset($_SESSION['access_token'], $_SESSION['refresh_token'], $_SESSION['user']);
        }
    }
    return $r;
}

function esc(?string $s): string { return htmlspecialchars($s ?? '', ENT_QUOTES, 'UTF-8'); }
function me(): ?array { return $_SESSION['user'] ?? null; }
function requireLogin(): void { if (!me()) { header('Location: ?p=login'); exit; } }
function flash(string $msg, bool $err = false): void { $_SESSION['flash'] = ['msg' => $msg, 'err' => $err]; }
function takeFlash(): ?array { $f = $_SESSION['flash'] ?? null; unset($_SESSION['flash']); return $f; }

// --------------------------------------------------------------------------
// التوجيه
// --------------------------------------------------------------------------
$p = $_GET['p'] ?? 'home';

if ($p === 'logout') {
    session_destroy();
    header('Location: ?p=home');
    exit;
}

if ($p === 'login' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $r = sb('POST', '/auth/v1/token?grant_type=password', [
        'email' => trim($_POST['email'] ?? ''),
        'password' => $_POST['pass'] ?? '',
    ], false);
    if ($r['ok'] && !empty($r['data']['access_token'])) {
        $_SESSION['access_token'] = $r['data']['access_token'];
        $_SESSION['refresh_token'] = $r['data']['refresh_token'];
        $_SESSION['user'] = $r['data']['user'];
        header('Location: ?p=dashboard');
        exit;
    }
    flash($r['data']['error_description'] ?? $r['data']['msg'] ?? 'فشل تسجيل الدخول', true);
    header('Location: ?p=login');
    exit;
}

if ($p === 'signup' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $r = sb('POST', '/auth/v1/signup', [
        'email' => trim($_POST['email'] ?? ''),
        'password' => $_POST['pass'] ?? '',
        'data' => ['full_name' => trim($_POST['name'] ?? '')],
    ], false);
    if ($r['ok']) {
        if (!empty($r['data']['access_token'])) {
            $_SESSION['access_token'] = $r['data']['access_token'];
            $_SESSION['refresh_token'] = $r['data']['refresh_token'];
            $_SESSION['user'] = $r['data']['user'];
            header('Location: ?p=dashboard');
        } else {
            flash('تم إنشاء الحساب. تحقق من بريدك لتفعيله.');
            header('Location: ?p=login');
        }
        exit;
    }
    flash($r['data']['error_description'] ?? $r['data']['msg'] ?? 'فشل إنشاء الحساب', true);
    header('Location: ?p=signup');
    exit;
}

if ($p === 'new' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireLogin();
    $name = trim($_POST['name'] ?? '');
    $type = $_POST['type'] ?? 'landing';
    $brief = [
        'name' => $name, 'desc' => trim($_POST['desc'] ?? ''),
        'phone' => trim($_POST['phone'] ?? ''), 'wa' => trim($_POST['wa'] ?? ''),
        'email' => trim($_POST['email'] ?? ''), 'addr' => trim($_POST['addr'] ?? ''),
        'items' => trim($_POST['items'] ?? ''), 'lang' => 'ar',
    ];
    if ($name === '') { flash('اسم النشاط مطلوب', true); header('Location: ?p=new'); exit; }

    $ins = sbAsUser('POST', '/rest/v1/websites', [
        'owner_id' => me()['id'], 'name' => $name, 'site_type' => $type, 'config' => ['brief' => $brief],
    ]);
    if (!$ins['ok'] || empty($ins['data'][0]['id'])) {
        flash($ins['data']['message'] ?? 'تعذّر إنشاء الموقع', true);
        header('Location: ?p=new');
        exit;
    }
    $siteId = $ins['data'][0]['id'];

    // نفس الدالة الحقيقية التي تبني الموقع بالذكاء الاصطناعي وتنشره تلقائياً —
    // بالضبط ما يستدعيه public/index.html عند إنشاء موقع جديد.
    $build = sbAsUser('POST', '/functions/v1/ai-gateway', ['action' => 'build', 'website_id' => $siteId]);
    if (!$build['ok'] || empty($build['data']['ok'])) {
        flash('أُنشئ الموقع، لكن تعذّر بناؤه بالذكاء الاصطناعي الآن (' . esc($build['data']['error'] ?? 'unknown') . '). جرّب "إعادة البناء" من صفحة الموقع.', true);
    } else {
        flash('تم إنشاء موقعك وبناؤه' . (!empty($build['data']['deployed']) ? ' ونشره' : '') . '.');
    }
    header('Location: ?p=site&id=' . urlencode($siteId));
    exit;
}

// --------------------------------------------------------------------------
// العرض
// --------------------------------------------------------------------------
function layout(string $title, string $body): void {
    $user = me();
    ?><!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title><?= esc($title) ?> — ابتكار</title>
<style>
:root{--ac:#2433ff;--ac2:#00c2a8;--bg2:#F7F8FA;--bd:#EAECEF;--tx2:#6b7280}
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;background:#fff;color:#171717;line-height:1.6}
.wrap{max-width:1000px;margin:auto;padding:0 20px}
nav{display:flex;align-items:center;gap:16px;padding:16px 20px;border-bottom:1px solid var(--bd)}
nav .sp{flex:1}
a{color:var(--ac);text-decoration:none}
.btn{display:inline-block;background:var(--ac);color:#fff;padding:9px 18px;border-radius:10px;border:0;cursor:pointer;font-size:15px}
.btn.s{background:#fff;color:#171717;border:1px solid var(--bd)}
.card{border:1px solid var(--bd);border-radius:16px;padding:20px;margin-bottom:14px}
input,select,textarea{width:100%;padding:10px;border:1px solid var(--bd);border-radius:10px;margin-bottom:10px;font:inherit}
label{font-size:13px;color:var(--tx2);display:block;margin-bottom:4px}
.flash{padding:12px 16px;border-radius:10px;margin-bottom:16px}
.flash.ok{background:#ecfdf3;color:#16a34a}.flash.err{background:#fef2f2;color:#dc2626}
.price{font-size:30px;font-weight:700}
table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid var(--bd);text-align:right}
</style>
</head>
<body>
<nav><div class="wrap" style="display:flex;align-items:center;gap:16px;width:100%">
  <a href="?p=home" style="font-weight:700;font-size:18px">ابتكار</a>
  <span class="sp"></span>
  <?php if ($user): ?>
    <a href="?p=dashboard">لوحتي</a>
    <a href="?p=logout" class="btn s">خروج</a>
  <?php else: ?>
    <a href="?p=login">دخول</a>
    <a href="?p=signup" class="btn">إنشاء حساب</a>
  <?php endif; ?>
</div></nav>
<div class="wrap" style="padding:30px 20px">
<?php $f = takeFlash(); if ($f): ?>
  <div class="flash <?= $f['err'] ? 'err' : 'ok' ?>"><?= esc($f['msg']) ?></div>
<?php endif; ?>
<?= $body ?>
</div>
</body></html><?php
}

ob_start();

if ($p === 'home') {
    $plans = sb('GET', '/rest/v1/plans?select=*&active=eq.true&order=sort', null, false);
    echo '<h1>ابتكر موقعك بمحادثة</h1><p style="color:var(--tx2);max-width:60ch">صف ما تريد بكلماتك، ونجهّز لك موقعاً كاملاً تعدّله وتنشره وتتابعه من مكان واحد.</p>';
    echo '<p><a href="?p=signup" class="btn">ابدأ مجاناً</a></p><br><h2>الباقات</h2>';
    if (!$plans['ok']) {
        echo '<div class="flash err">تعذّر تحميل الباقات الآن (' . esc((string)$plans['code']) . ')</div>';
    } else {
        echo '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">';
        foreach ($plans['data'] as $pl) {
            echo '<div class="card"><h3>' . esc($pl['name_ar']) . '</h3><div class="price">$' . esc((string)$pl['price']) . '</div>'
               . '<p style="color:var(--tx2)">' . (int)$pl['websites_limit'] . ' مواقع · ' . (int)$pl['ai_requests_limit'] . ' طلب/شهر</p></div>';
        }
        echo '</div>';
    }
} elseif ($p === 'login') {
    echo '<h1>تسجيل الدخول</h1><form method="post" style="max-width:380px">
      <label>البريد الإلكتروني</label><input type="email" name="email" required>
      <label>كلمة المرور</label><input type="password" name="pass" required>
      <button class="btn" style="width:100%">دخول</button></form>
      <p style="margin-top:10px;color:var(--tx2)">ليس لديك حساب؟ <a href="?p=signup">إنشاء حساب</a></p>';
} elseif ($p === 'signup') {
    echo '<h1>إنشاء حساب</h1><form method="post" style="max-width:380px">
      <label>الاسم</label><input name="name" required>
      <label>البريد الإلكتروني</label><input type="email" name="email" required>
      <label>كلمة المرور</label><input type="password" name="pass" required minlength="8">
      <button class="btn" style="width:100%">إنشاء حساب</button></form>
      <p style="margin-top:10px;color:var(--tx2)">لديك حساب؟ <a href="?p=login">تسجيل الدخول</a></p>';
} elseif ($p === 'dashboard') {
    requireLogin();
    $sites = sbAsUser('GET', '/rest/v1/websites?select=*&order=created_at.desc');
    echo '<div style="display:flex;align-items:center;gap:12px"><h1 style="margin:0">مواقعي</h1><span style="flex:1"></span><a href="?p=new" class="btn">+ موقع جديد</a></div><br>';
    if (!$sites['ok']) {
        echo '<div class="flash err">تعذّر تحميل مواقعك</div>';
    } elseif (empty($sites['data'])) {
        echo '<div class="card">ما عندك مواقع بعد. <a href="?p=new">أنشئ أول موقع الآن</a>.</div>';
    } else {
        foreach ($sites['data'] as $w) {
            echo '<div class="card"><div style="display:flex;align-items:center;gap:10px"><b>' . esc($w['name']) . '</b>'
               . '<span style="color:var(--tx2);font-size:13px">' . esc($w['status']) . '</span><span style="flex:1"></span>'
               . '<a href="?p=site&id=' . urlencode($w['id']) . '">فتح</a></div></div>';
        }
    }
} elseif ($p === 'new') {
    requireLogin();
    echo '<h1>موقع جديد</h1><form method="post" style="max-width:520px">
      <label>اسم النشاط</label><input name="name" required maxlength="80">
      <label>نوع الموقع</label><select name="type">
        <option value="landing">صفحة تعريفية</option>
        <option value="restaurant">مطعم</option>
        <option value="store">متجر إلكتروني</option>
        <option value="company">شركة</option>
        <option value="clinic">عيادة</option>
        <option value="portfolio">معرض أعمال</option>
      </select>
      <label>وصف النشاط</label><textarea name="desc" rows="3"></textarea>
      <label>رقم الهاتف</label><input name="phone">
      <label>رقم واتساب</label><input name="wa">
      <label>البريد الإلكتروني</label><input name="email">
      <label>العنوان / المدينة</label><input name="addr">
      <label>الخدمات أو المنتجات (سطر لكل عنصر: الاسم | السعر | وصف قصير)</label><textarea name="items" rows="4"></textarea>
      <button class="btn" style="width:100%">إنشاء الموقع</button></form>';
} elseif ($p === 'site') {
    requireLogin();
    $id = $_GET['id'] ?? '';
    $r = sbAsUser('GET', '/rest/v1/websites?select=*&id=eq.' . urlencode($id));
    $w = $r['data'][0] ?? null;
    if (!$w) {
        echo '<div class="flash err">الموقع غير موجود أو لا تملك صلاحية الوصول له.</div>';
    } else {
        $html = $w['config']['html'] ?? null;
        echo '<h1>' . esc($w['name']) . '</h1><p style="color:var(--tx2)">' . esc($w['status'])
           . ($w['url'] ? ' · <a href="' . esc($w['url']) . '" target="_blank" rel="noopener">فتح الموقع</a>' : '') . '</p>';
        if ($html) {
            echo '<h3>معاينة</h3><iframe sandbox style="width:100%;height:420px;border:1px solid var(--bd);border-radius:12px" srcdoc="' . esc($html) . '"></iframe>';
        } elseif (!empty($w['stack'])) {
            echo '<div class="card">هذا موقع ' . ($w['stack'] === 'php' ? 'PHP' : 'Node.js') . ' — لا معاينة مباشرة هنا، افتح الرابط أعلاه بعد النشر.</div>';
        } else {
            echo '<div class="card">لم يُبنَ الموقع بعد.</div>';
        }

        $reqs = sbAsUser('GET', '/rest/v1/modification_requests?select=*&website_id=eq.' . urlencode($id) . '&order=created_at.desc');
        echo '<h3 style="margin-top:24px">طلب تعديل</h3>
          <form method="post" action="?p=request&id=' . urlencode($id) . '">
            <textarea name="d" rows="2" placeholder="مثال: غيّر رقم الهاتف، أضف قسماً للعروض..." required></textarea>
            <button class="btn">إرسال الطلب</button>
          </form>';
        if ($reqs['ok'] && !empty($reqs['data'])) {
            echo '<table><tr><th>الطلب</th><th>الحالة</th></tr>';
            foreach ($reqs['data'] as $rq) {
                echo '<tr><td>' . esc(mb_substr($rq['description'], 0, 80)) . '</td><td>' . esc($rq['status']) . '</td></tr>';
            }
            echo '</table>';
        }
    }
} elseif ($p === 'request' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireLogin();
    $id = $_GET['id'] ?? '';
    $r = sbAsUser('POST', '/rest/v1/modification_requests', [
        'website_id' => $id, 'user_id' => me()['id'], 'description' => trim($_POST['d'] ?? ''),
    ]);
    flash($r['ok'] ? 'تم إرسال طلبك.' : ('تعذّر الإرسال: ' . esc($r['data']['message'] ?? '')), !$r['ok']);
    header('Location: ?p=site&id=' . urlencode($id));
    exit;
} elseif ($p === 'notifications') {
    requireLogin();
    $r = sbAsUser('GET', '/rest/v1/notifications?select=*&order=created_at.desc&limit=30');
    echo '<h1>الإشعارات</h1>';
    foreach (($r['data'] ?? []) as $n) {
        echo '<div class="card"><b>' . esc($n['title']) . '</b>' . ($n['body'] ? ' — ' . esc($n['body']) : '') . '<br><small style="color:var(--tx2)">' . esc($n['created_at']) . '</small></div>';
    }
} else {
    http_response_code(404);
    echo '<h1>404</h1>';
}

$body = ob_get_clean();
layout($p, $body);
