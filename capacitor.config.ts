import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Нативная обёртка. Ассеты бандлятся в приложение (webDir), а не грузятся с
 * сервера: так приложение открывается мгновенно и без сети, и у Apple меньше
 * поводов посчитать его «сайтом в коробке» (Guideline 4.2).
 *
 * appId должен совпадать с Bundle Identifier в Xcode и с APNS_BUNDLE_ID на
 * сервере — иначе APNs отвергнет пуши с BadTopic.
 *
 * Адрес API задаётся при сборке: VITE_API_URL=https://… npm run build.
 * Без него клиент пойдёт по относительным путям — в WebView это capacitor://localhost,
 * где никакого сервера нет.
 */
const config: CapacitorConfig = {
  appId: 'app.cornet.messenger',
  appName: 'CorNet',
  webDir: 'dist',
  ios: {
    // Прокрутку ленты сообщений полностью ведёт наш CSS; нативные отступы
    // WebView добавили бы к ним свои и сломали позиционирование.
    contentInset: 'never',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
}

export default config
