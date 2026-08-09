/**
 * Origin'ы нативной обёртки (Capacitor). WebView грузит клиент с локальной
 * схемы, а не с домена сервера, поэтому такой origin никогда не совпадёт с
 * host запроса и его приходится разрешать явно. Список фиксированный: это не
 * пользовательский ввод, а те два значения, которые WKWebView и Android WebView
 * вообще способны прислать.
 */
export const NATIVE_ORIGINS = new Set(['capacitor://localhost', 'ionic://localhost'])
