import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'

const execAsync = promisify(exec)

/**
 * TUN Manager — creates a virtual network interface (utun) via tun2socks
 * that captures ALL system traffic and routes it through the Xray SOCKS5 proxy.
 * This turns a simple proxy into a full VPN.
 * 
 * Flow:
 * 1. Start tun2socks → creates utun device connected to SOCKS5
 * 2. Configure routing → all traffic goes through utun
 * 3. Set DNS → prevent DNS leaks
 * 
 * Requires admin privileges on macOS.
 */
export class TunManager {
  private process: ChildProcess | null = null
  private binPath: string
  private originalGateway: string = ''
  private originalDns: Map<string, string[]> = new Map()
  private vpnServerIp: string = ''
  private tunDevice: string = 'utun99'
  private tunGateway: string = '198.18.0.1'
  private isActive: boolean = false

  constructor(appRoot: string) {
    const platform = os.platform()
    if (platform === 'darwin') {
      this.binPath = path.join(appRoot, 'resources', 'bin', 'mac', 'tun2socks-darwin-amd64')
    } else if (platform === 'win32') {
      // Windows TUN support can be added later with wintun
      this.binPath = ''
    } else {
      this.binPath = ''
    }
  }

  /**
   * Execute a command with admin privileges on macOS.
   * Shows the system password dialog.
   */
  private async execAsAdmin(command: string): Promise<string> {
    const platform = os.platform()
    if (platform === 'darwin') {
      // Use osascript to request admin privileges — shows macOS password dialog
      const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      try {
        const { stdout } = await execAsync(
          `osascript -e 'do shell script "${escaped}" with administrator privileges'`,
          { timeout: 30000 }
        )
        return stdout.trim()
      } catch (err: any) {
        console.error(`[TUN] Admin command failed: ${command}`, err.message)
        throw err
      }
    }
    // Fallback for other platforms
    const { stdout } = await execAsync(command)
    return stdout.trim()
  }

  /**
   * Get the current default gateway on macOS.
   */
  private async getDefaultGateway(): Promise<string> {
    try {
      const { stdout } = await execAsync('route -n get default 2>/dev/null | grep gateway')
      const match = stdout.match(/gateway:\s*(\S+)/)
      return match ? match[1] : ''
    } catch {
      return ''
    }
  }

