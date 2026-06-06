import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

export class TgProxyManager {
  private process: ChildProcess | null = null
  private binPath: string

  constructor(appRoot: string) {
    const platform = os.platform()
    if (platform === 'win32') {
      this.binPath = path.join(appRoot, 'resources', 'bin', 'win', 'TgWsProxy_windows.exe')
    } else {
      this.binPath = '' // For Mac/Linux we skip or add later
    }
  }

  async start() {
    if (!this.binPath) throw new Error('Unsupported platform for tg-ws-proxy')
    await this.stop()
    
    this.process = spawn(this.binPath, [], { windowsHide: true })
    
    this.process.stdout?.on('data', (d) => console.log(`[TgProxy] ${d}`))
    this.process.stderr?.on('data', (d) => console.error(`[TgProxy Error] ${d}`))
    
    this.process.on('close', () => { this.process = null })
  }

  async stop() {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }
}
