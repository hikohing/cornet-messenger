'use strict'

const { app, BrowserWindow, shell, Menu } = require('electron')
const path = require('node:path')
const { MirrorStore, pickWorkingMirror, checkMirrorHealth, refreshRemoteMirrors } = require('./mirrors.js')

const MIRROR_HEALTH_INTERVAL_MS = 30_000
const REMOTE_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

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

app.whenReady().then(async () => {
  store = new MirrorStore({
    defaultsPath: path.join(resourcesDir, 'mirrors.default.json'),
    userDataPath: path.join(app.getPath('userData'), 'mirrors.json'),
  })
  createWindow()
  await connectToBestMirror()
  startMirrorMonitoring()

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
