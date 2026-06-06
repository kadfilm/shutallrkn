import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { generateXrayConfig, ServerNode } from './subscriptionParser'

const execAsync = promisify(exec)

export class XrayManager {
  private process: ChildProcess | null = null
  private binPath: string
  private appRoot: string

  constructor(appRoot: string) {
    this.appRoot = appRoot
    const platform = os.platform()
    const arch = os.arch()
    
    // We expect the binaries to be in resources/bin
    if (platform === 'win32') {
      this.binPath = path.join(appRoot, 'resources', 'bin', 'win', 'xray.exe')
    } else if (platform === 'darwin') {
      this.binPath = path.join(appRoot, 'resources', 'bin', 'mac', 'xray')
    } else {
      throw new Error(`Unsupported platform: ${platform}`)
    }
  }

  public async start(node: any) {
    await this.stop()

    // If the subscription parser got a full raw JSON config (like from easy-api/happ)
    // We use it directly. Otherwise, we generate it from vless:// params.
    let configObj;
    if (node.rawConfig) {
      configObj = node.rawConfig;
      // Force our local ports just in case
      configObj.inbounds = [
        {
          port: 10808,
          listen: "127.0.0.1",
          protocol: "socks",
          settings: { udp: true }
        },
        {
          port: 10809,
          listen: "127.0.0.1",
          protocol: "http"
        }
      ];
    } else {
      configObj = generateXrayConfig(node, 10808, 10809);
    }

    const configPath = path.join(this.appRoot, 'config.json')
    await fs.writeFile(configPath, JSON.stringify(configObj, null, 2))

    // Make sure the binary is executable on macOS
    if (os.platform() === 'darwin') {
      await execAsync(`chmod +x "${this.binPath}"`)
    }

    this.process = spawn(this.binPath, ['run', '-c', configPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.process.stdout?.on('data', (data) => {
      console.log(`[Xray] ${data.toString()}`)
    })

    this.process.stderr?.on('data', (data) => {
      console.error(`[Xray Error] ${data.toString()}`)
    })

    this.process.on('close', (code) => {
      console.log(`[Xray] process exited with code ${code}`)
      this.process = null
    })
  }

  async stop() {
    return new Promise<void>((resolve) => {
      if (this.process) {
        this.process.on('close', () => {
          resolve()
        })
        this.process.kill('SIGTERM')
      } else {
        resolve()
      }
    })
  }

  async setSystemProxy(enable: boolean, port: number = 10809) {
    const platform = os.platform()
    
    try {
      if (platform === 'win32') {
        if (enable) {
          await execAsync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`)
          await execAsync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`)
        } else {
          await execAsync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`)
        }
      } else if (platform === 'darwin') {
        // macOS proxy settings (assuming Wi-Fi for now, ideally iterate over all active network services)
        const networkservice = "Wi-Fi" 
        if (enable) {
          await execAsync(`networksetup -setwebproxy "${networkservice}" 127.0.0.1 ${port}`)
          await execAsync(`networksetup -setsecurewebproxy "${networkservice}" 127.0.0.1 ${port}`)
          await execAsync(`networksetup -setsocksfirewallproxy "${networkservice}" 127.0.0.1 10808`)
        } else {
          await execAsync(`networksetup -setwebproxystate "${networkservice}" off`)
          await execAsync(`networksetup -setsecurewebproxystate "${networkservice}" off`)
          await execAsync(`networksetup -setsocksfirewallproxystate "${networkservice}" off`)
        }
      }
    } catch (err) {
      console.error('Failed to set system proxy', err)
    }
  }
}
