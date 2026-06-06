import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

export class ZapretManager {
  private process: ChildProcess | null = null
  private binPath: string
  private appRoot: string

  constructor(appRoot: string) {
    this.appRoot = appRoot
    const platform = os.platform()
    if (platform === 'win32') {
      this.binPath = path.join(appRoot, 'resources', 'bin', 'win', 'zapret', 'bin', 'winws.exe')
    } else {
      this.binPath = ''
    }
  }

  async startDiscordYoutube() {
    if (!this.binPath) throw new Error('Zapret is only supported on Windows')
    await this.stop()
    
    const tlsBin = path.join(this.appRoot, 'resources', 'bin', 'win', 'zapret', 'bin', 'tls_clienthello_www_google_com.bin')
    const discordList = path.join(this.appRoot, 'resources', 'bin', 'win', 'zapret', 'lists', 'discord.txt')

    // Basic working strategy for YT+Discord
    const args = [
      '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
      '--filter-udp=443', `--hostlist=${discordList}`, '--dpi-desync=fake', '--dpi-desync-udplen-increment=10', '--dpi-desync-repeats=6', '--dpi-desync-udplen-pattern=0xDEADBEEF', '--dpi-desync-any-protocol', '--new',
      '--filter-udp=50000-65535', '--dpi-desync=fake,any_invoke', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new',
      '--filter-tcp=80', `--hostlist=${discordList}`, '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--new',
      '--filter-tcp=443', `--hostlist=${discordList}`, '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', `--dpi-desync-fake-tls=${tlsBin}`
    ]

    this.process = spawn(this.binPath, args, { 
      windowsHide: true,
      cwd: this.appRoot
    })
    
    this.process.stdout?.on('data', (d) => console.log(`[Zapret] ${d}`))
    this.process.stderr?.on('data', (d) => console.error(`[Zapret Error] ${d}`))
    this.process.on('close', () => { this.process = null })
  }

  async stop() {
    if (this.process) {
      this.process.kill('SIGKILL')
      this.process = null
    }
  }
}
