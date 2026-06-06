import { useState, useEffect } from 'react'
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

  useEffect(() => {
    const savedUrl = localStorage.getItem('subUrl')
    const savedServers = localStorage.getItem('servers')
    const savedActiveId = localStorage.getItem('activeServerId')

    if (savedUrl) {
      setSubUrl(savedUrl)
    }
    if (savedServers) setServers(JSON.parse(savedServers))
    if (savedActiveId) setActiveServerId(savedActiveId)
  }, [])

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
          // Append single node
          const newServers = [...servers, ...nodes];
          setServers(newServers)
          localStorage.setItem('servers', JSON.stringify(newServers))
          setInputValue('') 
        } else {
          // Replace all nodes for subscription
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
      <div className="titlebar">Xray VPN</div>
      <div className="app-container">
        
        {/* Sidebar */}
        <div className="sidebar">
          <h3>Серверы</h3>
          
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
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none">
                  <path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
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
        </div>

        {/* Main Content */}
        <div className="main-content">
          <div 
            className={`connect-ring ${isConnected ? 'connected' : ''}`}
            onClick={toggleConnection}
          >
            <svg className="power-icon" viewBox="0 0 24 24">
              <path d="M12 2v10m-5.657-3.657a8 8 0 1 0 11.314 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </div>

          <div className="status-text">
            {isConnected ? 'Подключено' : 'Отключено'}
          </div>
          <div className="status-subtext">
            {activeServer ? activeServer.name : 'Выберите сервер'}
          </div>
        </div>

      </div>
    </>
  )
}

export default App
