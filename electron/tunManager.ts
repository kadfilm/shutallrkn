import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'

const execAsync = promisify(exec)

export type TunStatus = 'off' | 'starting' | 'active' | 'fallback' | 'error'

export interface TunStatusInfo {
  status: TunStatus
  message: string
}

/**
 * TUN Manager — creates a virtual network interface (utun) via tun2socks
 * that captures ALL system traffic and routes it through the Xray SOCKS5 proxy.
 */
export class TunManager {
  private binPath: string
  private appRoot: string
  private originalGateway: string = ''
  private originalDns: Map<string, string[]> = new Map()
  private vpnServerIps: string[] = []
  private tunDevice: string = 'utun99'
  private tunGateway: string = '198.18.0.1'
  private _status: TunStatus = 'off'
  private _statusMessage: string = ''
  private onStatusChange?: (info: TunStatusInfo) => void

  constructor(appRoot: string) {
    this.appRoot = appRoot
    if (os.platform() === 'darwin') {
      this.binPath = path.join(appRoot, 'resources', 'bin', 'mac', 'tun2socks-darwin-amd64')
    } else {
      this.binPath = ''
    }
  }

  setStatusCallback(cb: (info: TunStatusInfo) => void) {
    this.onStatusChange = cb
  }

  private setStatus(status: TunStatus, message: string) {
    this._status = status
    this._statusMessage = message
    console.log(`[TUN] ${status}: ${message}`)
    this.onStatusChange?.({ status, message })
  }

  get status(): TunStatus { return this._status }
  get statusMessage(): string { return this._statusMessage }
  get active(): boolean { return this._status === 'active' }
  get statusInfo(): TunStatusInfo { return { status: this._status, message: this._statusMessage } }

