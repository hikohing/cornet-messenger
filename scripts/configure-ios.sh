#!/bin/bash
# Донастройка нативного проекта iOS после `cap add ios`.
#
# Папка ios/ не хранится в репозитории — её каждый раз генерирует Capacitor из
# шаблона, а шаблон ничего не знает ни про наши разрешения, ни про CallKit.
# Поэтому всё, что обычно делают руками в Xcode, делается здесь: иначе оно
# терялось бы при каждой пересборке.
set -euo pipefail

APP_DIR="ios/App/App"
PLIST="$APP_DIR/Info.plist"
APP_DELEGATE="$APP_DIR/AppDelegate.swift"

if [ ! -f "$PLIST" ]; then
  echo "Не найден $PLIST — похоже, cap add ios не отработал" >&2
  exit 1
fi

echo "→ Минимальная версия iOS"
# Шаблон Capacitor ставит 15.0, но на такой системе приложение бесполезно: вся
# переписка шифруется X25519 и Ed25519 через WebCrypto, а их WebKit узнал только
# в Safari 17.4. На iOS постарше ключи не создаются вовсе — не отправляется и не
# читается ни одно сообщение. Пусть система лучше не даст поставить приложение,
# чем поставит заведомо нерабочее.
MIN_IOS="17.4"
find ios -name project.pbxproj -print0 | xargs -0 sed -i '' -E "s/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/IPHONEOS_DEPLOYMENT_TARGET = $MIN_IOS;/g"
if [ -f ios/App/Podfile ]; then
  sed -i '' -E "s/^platform :ios, '[0-9.]+'/platform :ios, '$MIN_IOS'/" ios/App/Podfile
fi
echo "  $MIN_IOS"

echo "→ Разрешения в Info.plist"
# Без этих строк приложение падает при первом же обращении к камере или микрофону.
add_string() {
  /usr/libexec/PlistBuddy -c "Delete :$1" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}
add_string NSCameraUsageDescription "Камера нужна для видеозвонков и съёмки фото в чат"
add_string NSMicrophoneUsageDescription "Микрофон нужен для звонков и голосовых сообщений"
add_string NSPhotoLibraryUsageDescription "Доступ к фото нужен, чтобы отправлять их в чат"

echo "→ Фоновые режимы"
# voip — чтобы приложение просыпалось от VoIP-пуша и показывало входящий звонок.
# Это ключ Info.plist, а не entitlement: бесплатной подписи он доступен.
/usr/libexec/PlistBuddy -c "Delete :UIBackgroundModes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes:0 string voip" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes:1 string remote-notification" "$PLIST"

echo "→ Запуск CallCenter из AppDelegate"
# CallKit и PushKit обязаны подняться до появления WebView: VoIP-пуш может
# разбудить приложение раньше, чем загрузится веб-часть, а iOS требует показать
# входящий звонок немедленно.
if grep -q "CallCenter.shared.configure()" "$APP_DELEGATE"; then
  echo "  уже настроено"
else
  python3 - "$APP_DELEGATE" << 'PY'
import re, sys

path = sys.argv[1]
source = open(path, encoding='utf-8').read()

if 'import CornetCallkit' not in source:
    source = source.replace('import Capacitor', 'import Capacitor\nimport CornetCallkit', 1)

anchor = re.search(r'(func application\([^)]*didFinishLaunchingWithOptions[^)]*\)\s*->\s*Bool\s*\{)', source, re.S)
if not anchor:
    sys.exit('Не найден didFinishLaunchingWithOptions в AppDelegate — шаблон Capacitor изменился')

source = source[:anchor.end()] + '\n        CallCenter.shared.configure()' + source[anchor.end():]
open(path, 'w', encoding='utf-8').write(source)
print('  добавлено')
PY
fi

echo "Готово"
