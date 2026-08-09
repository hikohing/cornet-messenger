import { App } from '@capacitor/app'
import { Keyboard, KeyboardResize } from '@capacitor/keyboard'
import { StatusBar, Style } from '@capacitor/status-bar'
import { isNative, platform } from './platform'

/**
 * Настройка «оболочки» нативного приложения: то, чего в браузере просто нет —
 * статус-бар, клавиатура и переходы приложения в фон. В вебе не делает ничего.
 */
export async function setupNativeShell(): Promise<void> {
  document.documentElement.dataset.platform = platform()
  if (!isNative()) return

  // Тема приложения тёмная по умолчанию; светлый контент статус-бара читается
  // на ней, а на светлой теме переключается вместе с ней (см. слушатель ниже).
  await StatusBar.setStyle({ style: document.documentElement.dataset.theme === 'light' ? Style.Light : Style.Dark }).catch(() => undefined)

  // Body-resize: WebView ужимается под клавиатуру, и лента сообщений сама
  // остаётся прокручиваемой. Native-режим вместо этого сдвигает всю вьюху и
  // прячет верх экрана с шапкой чата.
  await Keyboard.setResizeMode({ mode: KeyboardResize.Body }).catch(() => undefined)
  await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined)

  // Высота клавиатуры уезжает в CSS-переменную: поле ввода прижато к низу, и
  // без неё оно осталось бы под клавиатурой.
  void Keyboard.addListener('keyboardWillShow', (info) => {
    document.documentElement.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`)
    document.documentElement.dataset.keyboard = 'open'
  })
  void Keyboard.addListener('keyboardWillHide', () => {
    document.documentElement.style.setProperty('--keyboard-height', '0px')
    document.documentElement.dataset.keyboard = 'closed'
  })

  // Возврат из фона: WebSocket за время сна почти наверняка порвался, а
  // 'visibilitychange' в WKWebView срабатывает не всегда — дублируем событием
  // приложения, на него уже подписан клиент сокета.
  void App.addListener('appStateChange', ({ isActive }) => {
    document.dispatchEvent(new CustomEvent('native:appstate', { detail: { isActive } }))
  })
}

/** Статус-бар должен переключаться вместе с темой, иначе на светлой теме иконки сливаются с фоном. */
export function syncStatusBarWithTheme(theme: string): void {
  if (!isNative()) return
  void StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark }).catch(() => undefined)
}
