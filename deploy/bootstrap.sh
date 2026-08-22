#!/bin/bash
# Первичная настройка чистого сервера под CorNet. Запускать на самом сервере,
# от пользователя с sudo, на свежей Ubuntu 24.04:
#
#   curl -fsSL https://raw.githubusercontent.com/hikohing/cornet-messenger/ios-app/deploy/bootstrap.sh | bash
#
# Скрипт только готовит машину и код. Секреты и сертификат — вручную дальше,
# потому что для них нужны домен и значения со старого сервера.
set -euo pipefail

REPO=https://github.com/hikohing/cornet-messenger.git
BRANCH=ios-app
DIR="$HOME/cornet-messenger"

echo "→ Docker"
if ! command -v docker >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker.io docker-compose-v2 git
  sudo usermod -aG docker "$USER"
  echo "  Docker поставлен. Группа docker применится после перелогина —"
  echo "  до тех пор команды ниже требуют sudo."
else
  echo "  уже стоит"
fi

echo "→ Код"
if [ -d "$DIR" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi

echo "→ Файрвол"
# Timeweb Cloud не ставит перед машиной группу безопасности: сервер открыт
# наружу целиком, поэтому закрываем всё лишнее сами. Порт базы наружу не нужен —
# Postgres виден только приложению внутри docker-сети.
if command -v ufw >/dev/null; then
  sudo ufw allow OpenSSH
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw --force enable
  sudo ufw status
fi

cat <<EOF

Готово. Дальше вручную:

  1. Положите рядом заполненный .env:
       cd $DIR/deploy && nano .env
     Заготовка с перенесённым TOTP_ENC_KEY лежит у вас на рабочей машине
     в deploy/.env — скопируйте её сюда:
       scp deploy/.env $USER@ЭТОТ_СЕРВЕР:$DIR/deploy/.env
     В ней осталось заполнить DOMAIN.

  2. A-запись домена → IP этого сервера. Дождитесь, пока разрешится:
       dig +short ВАШ_ДОМЕН

  3. Сертификат (nginx поднимается первым, чтобы Let's Encrypt достучался):
       docker compose up -d nginx
       docker compose run --rm certbot certonly --webroot -w /var/www/certbot \
         -d ВАШ_ДОМЕН --agree-tos --no-eff-email -m ВАША_ПОЧТА
       docker compose restart nginx

  4. Запуск:
       docker compose up -d --build

EOF
