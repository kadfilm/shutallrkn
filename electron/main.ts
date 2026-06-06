import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

import { XrayManager } from './xrayManager'
import { ZapretManager } from './zapretManager'
import { TgProxyManager } from './tgProxyManager'
import { fetchSubscription, generateXrayConfig, ServerNode } from './subscriptionParser'

let win: BrowserWindow | null
let xrayManager: XrayManager
let zapretManager: ZapretManager
let tgProxyManager: TgProxyManager

function createWindow() {
  xrayManager = new XrayManager(process.env.APP_ROOT)
  zapretManager = new ZapretManager(process.env.APP_ROOT)
  tgProxyManager = new TgProxyManager(process.env.APP_ROOT)

  win = new BrowserWindow({
    width: 900,
    height: 600,
    icon: path.join(process.env.VITE_PUBLIC, 'vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0B1120',
      symbolColor: '#F8FAFC'
    }
  })

  // IPC handlers
  ipcMain.handle('fetch-subscription', async (event, url) => {
    try {
      return await fetchSubscription(url)
    } catch (e: any) {
      console.error(e)
      return { error: e.message }
    }
  })

  ipcMain.handle('connect-vpn', async (event, node: ServerNode) => {
    try {
      const config = generateXrayConfig(node)
      await xrayManager.start(config)
      await xrayManager.setSystemProxy(true, 10809)
      return { success: true }
    } catch (e: any) {
      console.error(e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('disconnect-vpn', async () => {
    try {
      await xrayManager.stop()
      await xrayManager.setSystemProxy(false)
      return { success: true }
    } catch (e: any) {
      console.error(e)
      return { success: false, error: e.message }
    }
  })

  // Zapret / Telegram IPC
  ipcMain.handle('toggle-zapret', async (event, enable: boolean) => {
    try {
      if (enable) await zapretManager.startDiscordYoutube()
      else await zapretManager.stop()
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('toggle-tg-proxy', async (event, enable: boolean) => {
    try {
      if (enable) await tgProxyManager.start()
      else await tgProxyManager.stop()
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })
  
  // win.webContents.openDevTools()

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('will-quit', async (event) => {
  event.preventDefault();
  if (xrayManager) {
    await xrayManager.stop();
    await xrayManager.setSystemProxy(false);
  }
  if (zapretManager) await zapretManager.stop();
  if (tgProxyManager) await tgProxyManager.stop();
  app.exit(0);
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)
