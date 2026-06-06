import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
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
import { fetchSubscription, ServerNode } from './subscriptionParser'

let win: BrowserWindow | null
let tray: Tray | null = null
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
    icon: path.join(process.env.VITE_PUBLIC, 'logo.png'),
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

  // Set up Tray
  const iconPath = path.join(process.env.VITE_PUBLIC, 'logo.png')
  tray = new Tray(iconPath)
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Открыть ShutAllRKN', click: () => win?.show() },
    { type: 'separator' },
    { label: 'Выход', click: () => {
      app.quit()
    }}
  ])
  tray.setToolTip('ShutAllRKN')
  tray.setContextMenu(contextMenu)
  
  tray.on('click', () => {
    if (win) {
      if (win.isVisible()) win.hide()
      else win.show()
    }
  })

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win?.hide()
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
      await xrayManager.start(node)
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
  ipcMain.handle('toggle-zapret', async (event, enable: boolean, strategyIndex: number = 0) => {
    try {
      if (enable) await zapretManager.startDiscordYoutube(strategyIndex)
      else await zapretManager.stop()
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('test-zapret-strategies', async (event) => {
    try {
      const workingIndex = await zapretManager.findWorkingStrategy((msg, percent) => {
        // Send progress updates back to renderer
        win?.webContents.send('zapret-test-progress', { msg, percent })
      })
      return { success: true, workingIndex }
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

  // Autostart IPC
  ipcMain.handle('set-autostart', (event, enable: boolean) => {
    app.setLoginItemSettings({
      openAtLogin: enable,
      path: app.getPath('exe')
    })
    return { success: true }
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
  // We do not quit when the window is closed, it stays in the tray
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
  } else if (win) {
    win.show()
  }
})

// Custom flag to allow quitting from the tray
let isQuitting = false;
app.on('before-quit', () => {
  isQuitting = true;
});

app.whenReady().then(createWindow)
