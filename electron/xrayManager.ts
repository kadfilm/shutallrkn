import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { generateXrayConfig, ServerNode } from './subscriptionParser'
import { getBinDir, getWritableDir } from './paths'

const execAsync = promisify(exec)

export class XrayManager {
  private process: ChildProcess | null = null
  private binPath: string
  private writableDir: string

  constructor() {
    this.writableDir = getWritableDir()
    const platform = os.platform()
    const binDir = getBinDir(platform === 'win32' ? 'win' : 'mac')
    
    if (platform === 'win32') {
      this.binPath = path.join(binDir, 'xray.exe')
    } else if (platform === 'darwin') {
      this.binPath = path.join(binDir, 'xray')
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

    const configPath = path.join(this.writableDir, 'config.json')
    await fs.writeFile(configPath, JSON.stringify(configObj, null, 2))

    console.log('[Xray] Generated config:', JSON.stringify(configObj, null, 2))

    // Make sure the binary is executable on macOS
    if (os.platform() === 'darwin') {
      await execAsync(`chmod +x "${this.binPath}"`)
    }

    // Verify binary exists
    try {
      await fs.access(this.binPath)
    } catch {
      throw new Error(`Xray binary not found at: ${this.binPath}`)
    }

    return new Promise<void>((resolve, reject) => {
      this.process = spawn(this.binPath, ['run', '-c', configPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let settled = false
      
      // Timeout: if Xray doesn't produce output in 5 seconds, assume it started OK
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          console.log('[Xray] Startup timeout reached, assuming started OK')
          resolve()
        }
      }, 5000)

      this.process.stdout?.on('data', (data) => {
        const msg = data.toString()
        console.log(`[Xray] ${msg}`)
        // Xray logs "Xray started" or similar when it's ready
        if (!settled && (msg.includes('started') || msg.includes('listening'))) {
          settled = true
          clearTimeout(timeout)
          resolve()
        }
      })

      this.process.stderr?.on('data', (data) => {
        const msg = data.toString()
        console.error(`[Xray Error] ${msg}`)
        if (!settled) {
          // Don't reject on warnings, only on fatal errors
          if (msg.toLowerCase().includes('fatal') || msg.toLowerCase().includes('failed to start')) {
            settled = true
            clearTimeout(timeout)
            reject(new Error(`Xray failed to start: ${msg}`))
          }
        }
      })

      this.process.on('close', (code) => {
        console.log(`[Xray] process exited with code ${code}`)
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          if (code !== 0 && code !== null) {
            reject(new Error(`Xray process exited with code ${code}`))
          } else {
            resolve()
          }
        }
        this.process = null
      })

      this.process.on('error', (err) => {
        console.error(`[Xray] Failed to spawn process:`, err)
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error(`Failed to start Xray: ${err.message}`))
        }
      })
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

  /**
   * Get all active network services on macOS.
   * Falls back to ['Wi-Fi'] if detection fails.
   */
  private async getActiveNetworkServices(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('networksetup -listallnetworkservices')
      const allServices = stdout.split('\n')
        .filter(line => line.trim() && !line.startsWith('*') && !line.startsWith('An asterisk'))
      
      const active: string[] = []
      for (const svc of allServices) {
        try {
          const { stdout: info } = await execAsync(`networksetup -getinfo "${svc}"`)
          // Check if this interface has a real IP (not "none")
          const ipMatch = info.match(/^IP address:\s*(.+)/m)
          if (ipMatch && ipMatch[1].trim() !== 'none') {
            active.push(svc)
          }
        } catch {
          // Skip services that error out
        }
      }
      
      console.log(`[Proxy] Detected active network services: ${active.join(', ')}`)
      return active.length > 0 ? active : ['Wi-Fi']
    } catch (err) {
      console.error('[Proxy] Failed to detect network services, falling back to Wi-Fi', err)
      return ['Wi-Fi']
    }
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
        // Auto-detect all active network services instead of hardcoding "Wi-Fi"
        const services = await this.getActiveNetworkServices()
        
        for (const networkservice of services) {
          try {
            if (enable) {
              await execAsync(`networksetup -setwebproxy "${networkservice}" 127.0.0.1 ${port}`)
              await execAsync(`networksetup -setsecurewebproxy "${networkservice}" 127.0.0.1 ${port}`)
              await execAsync(`networksetup -setsocksfirewallproxy "${networkservice}" 127.0.0.1 10808`)
              console.log(`[Proxy] Enabled proxy on "${networkservice}"`)
            } else {
              await execAsync(`networksetup -setwebproxystate "${networkservice}" off`)
              await execAsync(`networksetup -setsecurewebproxystate "${networkservice}" off`)
              await execAsync(`networksetup -setsocksfirewallproxystate "${networkservice}" off`)
              console.log(`[Proxy] Disabled proxy on "${networkservice}"`)
            }
          } catch (err) {
            console.error(`[Proxy] Failed to set proxy on "${networkservice}"`, err)
          }
        }
      }
    } catch (err) {
      console.error('Failed to set system proxy', err)
    }
  }
}
