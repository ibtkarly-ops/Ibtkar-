# نسخة ابتكار PHP — نشر ثابت واحد على خادمك (ليس عبر خط أنابيب المواقع
# التلقائي الخاص بالعملاء في infra/deploy-agent، هذا تطبيقك الخاص).
FROM php:8.3-apache

RUN a2enmod rewrite \
 && { \
      echo 'display_errors = Off'; \
      echo 'log_errors = On'; \
      echo 'session.cookie_httponly = 1'; \
      echo 'session.cookie_samesite = Lax'; \
    } > /usr/local/etc/php/conf.d/zz-ibtikar-hardening.ini

WORKDIR /var/www/html
COPY . /var/www/html/

EXPOSE 80
