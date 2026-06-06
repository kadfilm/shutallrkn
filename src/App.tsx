import { useState, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPowerOff, faSync, faServer, faNetworkWired } from '@fortawesome/free-solid-svg-icons'
import { faYoutube, faDiscord, faTelegram } from '@fortawesome/free-brands-svg-icons'
import './index.css'

interface ServerNode {
  id: string;
  name: string;
  protocol: string;
  address: string;
  port: number;
  rawConfig?: any;
}

function App() {
  const [inputValue, setInputValue] = useState('')
  const [subUrl, setSubUrl] = useState('')
  const [servers, setServers] = useState<ServerNode[]>([])
  const [activeServerId, setActiveServerId] = useState<string | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tunStatus, setTunStatus] = useState<{status: string, message: string}>({status: 'off', message: ''})

  // Module states (Placeholders for Stage 2)
  const [bypassYoutube, setBypassYoutube] = useState(false)
  const [bypassDiscord, setBypassDiscord] = useState(false)
  const [bypassTelegram, setBypassTelegram] = useState(false)
  const [autoStart, setAutoStart] = useState(false)
  
  const [zapretStrategyIndex, setZapretStrategyIndex] = useState(0)
  const [isTestingStrategies, setIsTestingStrategies] = useState(false)
  const [testProgress, setTestProgress] = useState({ msg: '', percent: 0 })

  const handleZapretToggle = async (type: 'youtube' | 'discord', currentState: boolean) => {
    const newState = !currentState;
    if (type === 'youtube') setBypassYoutube(newState);
    if (type === 'discord') setBypassDiscord(newState);
    
    // If either Youtube OR Discord is active, we start Zapret
    const shouldRunZapret = (type === 'youtube' ? newState : bypassYoutube) || 
                            (type === 'discord' ? newState : bypassDiscord);
    
    // @ts-ignore
    await window.ipcRenderer.invoke('toggle-zapret', shouldRunZapret, zapretStrategyIndex);
  };

  const handleTgProxyToggle = async () => {
    const newState = !bypassTelegram;
    setBypassTelegram(newState);
    // @ts-ignore
    await window.ipcRenderer.invoke('toggle-tg-proxy', newState);
  };

  useEffect(() => {
    const savedUrl = localStorage.getItem('subUrl')
    const savedServers = localStorage.getItem('servers')
    const savedActiveId = localStorage.getItem('activeServerId')
    const savedAutoStart = localStorage.getItem('autoStart')
    const savedZapretStrategy = localStorage.getItem('zapretStrategyIndex')

    if (savedUrl) setSubUrl(savedUrl)
    if (savedServers) setServers(JSON.parse(savedServers))
    if (savedActiveId) setActiveServerId(savedActiveId)
    if (savedZapretStrategy) setZapretStrategyIndex(parseInt(savedZapretStrategy))
    
    if (savedAutoStart === 'true') {
      setAutoStart(true)
      // Restore OS setting on load just to be sure
      // @ts-ignore
      window.ipcRenderer.invoke('set-autostart', true).catch(console.error)
    }

    // @ts-ignore
    window.ipcRenderer.on('zapret-test-progress', (event, data) => {
      setTestProgress(data)
    })

    // @ts-ignore
    window.ipcRenderer.on('tun-status', (event, info) => {
      setTunStatus(info)
    })
  }, [])

  const startBlockcheck = async () => {
    setIsTestingStrategies(true)
    setTestProgress({ msg: 'Начинаем проверку...', percent: 0 })
    try {
      // @ts-ignore
      const res = await window.ipcRenderer.invoke('test-zapret-strategies')
      if (res.success) {
        setZapretStrategyIndex(res.workingIndex)
        localStorage.setItem('zapretStrategyIndex', res.workingIndex.toString())
        alert('Рабочий метод обхода успешно найден и сохранен!')
        // Restart Zapret if it was already running
        if (bypassYoutube || bypassDiscord) {
          // @ts-ignore
          await window.ipcRenderer.invoke('toggle-zapret', true, res.workingIndex)
        }
      } else {
        alert('Ошибка при подборе: ' + res.error)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setIsTestingStrategies(false)
      setTestProgress({ msg: '', percent: 0 })
    }
  }

  const toggleAutoStart = async () => {
    const newState = !autoStart
    setAutoStart(newState)
    localStorage.setItem('autoStart', String(newState))
    // @ts-ignore
    await window.ipcRenderer.invoke('set-autostart', newState)
  }

  const handleImport = async (urlToFetch?: string) => {
    const target = urlToFetch || inputValue;
    if (!target) return;
    
    setLoading(true)
    try {
      // @ts-ignore
      const nodes = await window.ipcRenderer.invoke('fetch-subscription', target)
      if (nodes.error) {
        alert('Ошибка: ' + nodes.error)
      } else {
        if (target.startsWith('vless://') || target.startsWith('vmess://')) {
          const newServers = [...servers, ...nodes];
          setServers(newServers)
          localStorage.setItem('servers', JSON.stringify(newServers))
          setInputValue('') 
        } else {
          setServers(nodes)
          setSubUrl(target)
          localStorage.setItem('subUrl', target)
          localStorage.setItem('servers', JSON.stringify(nodes))
        }
        if (nodes.length > 0 && !activeServerId) {
          setActiveServerId(nodes[0].id)
          localStorage.setItem('activeServerId', nodes[0].id)
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const toggleConnection = async () => {
    if (!activeServerId) {
      alert('Сначала выберите сервер')
      return
    }

    if (isConnected) {
      // @ts-ignore
      await window.ipcRenderer.invoke('disconnect-vpn')
      setIsConnected(false)
    } else {
      const node = servers.find(s => s.id === activeServerId)
      if (node) {
        // @ts-ignore
        const res = await window.ipcRenderer.invoke('connect-vpn', node)
        if (res.success) {
          setIsConnected(true)
        } else {
          alert('Ошибка подключения: ' + res.error)
        }
      }
    }
  }

  const activeServer = servers.find(s => s.id === activeServerId)

  return (
    <>
      <div className="titlebar">ShutAllRKN</div>
      <div className="app-container">
        
        {/* Sidebar */}
        <div className="sidebar">
          <h3><FontAwesomeIcon icon={faServer} style={{ marginRight: 8 }} /> Серверы (VPN)</h3>
          
          <div className="input-group" style={{ marginTop: '16px' }}>
            <input 
              type="text" 
              placeholder="vless://... или ссылка" 
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
            />
            <button className="btn-primary" onClick={() => handleImport()} disabled={loading} style={{ width: '100%' }}>
              Добавить
            </button>
          </div>

          {subUrl && (
            <div className="subscription-card">
              <div className="sub-info">
                <div className="sub-name">Текущая подписка</div>
                <div className="sub-url">{subUrl}</div>
              </div>
              <button className="icon-btn" onClick={() => handleImport(subUrl)} disabled={loading} title="Обновить подписку">
                <FontAwesomeIcon icon={faSync} />
              </button>
            </div>
          )}

          <div className="server-list">
            {servers.map(server => (
              <div 
                key={server.id} 
                className={`server-item ${activeServerId === server.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveServerId(server.id)
                  localStorage.setItem('activeServerId', server.id)
                }}
              >
                <div className="server-name">{server.name}</div>
                <div className="server-meta">{server.protocol.toUpperCase()} • {server.address}</div>
              </div>
            ))}
            {servers.length === 0 && <div className="helper-text">Нет серверов. Добавьте ссылку.</div>}
          </div>
          
          {/* Diagnostics Link (Placeholder) */}
          <button className="btn-secondary" style={{ marginTop: 16, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <FontAwesomeIcon icon={faNetworkWired} /> Диагностика сети
          </button>

          <div style={{ marginTop: 'auto', paddingTop: 16 }}>
            <div className="bypass-card" style={{ padding: '12px' }}>
              <div className="bypass-info" style={{ gap: 12 }}>
                <div className="bypass-text-wrapper">
                  <span className="bypass-title" style={{ fontSize: 13 }}>Автозапуск</span>
                  <span className="bypass-subtitle" style={{ fontSize: 10 }}>Запуск при старте системы</span>
                </div>
              </div>
              <div className={`toggle-switch ${autoStart ? 'active' : ''}`} style={{ transform: 'scale(0.8)', margin: 0 }} onClick={toggleAutoStart}></div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="main-content">
          <div 
            className={`connect-ring ${isConnected ? 'connected' : ''}`}
            onClick={toggleConnection}
          >
            <FontAwesomeIcon icon={faPowerOff} className="power-icon" style={{ width: 64, height: 64 }} />
          </div>

          <div className="status-text">
            {isConnected ? 'VPN Активен' : 'VPN Отключен'}
          </div>
          <div className="status-subtext">
            {activeServer ? activeServer.name : 'Выберите сервер слева'}
          </div>

          {isConnected && tunStatus.status !== 'off' && (
            <div style={{
              marginTop: 8,
              padding: '6px 14px',
              borderRadius: 8,
              fontSize: 11,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              backgroundColor: tunStatus.status === 'active' ? 'rgba(0, 200, 83, 0.15)'
                : tunStatus.status === 'starting' ? 'rgba(255, 193, 7, 0.15)'
                : tunStatus.status === 'error' ? 'rgba(244, 67, 54, 0.15)'
                : 'rgba(255, 255, 255, 0.08)',
              color: tunStatus.status === 'active' ? '#00c853'
                : tunStatus.status === 'starting' ? '#ffc107'
                : tunStatus.status === 'error' ? '#f44336'
                : 'var(--text-muted)',
              border: `1px solid ${tunStatus.status === 'active' ? 'rgba(0, 200, 83, 0.3)'
                : tunStatus.status === 'starting' ? 'rgba(255, 193, 7, 0.3)'
                : tunStatus.status === 'error' ? 'rgba(244, 67, 54, 0.3)'
                : 'var(--border-color)'}`,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                backgroundColor: 'currentColor',
                animation: tunStatus.status === 'starting' ? 'pulse 1s infinite' : 'none',
              }} />
              {tunStatus.message}
            </div>
          )}

          {/* Point-bypass Section */}
          <div className="bypass-section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                Точечный обход (без VPN)
              </div>
              <button 
                className="btn-secondary" 
                onClick={startBlockcheck} 
                disabled={isTestingStrategies}
                style={{ fontSize: 11, padding: '4px 8px', backgroundColor: 'transparent', border: '1px solid var(--accent-color)', color: 'var(--accent-color)' }}
              >
                {isTestingStrategies ? 'Тестирование...' : 'Подобрать обход'}
              </button>
            </div>

            {isTestingStrategies && (
              <div style={{ backgroundColor: 'var(--glass-bg)', padding: '12px', borderRadius: 8, marginBottom: 8, border: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                  <span>{testProgress.msg}</span>
                  <span>{testProgress.percent}%</span>
                </div>
                <div style={{ width: '100%', height: 4, backgroundColor: '#222', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${testProgress.percent}%`, height: '100%', backgroundColor: 'var(--accent-color)', transition: 'width 0.3s ease' }}></div>
                </div>
              </div>
            )}
            
            <div className={`bypass-card ${bypassYoutube ? 'active' : ''}`}>
              <div className="bypass-info">
                <FontAwesomeIcon icon={faYoutube} className="bypass-icon" />
                <div className="bypass-text-wrapper">
                  <span className="bypass-title">Разблокировка YouTube</span>
                  <span className="bypass-subtitle">Обход замедления (DPI)</span>
                </div>
              </div>
              <div className={`toggle-switch ${bypassYoutube ? 'active' : ''}`} onClick={() => handleZapretToggle('youtube', bypassYoutube)}></div>
            </div>

            <div className={`bypass-card ${bypassDiscord ? 'active' : ''}`}>
              <div className="bypass-info">
                <FontAwesomeIcon icon={faDiscord} className="bypass-icon" />
                <div className="bypass-text-wrapper">
                  <span className="bypass-title">Разблокировка Discord</span>
                  <span className="bypass-subtitle">Голос и чат (DPI)</span>
                </div>
              </div>
              <div className={`toggle-switch ${bypassDiscord ? 'active' : ''}`} onClick={() => handleZapretToggle('discord', bypassDiscord)}></div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className={`bypass-card ${bypassTelegram ? 'active' : ''}`}>
                <div className="bypass-info">
                  <FontAwesomeIcon icon={faTelegram} className="bypass-icon" />
                  <div className="bypass-text-wrapper">
                    <span className="bypass-title">Proxy Telegram</span>
                    <span className="bypass-subtitle">Локальный прокси</span>
                  </div>
                </div>
                <div className={`toggle-switch ${bypassTelegram ? 'active' : ''}`} onClick={handleTgProxyToggle}></div>
              </div>
              {bypassTelegram && (
                <div style={{ backgroundColor: 'var(--glass-bg)', padding: '12px 16px', borderRadius: 8, border: '1px solid var(--accent-color)' }}>
                  <div style={{ fontSize: 13, marginBottom: 12 }}>
                    <strong>Инструкция:</strong> Включите прокси выше, затем нажмите кнопку ниже. Telegram откроется сам и предложит применить настройки.
                  </div>
                  <a 
                    href="tg://socks?server=127.0.0.1&port=1080" 
                    className="btn-primary" 
                    style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
                  >
                    Применить в Telegram
                  </a>
                </div>
              )}
            </div>

          </div>
        </div>

      </div>
    </>
  )
}

export default App
