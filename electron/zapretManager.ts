import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { getBinDir } from './paths'

// Pre-defined set of top Zapret strategies
const ZAPRET_STRATEGIES = [
  // 1: Flowseal DEFAULT
  [
    '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
    '--filter-udp=443', '--hostlist={discordList}', '--dpi-desync=fake', '--dpi-desync-udplen-increment=10', '--dpi-desync-repeats=6', '--dpi-desync-udplen-pattern=0xDEADBEEF', '--dpi-desync-any-protocol', '--new',
    '--filter-udp=50000-65535', '--dpi-desync=fake,any_invoke', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new',
    '--filter-tcp=80', '--hostlist={discordList}', '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--new',
    '--filter-tcp=443', '--hostlist={discordList}', '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-fake-tls={tlsBin}'
  ],
  // 2: FAKE TLS AUTO (ALT)
  [
    '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
    '--filter-udp=443', '--hostlist={discordList}', '--dpi-desync=fake', '--dpi-desync-udplen-increment=10', '--dpi-desync-repeats=6', '--dpi-desync-udplen-pattern=0xDEADBEEF', '--dpi-desync-any-protocol', '--new',
    '--filter-udp=50000-65535', '--dpi-desync=fake,any_invoke', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new',
    '--filter-tcp=80', '--hostlist={discordList}', '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--new',
    '--filter-tcp=443', '--hostlist={discordList}', '--dpi-desync=fake,disorder2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-fake-tls={tlsBin}'
  ],
  // 3: SIMPLE FAKE
  [
    '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
    '--filter-udp=443', '--hostlist={discordList}', '--dpi-desync=fake', '--dpi-desync-udplen-increment=10', '--dpi-desync-repeats=6', '--dpi-desync-udplen-pattern=0xDEADBEEF', '--dpi-desync-any-protocol', '--new',
    '--filter-udp=50000-65535', '--dpi-desync=fake,any_invoke', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new',
    '--filter-tcp=80', '--hostlist={discordList}', '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--new',
    '--filter-tcp=443', '--hostlist={discordList}', '--dpi-desync=fake', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-fake-tls={tlsBin}'
  ],
  // 4: ALT 6 (More aggressive desync)
  [
    '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
    '--filter-udp=443', '--hostlist={discordList}', '--dpi-desync=fake', '--dpi-desync-udplen-increment=10', '--dpi-desync-repeats=6', '--dpi-desync-udplen-pattern=0xDEADBEEF', '--dpi-desync-any-protocol', '--new',
    '--filter-udp=50000-65535', '--dpi-desync=fake,any_invoke', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new',
    '--filter-tcp=80', '--hostlist={discordList}', '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--new',
    '--filter-tcp=443', '--hostlist={discordList}', '--dpi-desync=fake,split', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-fake-tls={tlsBin}'
  ],
  // 5: Fallback basic
  [
    '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
    '--filter-tcp=443', '--hostlist={discordList}', '--dpi-desync=fake', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig'
  ]
]

export class ZapretManager {
  private process: ChildProcess | null = null
  private binPath: string
  private binDir: string

  constructor() {
    const platform = os.platform()
    this.binDir = getBinDir('win')
    if (platform === 'win32') {
      this.binPath = path.join(this.binDir, 'zapret', 'bin', 'winws.exe')
    } else {
      this.binPath = ''
    }
  }

  private getInterpolatedArgs(strategyArgs: string[]): string[] {
    const tlsBin = path.join(this.binDir, 'zapret', 'bin', 'tls_clienthello_www_google_com.bin')
    const discordList = path.join(this.binDir, 'zapret', 'lists', 'discord.txt')

    return strategyArgs.map(arg => 
      arg.replace('{tlsBin}', tlsBin).replace('{discordList}', discordList)
    )
  }

  async testConnection(url: string, timeoutMs: number = 2500): Promise<boolean> {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, { signal: controller.signal, method: 'HEAD' });
      clearTimeout(id);
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  async findWorkingStrategy(onProgress: (msg: string, percent: number) => void): Promise<number> {
    if (!this.binPath) throw new Error('Zapret is only supported on Windows')
    
    // We try to fetch i.ytimg.com (YouTube thumbnail server which is commonly DPI blocked)
    const testUrl = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'

    onProgress('Подготовка к тесту...', 0)
    
    for (let i = 0; i < ZAPRET_STRATEGIES.length; i++) {
      onProgress(`Тестируем стратегию ${i + 1} из ${ZAPRET_STRATEGIES.length}...`, Math.round((i / ZAPRET_STRATEGIES.length) * 100))
      
      await this.stop() // ensure stopped
      
      const args = this.getInterpolatedArgs(ZAPRET_STRATEGIES[i])
      
      // Spawn winws for testing
      this.process = spawn(this.binPath, args, { windowsHide: true, cwd: this.appRoot })
      
      // Wait a moment for WinDivert to initialize
      await new Promise(r => setTimeout(r, 1000))
      
      const isWorking = await this.testConnection(testUrl)
      
      if (isWorking) {
        onProgress(`Стратегия ${i + 1} успешно прошла тест!`, 100)
        return i; // Return index of working strategy
      }
    }
    
    await this.stop()
    throw new Error('Ни одна из встроенных стратегий не сработала.')
  }

  async startDiscordYoutube(strategyIndex: number = 0) {
    if (!this.binPath) throw new Error('Zapret is only supported on Windows')
    await this.stop()
    
    const safeIndex = (strategyIndex >= 0 && strategyIndex < ZAPRET_STRATEGIES.length) ? strategyIndex : 0;
    const args = this.getInterpolatedArgs(ZAPRET_STRATEGIES[safeIndex]);

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
      // Small delay to ensure port/WinDivert handles are released
      await new Promise(r => setTimeout(r, 500))
    }
  }
}
