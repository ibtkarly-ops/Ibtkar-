# Fixed, platform-controlled Dockerfile for every PHP site. The AI never
# writes this file and never sees it — it only ever produces files under
# public/ and src/, which get COPYed in below. This keeps the base image,
# the hardening settings and the docroot wiring identical and auditable
# across every customer site.
FROM php:8.3-apache

RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-dev \
 && docker-php-ext-install pdo pdo_sqlite \
 && a2enmod rewrite \
 && sed -ri -e 's!/var/www/html!/var/www/html/public!g' \
      /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf \
 && mkdir -p /data && chown -R www-data:www-data /data \
 && rm -rf /var/lib/apt/lists/*

RUN { \
      echo 'disable_functions = exec,shell_exec,system,passthru,popen,proc_open,proc_close,proc_get_status,pcntl_exec,putenv,dl'; \
      echo 'allow_url_fopen = Off'; \
      echo 'allow_url_include = Off'; \
      echo 'expose_php = Off'; \
      echo 'display_errors = Off'; \
      echo 'log_errors = On'; \
      echo 'open_basedir = /var/www/html:/data:/tmp'; \
      echo 'upload_max_filesize = 4M'; \
      echo 'post_max_size = 4M'; \
      echo 'memory_limit = 128M'; \
    } > /usr/local/etc/php/conf.d/zz-ibtikar-hardening.ini

WORKDIR /var/www/html
COPY --chown=www-data:www-data . /var/www/html

EXPOSE 80