  /**
   * Get all active network service names on macOS.
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
          const ipMatch = info.match(/^IP address:\s*(.+)/m)
          if (ipMatch && ipMatch[1].trim() !== 'none') {
            active.push(svc)
          }
        } catch { /* skip */ }
      }
      return active.length > 0 ? active : ['Wi-Fi']
    } catch {
      return ['Wi-Fi']
    }
  }

  /**
   * Save current DNS settings for restoration later.
   */
  private async saveDnsSettings(): Promise<void> {
    const services = await this.getActiveNetworkServices()
    this.originalDns.clear()
    for (const svc of services) {
      try {
        const { stdout } = await execAsync(`networksetup -getdnsservers "${svc}"`)
        if (!stdout.includes("any DNS Servers")) {
          this.originalDns.set(svc, stdout.trim().split('\n'))
        } else {
          this.originalDns.set(svc, [])
        }
      } catch {
        this.originalDns.set(svc, [])
      }
    }
  }

  /**
   * Start TUN mode: create utun interface, set up routing, configure DNS.
   * @param vpnServerAddress - The remote VPN server IP/hostname that Xray connects to
   * @param socksPort - Local SOCKS5 port (default 10808)
   */
  async start(vpnServerAddress: string, socksPort: number = 10808): Promise<void> {
    if (this.isActive) await this.stop()
    if (!this.binPath) {
      console.log('[TUN] TUN mode not available on this platform, skipping')
      return
    }

    const platform = os.platform()
    if (platform !== 'darwin') return

    console.log('[TUN] Starting TUN mode...')

    // Resolve hostname to IP if needed
    try {
      const { stdout } = await execAsync(`dig +short "${vpnServerAddress}" | head -1`)
      this.vpnServerIp = stdout.trim() || vpnServerAddress
    } catch {
      this.vpnServerIp = vpnServerAddress
    }

    // Verify binary exists
    try {
      await fs.access(this.binPath)
    } catch {
      throw new Error(`tun2socks binary not found at: ${this.binPath}`)
    }

    await execAsync(`chmod +x "${this.binPath}"`)

    // Save current network state
    this.originalGateway = await this.getDefaultGateway()
    if (!this.originalGateway) {
      throw new Error('Could not determine default gateway')
    }
    console.log(`[TUN] Original gateway: ${this.originalGateway}`)

    await this.saveDnsSettings()

    // Start tun2socks process with admin privileges
    // We need to run tun2socks as root to create TUN interface
    // Spawn it via a helper that osascript launches
    const tun2socksCmd = `"${this.binPath}" -device ${this.tunDevice} -proxy socks5://127.0.0.1:${socksPort} -loglevel warning`

    // Start tun2socks as background admin process
    try {
      // We use osascript to start tun2socks with admin privileges in the background
      await this.execAsAdmin(`${tun2socksCmd} &`)
    } catch (err: any) {
      // If the user cancelled the password dialog
      if (err.message?.includes('User canceled') || err.message?.includes('-128')) {
        throw new Error('Требуются права администратора для создания VPN-интерфейса')
      }
      throw err
    }

    // Wait for the utun interface to come up
    let tunUp = false
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        const { stdout } = await execAsync(`ifconfig ${this.tunDevice} 2>/dev/null`)
        if (stdout.includes(this.tunDevice)) {
          tunUp = true
          break
        }
      } catch { /* not ready yet */ }
    }

    if (!tunUp) {
      throw new Error('TUN interface failed to come up within 5 seconds')
    }

    console.log(`[TUN] Interface ${this.tunDevice} is up`)

    // Configure the TUN interface and routing with admin privileges
    const setupCommands = [
      // Configure utun interface
      `ifconfig ${this.tunDevice} ${this.tunGateway} ${this.tunGateway} up`,
      // Route VPN server through original gateway (so Xray can still reach it)
      `route add -host ${this.vpnServerIp} ${this.originalGateway}`,
      // Route all traffic through TUN using two halves (avoids replacing default route)
      `route add -net 0.0.0.0/1 ${this.tunGateway}`,
      `route add -net 128.0.0.0/1 ${this.tunGateway}`,
    ].join(' && ')

    await this.execAsAdmin(setupCommands)
    console.log('[TUN] Routes configured')

    // Set DNS to prevent leaks
    const services = await this.getActiveNetworkServices()
    for (const svc of services) {
      try {
        await this.execAsAdmin(`networksetup -setdnsservers "${svc}" 1.1.1.1 8.8.8.8`)
      } catch { /* non-critical */ }
    }
    console.log('[TUN] DNS configured')

    this.isActive = true
    console.log('[TUN] TUN mode active — all traffic routed through VPN')
  }

  /**
   * Stop TUN mode: restore routes, DNS, kill tun2socks.
   */
  async stop(): Promise<void> {
    if (!this.isActive) return

    const platform = os.platform()
    if (platform !== 'darwin') return

    console.log('[TUN] Stopping TUN mode...')

    try {
      // Remove our routes
      const cleanupCommands = [
        `route delete -net 0.0.0.0/1 ${this.tunGateway} 2>/dev/null || true`,
        `route delete -net 128.0.0.0/1 ${this.tunGateway} 2>/dev/null || true`,
        `route delete -host ${this.vpnServerIp} 2>/dev/null || true`,
      ].join(' && ')

      await this.execAsAdmin(cleanupCommands)
    } catch (err) {
      console.error('[TUN] Failed to clean up routes', err)
    }

    // Kill tun2socks process
    try {
      await this.execAsAdmin('pkill -f tun2socks-darwin-amd64 2>/dev/null || true')
    } catch { /* ok if already dead */ }

    // Restore DNS
    const services = await this.getActiveNetworkServices()
    for (const svc of services) {
      try {
        const originalDns = this.originalDns.get(svc)
        if (originalDns && originalDns.length > 0) {
          await this.execAsAdmin(`networksetup -setdnsservers "${svc}" ${originalDns.join(' ')}`)
        } else {
          await this.execAsAdmin(`networksetup -setdnsservers "${svc}" empty`)
        }
      } catch { /* non-critical */ }
    }

    // Flush DNS cache
    try {
      await this.execAsAdmin('dscacheutil -flushcache && killall -HUP mDNSResponder 2>/dev/null || true')
    } catch { /* ok */ }

    this.isActive = false
    this.vpnServerIp = ''
    console.log('[TUN] TUN mode stopped, original network restored')
  }

  get active(): boolean {
    return this.isActive
  }
}