  /**
   * Write a shell script to a temp file, then run it with admin privileges via osascript.
   * This avoids all quoting nightmares with inline osascript commands.
   */
  private async runScriptAsAdmin(scriptContent: string): Promise<string> {
    const scriptPath = path.join(this.appRoot, '.tun-script.sh')
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 })

    try {
      const { stdout } = await execAsync(
        `osascript -e 'do shell script "${scriptPath}" with administrator privileges'`,
        { timeout: 60000 }
      )
      return stdout.trim()
    } catch (err: any) {
      if (err.message?.includes('User canceled') || err.message?.includes('-128')) {
        throw new Error('USER_CANCELLED')
      }
      throw err
    } finally {
      // Clean up script file
      try { await fs.unlink(scriptPath) } catch {}
    }
  }

  private async getDefaultGateway(): Promise<string> {
    try {
      const { stdout } = await execAsync('route -n get default 2>/dev/null | grep gateway')
      const match = stdout.match(/gateway:\s*(\S+)/)
      return match ? match[1] : ''
    } catch { return '' }
  }

  private async getActiveNetworkServices(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('networksetup -listallnetworkservices')
      const allServices = stdout.split('\n')
        .filter(line => line.trim() && !line.startsWith('*') && !line.startsWith('An asterisk'))
      const active: string[] = []
      for (const svc of allServices) {
        try {
          const { stdout: info } = await execAsync(`networksetup -getinfo "${svc}"`)
          if (info.match(/^IP address:\s*(?!none).+/m)) active.push(svc)
        } catch {}
      }
      return active.length > 0 ? active : ['Wi-Fi']
    } catch { return ['Wi-Fi'] }
  }

  private async saveDnsSettings(): Promise<void> {
    const services = await this.getActiveNetworkServices()
    this.originalDns.clear()
    for (const svc of services) {
      try {
        const { stdout } = await execAsync(`networksetup -getdnsservers "${svc}"`)
        this.originalDns.set(svc, stdout.includes("any DNS Servers") ? [] : stdout.trim().split('\n'))
      } catch { this.originalDns.set(svc, []) }
    }
  }

  /**
   * Start TUN mode with a SINGLE admin password prompt.
   * @param vpnServerAddresses - ALL remote VPN server IPs/hostnames that Xray connects to
   * @param socksPort - Local SOCKS5 port
   */
  async start(vpnServerAddresses: string[], socksPort: number = 10808): Promise<void> {
    if (this._status === 'active') await this.stop()
    if (!this.binPath || os.platform() !== 'darwin') {
      this.setStatus('off', 'TUN не доступен на этой платформе')
      return
    }

    this.setStatus('starting', 'Подготовка TUN-интерфейса...')

    // Resolve all hostnames to IPs
    this.vpnServerIps = []
    for (const addr of vpnServerAddresses) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
        this.vpnServerIps.push(addr)
      } else {
        try {
          const { stdout } = await execAsync(`dig +short "${addr}" | head -1`)
          const resolved = stdout.trim()
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(resolved)) {
            this.vpnServerIps.push(resolved)
          } else {
            this.vpnServerIps.push(addr)
          }
        } catch { this.vpnServerIps.push(addr) }
      }
    }
    console.log(`[TUN] VPN server IPs to bypass: ${this.vpnServerIps.join(', ')}`)

    // Verify binary
    try { await fs.access(this.binPath) } catch {
      this.setStatus('error', 'Бинарник tun2socks не найден')
      throw new Error('tun2socks not found')
    }
    await execAsync(`chmod +x "${this.binPath}"`)

    // Save current network state
    this.originalGateway = await this.getDefaultGateway()
    if (!this.originalGateway) {
      this.setStatus('error', 'Не удалось определить шлюз')
      throw new Error('No default gateway')
    }
    await this.saveDnsSettings()

    // Build DNS setup commands
    const services = await this.getActiveNetworkServices()
    const dnsLines = services.map(svc => `networksetup -setdnsservers "${svc}" 1.1.1.1 8.8.8.8`).join('\n')
    const ipv6DisableLines = services.map(svc => `networksetup -setv6off "${svc}" 2>/dev/null || true`).join('\n')

    this.setStatus('starting', 'Запрос прав администратора...')

    // Build the startup script — no quoting issues since it's a file
    const startScript = `#!/bin/bash
# Kill any old tun2socks
pkill -f tun2socks-darwin-amd64 2>/dev/null
sleep 0.3

# Start tun2socks in background (no nohup — osascript has no tty)
"${this.binPath}" -device ${this.tunDevice} -proxy socks5://127.0.0.1:${socksPort} -loglevel warn > /tmp/tun2socks.log 2>&1 &
TUN_PID=$!

# Wait for interface to come up (max 10 sec)
for i in $(seq 1 20); do
  ifconfig ${this.tunDevice} 2>/dev/null && break
  sleep 0.5
done

# Check if interface is up
if ! ifconfig ${this.tunDevice} 2>/dev/null; then
  echo "FAIL: interface ${this.tunDevice} not found"
  kill $TUN_PID 2>/dev/null
  exit 1
fi

# Configure interface
ifconfig ${this.tunDevice} ${this.tunGateway} ${this.tunGateway} up

# Route VPN server(s) through original gateway (CRITICAL: prevents routing loop)
${this.vpnServerIps.map(ip => `route add -host ${ip} ${this.originalGateway} 2>/dev/null || true`).join('\n')}

# Route all traffic through TUN (two /1 routes)
route add -net 0.0.0.0/1 ${this.tunGateway}
route add -net 128.0.0.0/1 ${this.tunGateway}

# Set DNS
${dnsLines}

# Disable IPv6 (leaks real location — bypasses TUN which only handles IPv4)
${ipv6DisableLines}

# Flush DNS cache
dscacheutil -flushcache
killall -HUP mDNSResponder 2>/dev/null || true

echo "OK:$TUN_PID"
`

    let result: string
    try {
      result = await this.runScriptAsAdmin(startScript)
    } catch (err: any) {
      if (err.message === 'USER_CANCELLED') {
        this.setStatus('off', 'Пользователь отменил ввод пароля')
        throw new Error('Требуются права администратора для TUN-режима')
      }
      this.setStatus('error', `Ошибка запуска: ${err.message}`)
      throw err
    }

    if (result.startsWith('FAIL')) {
      this.setStatus('error', result)
      throw new Error(result)
    }

    console.log(`[TUN] Script result: ${result}`)

    // Verify tun2socks is running
    await new Promise(r => setTimeout(r, 500))
    try {
      const { stdout } = await execAsync('ps aux | grep tun2socks-darwin-amd64 | grep -v grep')
      if (!stdout.trim()) {
        const { stdout: log } = await execAsync('cat /tmp/tun2socks.log 2>/dev/null | tail -5')
        this.setStatus('error', `tun2socks не запустился: ${log.trim()}`)
        throw new Error('tun2socks not running')
      }
    } catch (err: any) {
      if (this._status !== 'error') this.setStatus('error', 'tun2socks не запустился')
      throw err
    }

    this.setStatus('active', 'TUN активен — весь трафик через VPN')
  }

  /**
   * Stop TUN mode with a single admin call.
   */
  async stop(): Promise<void> {
    if (this._status === 'off') return
    if (os.platform() !== 'darwin') return

    this.setStatus('starting', 'Останавливаем TUN...')

    const services = await this.getActiveNetworkServices()
    const dnsRestoreLines = services.map(svc => {
      const original = this.originalDns.get(svc)
      if (original && original.length > 0) {
        return `networksetup -setdnsservers "${svc}" ${original.join(' ')}`
      }
      return `networksetup -setdnsservers "${svc}" empty`
    }).join('\n')

    const ipv6RestoreLines = services.map(svc => `networksetup -setv6automatic "${svc}" 2>/dev/null || true`).join('\n')

    const stopScript = `#!/bin/bash
# Remove routes
route delete -net 0.0.0.0/1 ${this.tunGateway} 2>/dev/null || true
route delete -net 128.0.0.0/1 ${this.tunGateway} 2>/dev/null || true
${this.vpnServerIps.map(ip => `route delete -host ${ip} 2>/dev/null || true`).join('\n')}

# Kill tun2socks
pkill -f tun2socks-darwin-amd64 2>/dev/null || true

# Restore DNS
${dnsRestoreLines}

# Restore IPv6
${ipv6RestoreLines}

# Flush DNS
dscacheutil -flushcache
killall -HUP mDNSResponder 2>/dev/null || true

echo "OK"
`

    try {
      await this.runScriptAsAdmin(stopScript)
    } catch (err) {
      console.error('[TUN] Cleanup error:', err)
    }

    this.setStatus('off', 'TUN выключен, сеть восстановлена')
    this.vpnServerIps = []
  }
}
