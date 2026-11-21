#!/usr/bin/env bash
# ============================================================================
# ابتكار | IBTIKAR — إعداد خادم PHP/Node.js (أمر واحد، يُشغَّل مرة واحدة)
#
#   sudo bash infra/vps-setup.sh
#
# Installs and starts, idempotently (safe to re-run):
#   - Docker
#   - Caddy (static binary — automatic HTTPS reverse proxy, admin API on
#     127.0.0.1:2019 only)
#   - Node.js 22 (to run the deploy-agent itself)
#   - the deploy-agent service from infra/deploy-agent/ (installed to
#     /opt/ibtikar-deploy-agent)
#   - ufw (firewall: only SSH, 80, 443 open) + fail2ban (SSH brute-force
#     protection)
#
# At the end it prints the one secret value (DEPLOY_AGENT_SECRET) you must
# copy into Supabase once: `supabase secrets set DEPLOY_AGENT_SECRET=...`.
# Everything after that is fully automatic — no more manual steps per site.
#
# Tested OS: Ubuntu 22.04/24.04, Debian 12. Must run as root (sudo).
# ============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash infra/vps-setup.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DOMAIN="${APPS_DOMAIN:-apps.ibtkar.ly}"
AGENT_DIR=/opt/ibtikar-deploy-agent
CONF_DIR=/etc/ibtikar
SITES_ROOT=/srv/sites

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

# ---------------------------------------------------------------------------
log "1/8 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "already installed: $(docker --version)"
fi
systemctl enable --now docker

# ---------------------------------------------------------------------------
log "2/8 Caddy (static binary, official download — no apt repo needed)"
mkdir -p "$CONF_DIR"
if ! command -v caddy >/dev/null 2>&1; then
  ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$ARCH" in
    amd64|x86_64) CADDY_ARCH=amd64 ;;
    arm64|aarch64) CADDY_ARCH=arm64 ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${CADDY_ARCH}" -o /usr/bin/caddy
  chmod +x /usr/bin/caddy
  setcap cap_net_bind_service=+ep /usr/bin/caddy || true
else
  echo "already installed: $(caddy version)"
fi
if [ ! -f "$CONF_DIR/caddy-bootstrap.json" ]; then
  cp "$SCRIPT_DIR/caddy-bootstrap.json" "$CONF_DIR/caddy-bootstrap.json"
fi

# ---------------------------------------------------------------------------
log "3/8 Node.js 22 (official tarball, no NodeSource script)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null)" != v22* ]]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64) NODE_ARCH=arm64 ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
  NODE_VER=v22.12.0
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz
  mkdir -p /opt/nodejs
  tar -xJf /tmp/node.tar.xz -C /opt/nodejs --strip-components=1
  rm -f /tmp/node.tar.xz
  ln -sf /opt/nodejs/bin/node /usr/local/bin/node
  ln -sf /opt/nodejs/bin/npm /usr/local/bin/npm
else
  echo "already installed: $(node -v)"
fi

# ---------------------------------------------------------------------------
log "4/8 Firewall (ufw) + fail2ban"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw fail2ban >/dev/null
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban

# ---------------------------------------------------------------------------
log "5/8 deploy-agent files -> $AGENT_DIR"
mkdir -p "$AGENT_DIR" "$SITES_ROOT"
rsync -a --delete --exclude node_modules "$SCRIPT_DIR/deploy-agent/" "$AGENT_DIR/"
(cd "$AGENT_DIR" && /usr/local/bin/npm install --omit=dev --no-audit --no-fund --silent)

# ---------------------------------------------------------------------------
log "6/8 secret + environment file (kept across re-runs, not overwritten)"
if [ ! -f "$CONF_DIR/deploy-agent.env" ]; then
  SECRET="$(openssl rand -hex 32)"
  cat > "$CONF_DIR/deploy-agent.env" <<EOF
DEPLOY_AGENT_SECRET=${SECRET}
AGENT_PORT=8099
CADDY_ADMIN_URL=http://127.0.0.1:2019
APPS_DOMAIN=${APPS_DOMAIN}
SITES_ROOT=${SITES_ROOT}
EOF
  chmod 600 "$CONF_DIR/deploy-agent.env"
  NEW_SECRET=1
else
  NEW_SECRET=0
fi

# ---------------------------------------------------------------------------
log "7/8 systemd services"
cp "$SCRIPT_DIR/systemd/ibtikar-caddy.service" /etc/systemd/system/ibtikar-caddy.service
cp "$SCRIPT_DIR/systemd/ibtikar-deploy-agent.service" /etc/systemd/system/ibtikar-deploy-agent.service
systemctl daemon-reload
systemctl enable --now ibtikar-caddy
systemctl enable --now ibtikar-deploy-agent
systemctl restart ibtikar-deploy-agent

# ---------------------------------------------------------------------------
log "8/8 Warming the Docker image cache (first real deploy will be fast)"
docker pull php:8.3-apache >/dev/null &
docker pull node:22-alpine >/dev/null &
wait

echo
echo "================================================================"
echo " تم. تحقق من الحالة بـ:"
echo "   systemctl status ibtikar-caddy ibtikar-deploy-agent"
echo "   curl -s http://127.0.0.1:8099/health"
echo
echo " الخطوتان المتبقيتان، مرة واحدة فقط:"
echo
echo " 1) أضف سجل DNS: *.${APPS_DOMAIN} -> عنوان IP لهذا الخادم"
echo
if [ "$NEW_SECRET" = "1" ]; then
  echo " 2) انسخ هذا المفتاح وضَعه في Supabase (من جهازك، ليس من هنا):"
  echo "      supabase secrets set DEPLOY_AGENT_SECRET=$(grep DEPLOY_AGENT_SECRET "$CONF_DIR/deploy-agent.env" | cut -d= -f2) --project-ref ppegbmqkcdwopakewetl"
  echo "    وأضف أيضاً: supabase secrets set DEPLOY_AGENT_URL=https://<IP-أو-نطاق-هذا-الخادم> --project-ref ppegbmqkcdwopakewetl"
else
  echo " 2) المفتاح موجود مسبقاً في $CONF_DIR/deploy-agent.env (لم يتغيّر في هذا التشغيل)."
fi
echo
echo " بعد هاتين الخطوتين لا يوجد أي شيء يدوي آخر — كل موقع عميل جديد"
echo " يُبنى ويُنشر تلقائياً."
echo "================================================================"
