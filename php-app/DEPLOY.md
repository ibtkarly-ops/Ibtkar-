# نشر نسخة ابتكار PHP على خادمك

هذا تطبيقك الخاص (نسخة ثابتة واحدة)، مختلف عن خط أنابيب "موقع لكل عميل" في
`infra/deploy-agent`. بعد تشغيل `infra/vps-setup.sh` (Docker وCaddy موجودان
أصلاً)، نفّذ على الخادم:

```bash
cd php-app
docker build -t ibtikar-php-app .
docker run -d --name ibtikar-php-app --restart unless-stopped \
  -p 127.0.0.1:8090:80 \
  ibtikar-php-app
```

ثم أضف مساراً ثابتاً في Caddy (مرة واحدة، عدّل `/etc/ibtikar/caddy-bootstrap.json`
وأضف ضمن `routes`، أو عبر الـAdmin API لحظياً):

```bash
curl -X POST http://127.0.0.1:2019/config/apps/http/servers/ibtikar/routes -H "Content-Type: application/json" -d '{
  "@id": "ibtikar-php-app",
  "match": [{"host": ["php.ibtkar.ly"]}],
  "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:8090"}]}]
}'
```

(غيّر `php.ibtkar.ly` لأي نطاق فرعي تريده، وأضف سجل DNS له يشير لعنوان IP
الخادم.)

تم بناؤها وتشغيلها فعلياً واختبارها بـDocker حقيقي أثناء الكتابة (الصفحة
الرئيسية ترجع 200، صفحة غير موجودة ترجع 404 بشكل صحيح).
