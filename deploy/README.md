# Перенос на свой сервер

Инструкция для переезда с Railway на обычную виртуальную машину — например в
Yandex Cloud. Причина переезда: адреса Railway недоступны из России без VPN.

Всё, что ниже, выполняется один раз. Дальше обновление — одна команда.

## 1. Машина

### Timeweb Cloud

Выбран как основная площадка: см. `RU-HOSTING.md`. **Облачные серверы → Создать**.

- Образ: **Ubuntu 24.04**
- Конфигурация: **2 CPU / 2 ГБ / 40 ГБ NVMe**. На 1 ГБ Node, Postgres и nginx
  живут впритык и падают на первой же пересборке образа.
- Локация: Москва или Петербург — ближе к пользователям и дешевле.
- **Публичный IPv4** — отдельная платная опция, но без него сервер недоступен.
- SSH-ключ добавьте на этапе создания: пароль root иначе уходит на почту открытым.

Группы безопасности Timeweb по умолчанию не навешивает, машина открыта наружу
целиком. Порты закрывает `bootstrap.sh` через ufw: наружу остаются только SSH,
80 и 443.

Тарификация почасовая, так что грант расходуется ровно по времени работы;
удалённый сервер денег не тратит.

### Быстрый старт

На свежей машине:

```bash
curl -fsSL https://raw.githubusercontent.com/hikohing/cornet-messenger/ios-app/deploy/bootstrap.sh | bash
```

Скрипт ставит Docker, забирает код, настраивает файрвол и печатает оставшиеся
шаги. Дальше — с пункта 3 этой инструкции.

### Любой другой провайдер


В Yandex Cloud: **Compute Cloud → создать ВМ**.

- Образ: Ubuntu 24.04
- Конфигурация: 2 ядра, 2 ГБ памяти, диск 20 ГБ — с запасом на такую нагрузку
- Публичный IP: **статический** (не эфемерный, иначе адрес сменится при перезапуске)
- SSH-ключ: добавьте свой

Понадобится домен, направленный на этот IP: сертификат Let's Encrypt на голый
адрес не выписывают. Подойдёт любой, в том числе бесплатный.

В группе безопасности откройте порты **80** и **443**. Порт базы наружу
открывать не нужно — она видна только приложению.

## 2. Подготовка сервера

```bash
ssh ubuntu@ВАШ_IP
```

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git && sudo usermod -aG docker $USER && newgrp docker
```

```bash
git clone -b ios-app https://github.com/hikohing/cornet-messenger.git && cd cornet-messenger/deploy
```

```bash
cp .env.example .env && nano .env
```

Заполните по подсказкам в файле. **Значения `TOTP_ENC_KEY` и `VAPID_*`
перенесите со старого сервера** — с новыми ключами перестанет работать
двухфакторная аутентификация и отвалятся подписки на уведомления.

Посмотреть старые значения:

```bash
railway variables
```

## 2.5. Домен

Сертификат Let's Encrypt на голый IP не выписывают, поэтому домен обязателен.

### Бесплатный вариант — DuckDNS

Годится для личного мессенджера и принимается Let's Encrypt без оговорок.

1. `duckdns.org` → войти через Google/GitHub → завести поддомен, например
   `cornet.duckdns.org`.
2. В поле **current ip** вписать IP сервера, нажать update.
3. Проверить, что запись разошлась:

```bash
dig +short cornet.duckdns.org
```

Пока `dig` не вернёт нужный IP, запрашивать сертификат бессмысленно: Let's Encrypt
ходит на домен по HTTP и упрётся в старый адрес. Обычно это минуты.

DuckDNS есть в Public Suffix List, так что лимиты Let's Encrypt считаются по вашему
поддомену, а не на весь `duckdns.org` — соседи вам их не исчерпают.

Минус один: адрес выглядит несолидно, и сменить его потом = пересобрать мобильные
приложения, потому что `VITE_API_URL` зашивается в бандл. Если планируете свой
домен — лучше купить сразу, около 200 ₽/год за `.ru`.

Полученный адрес впишите в `.env`:

```
DOMAIN=cornet.duckdns.org
```

## 3. Сертификат

Сначала поднимаем только nginx, чтобы Let's Encrypt мог достучаться:

```bash
docker compose up -d nginx
```

```bash
docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d ВАШ_ДОМЕН --agree-tos --no-eff-email -m ВАША_ПОЧТА
```

```bash
docker compose restart nginx
```

## 4. Перенос данных

**База.** На машине, где настроен Railway:

```bash
railway run pg_dump --no-owner --no-acl > cornet.sql
```

```bash
scp cornet.sql ubuntu@ВАШ_IP:~/
```

На сервере, уже после первого запуска приложения (оно само создаст таблицы):

```bash
docker compose exec -T db psql -U cornet -d cornet < ~/cornet.sql
```

**Загруженные файлы.** Они лежат на томе Railway в `/data/uploads`:

```bash
railway ssh "tar czf - -C /data uploads" > uploads.tar.gz
```

```bash
scp uploads.tar.gz ubuntu@ВАШ_IP:~/
```

```bash
mkdir -p ~/cornet-messenger/deploy/data && tar xzf ~/uploads.tar.gz -C ~/cornet-messenger/deploy/data
```

## 5. Запуск

```bash
docker compose up -d --build
```

```bash
docker compose logs -f app
```

Готово, когда в логах появится `Server listening`. Проверить снаружи:

```bash
curl https://ВАШ_ДОМЕН/api/health
```

## 6. Пересобрать приложение

В приложении адрес сервера зашит при сборке, поэтому старый `.ipa` продолжит
стучаться на Railway. Нужна новая сборка: на GitHub, вкладка **Actions** →
**Сборка iOS (.ipa)** → **Run workflow**, в поле адреса указать
`https://ВАШ_ДОМЕН`. Готовый файл появится в артефактах.

Заодно поменяйте адрес по умолчанию в `.github/workflows/ios.yml`, чтобы сборки
по пушу тоже шли на новый сервер.

## Обновление в дальнейшем

```bash
cd ~/cornet-messenger && git pull && cd deploy && docker compose up -d --build
```

## Резервная копия

База — единственное, что не восстановить. Раз в сутки:

```bash
docker compose exec -T db pg_dump -U cornet cornet | gzip > ~/backup-$(date +%F).sql.gz
```

Стоит завести это в `crontab -e` и складывать копии куда-нибудь за пределы этой
машины — например в Object Storage.
