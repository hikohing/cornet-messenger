'use strict'

const { app, BrowserWindow, shell, Menu, dialog, session, desktopCapturer } = require('electron')
const path = require('node:path')
const { MirrorStore, pickWorkingMirror, checkMirrorHealth, refreshRemoteMirrors } = require('./mirrors.js')

const MIRROR_HEALTH_INTERVAL_MS = 30_000
const REMOTE_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

const isDev = !app.isPackaged
const resourcesDir = isDev ? path.join(__dirname, '..', 'resources') : process.resourcesPath
const offlinePage = path.join(resourcesDir, 'offline.html')

let mainWindow = null
let store = null
let currentMirror = null
let mirrorCheckInFlight = false

/**
 * The window navigates directly to the chosen mirror's own https origin — same as
 * opening the site in a normal browser tab. This is deliberate: the whole app's auth
 * is a single SameSite=Lax cookie, which browsers refuse to attach to cross-origin
 * fetch/WebSocket calls. An earlier version served the SPA from a separate local
 * origin and talked to the API cross-origin — that silently broke every request
 * (login, chat, everything) because the cookie never made it across. Loading the real
 * origin directly keeps everything same-origin, so cookies/CORS/CSP all behave exactly
 * like the existing web deployment, with zero special-casing needed in the frontend.
 */
async function loadMirror(mirror) {
  currentMirror = mirror
  restrictNavigation(mainWindow.webContents, mirror)
  try {
    await mainWindow.loadURL(mirror)
  } catch (err) {
    console.error(`Не удалось загрузить ${mirror}:`, err)
    await showOffline()
  }
}

async function showOffline() {
  currentMirror = null
  await mainWindow.loadFile(offlinePage)
}

async function connectToBestMirror({ reloadCurrent = true } = {}) {
  const mirror = await pickWorkingMirror(store)
  if (mirror) {
    const loadedUrl = mainWindow?.webContents.getURL() ?? ''
    if (!reloadCurrent && mirror === currentMirror && loadedUrl.startsWith(mirror)) return
    await loadMirror(mirror)
  } else {
    await showOffline()
  }
}

function restrictNavigation(webContents, allowedOrigin) {
  webContents.removeAllListeners('will-navigate')
  webContents.on('will-navigate', (event, url) => {
    if (url === 'connecto-retry://') {
      event.preventDefault()
      void connectToBestMirror()
      return
    }
    if (url.startsWith(allowedOrigin)) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  })
  webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

/**
 * Без этого обработчика `getDisplayMedia` в Electron отказывает с
 * «NotSupported», и кнопка демонстрации экрана в звонке не делает ровно ничего:
 * клиент считает отказ выбором пользователя и молчит. Выбор источника в
 * браузере показывает сам браузер, здесь его показать некому — поэтому один
 * экран отдаём сразу, а из нескольких даём выбрать в нативном диалоге.
 */
function enableScreenSharing() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const screens = await desktopCapturer.getSources({ types: ['screen'] })
        if (screens.length === 0) {
          callback()
          return
        }
        if (screens.length === 1) {
          callback({ video: screens[0] })
          return
        }
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: 'Демонстрация экрана',
          message: 'Какой экран показать собеседнику?',
          buttons: [...screens.map((s) => s.name), 'Отмена'],
          cancelId: screens.length,
          defaultId: 0,
        })
        const chosen = screens[response]
        if (!chosen) {
          callback()
          return
        }
        callback({ video: chosen })
      } catch (err) {
        console.error('Не удалось получить список экранов:', err)
        callback()
      }
    },
    // Звук системы не захватываем: клиент просит только видео, а лишний поток
    // отдал бы собеседнику всё, что играет на компьютере.
    { useSystemPicker: false },
  )
}

function startMirrorMonitoring() {
  setInterval(async () => {
    if (mirrorCheckInFlight || !mainWindow || mainWindow.isDestroyed()) return
    mirrorCheckInFlight = true
    try {
      if (!currentMirror) {
        // Currently on the offline page — keep looking for a live mirror.
        await connectToBestMirror()
        return
      }
      const healthy = await checkMirrorHealth(currentMirror)
      if (!healthy) await connectToBestMirror({ reloadCurrent: false })
    } finally {
      mirrorCheckInFlight = false
    }
  }, MIRROR_HEALTH_INTERVAL_MS)

  void refreshRemoteMirrors(store)
  setInterval(() => void refreshRemoteMirrors(store), REMOTE_REFRESH_INTERVAL_MS)
}

/**
 * Reads the new build straight from GitHub Releases (see electron-builder.yml's
 * `publish` block) — a public repo, so no token is baked into the shipped binary.
 * Failure here (offline, no releases yet, DPI blocking github.com) is silent and
 * never blocks the app: this is a nice-to-have, not a dependency for the app to work.
 */
function startAutoUpdate() {
  if (isDev) return
  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch (err) {
    console.error('electron-updater недоступен:', err)
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.on('error', (err) => console.error('Ошибка автообновления:', err))
  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Перезапустить сейчас', 'Позже'],
        defaultId: 0,
        title: 'Доступно обновление',
        message: `Загружена версия ${info.version}. Перезапустить приложение сейчас, чтобы применить обновление?`,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
  })
  const check = () => void autoUpdater.checkForUpdates().catch((err) => console.error('Проверка обновлений не удалась:', err))
  check()
  setInterval(check, UPDATE_CHECK_INTERVAL_MS)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: isDev,
    },
  })
  Menu.setApplicationMenu(null)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Второй запуск не должен поднимать второе окно: это второй WebSocket на тот же
// аккаунт, дубли уведомлений и две копии одного разговора. Ярлык на панели задач
// нажимают чаще, чем ищут уже открытое окно, — поэтому фокусируем имеющееся.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

app.whenReady().then(async () => {
  // Windows опознаёт приложение в центре уведомлений по этому идентификатору.
  // Без него всплывающие уведомления о сообщениях приходят от «Electron» — а в
  // portable-сборке, у которой нет ярлыка в меню «Пуск», не приходят вовсе.
  app.setAppUserModelId('com.connecto.desktop')
  store = new MirrorStore({
    defaultsPath: path.join(resourcesDir, 'mirrors.default.json'),
    userDataPath: path.join(app.getPath('userData'), 'mirrors.json'),
  })
  createWindow()
  enableScreenSharing()
  await connectToBestMirror()
  startMirrorMonitoring()
  startAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      void connectToBestMirror()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
