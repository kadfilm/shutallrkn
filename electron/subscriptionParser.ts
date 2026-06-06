export interface ServerNode {
  id: string;
  name: string;
  protocol: string;
  address: string;
  port: number;
  uuid: string;
  network?: string;
  security?: string;
  sni?: string;
  path?: string;
  host?: string;
  flow?: string;
  alpn?: string;
  fingerprint?: string;
  rawConfig?: any;
}

/**
 * Resolve a domain via Cloudflare DNS-over-HTTPS.
 * Bypasses ISP DNS poisoning that returns fake IPs like 198.18.x.x.
 */
async function resolveViaDoH(hostname: string): Promise<string | null> {
  try {
    const dohUrl = `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`;
    const resp = await fetch(dohUrl, {
      headers: { 'Accept': 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const answers = data.Answer?.filter((a: any) => a.type === 1); // A records
    if (answers && answers.length > 0) {
      // Skip poisoned IPs (198.18.x.x range)
      const realIp = answers.find((a: any) => !a.data.startsWith('198.18.'));
      return realIp?.data || answers[0].data;
    }
    return null;
  } catch (err) {
    console.error('[DoH] Resolution failed:', err);
    return null;
  }
}

export async function fetchSubscription(url: string): Promise<ServerNode[]> {
  try {
    // If the user pasted a direct vless:// or vmess:// link instead of a URL
    if (url.startsWith('vless://') || url.startsWith('vmess://')) {
      const nodes: ServerNode[] = [];
      const parsed = url.startsWith('vless://') ? parseVless(url) : parseVmess(url);
      if (parsed) nodes.push(parsed);
      return nodes;
    }

    // Try direct fetch first, fall back to DoH-resolved IP if blocked
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'happ',
          'X-HWID': '1234567890'
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch (directErr) {
      console.warn('[Sub] Direct fetch failed, trying via DoH bypass...', directErr);
      // ISP is likely DNS-poisoning the domain. Resolve real IP via Cloudflare DoH.
      const parsedUrl = new URL(url);
      const realIp = await resolveViaDoH(parsedUrl.hostname);
      if (!realIp) {
        throw new Error('Домен заблокирован и не удалось определить реальный IP через DoH');
      }
      console.log(`[Sub] DoH resolved ${parsedUrl.hostname} → ${realIp}`);
      // Fetch using IP with Host header
      const bypassUrl = url.replace(parsedUrl.hostname, realIp);
      response = await fetch(bypassUrl, {
        headers: {
          'User-Agent': 'happ',
          'X-HWID': '1234567890',
          'Host': parsedUrl.hostname,
        },
        // @ts-ignore — Node fetch supports this
        rejectUnauthorized: false,
        signal: AbortSignal.timeout(15000),
      });
    }

    if (!response.ok) {
      throw new Error(`Ошибка загрузки подписки: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    
    const nodes: ServerNode[] = [];

    // Check if it's a JSON array of configs (like Hiddify/GoVPN/easy-api)
    if (text.trim().startsWith('[')) {
      try {
        const configs = JSON.parse(text);
        if (Array.isArray(configs)) {
          for (const config of configs) {
            // Validate config format
            if (config.remarks && config.outbounds && config.outbounds.length > 0) {
              // Extract basic info for UI
              const outbound = config.outbounds[0];
              const protocol = outbound.protocol;
              let address = '';
              let port = 0;
              let uuid = '';
              
              if (outbound.settings?.vnext?.length > 0) {
                address = outbound.settings.vnext[0].address;
                port = outbound.settings.vnext[0].port;
                uuid = outbound.settings.vnext[0].users?.[0]?.id || '';
              } else if (outbound.settings?.servers?.length > 0) {
                address = outbound.settings.servers[0].address;
                port = outbound.settings.servers[0].port;
              }

              // Skip fake servers
              if (address === '0.0.0.0') continue;

              nodes.push({
                id: Math.random().toString(36).substring(7),
                name: config.remarks,
                protocol: protocol,
                address: address,
                port: port,
                uuid: uuid,
                rawConfig: config
              });
            }
          }
          return nodes;
        }
      } catch (err) {
        console.error('Failed to parse JSON subscription array', err);
      }
    }
    
    // Check if we got an HTML page instead of base64
    if (text.includes('<html') || text.includes('<!DOCTYPE html>')) {
      throw new Error('Received an HTML page instead of subscription data. The provider might be blocking this app.');
    }

    // Decode base64
    const decoded = Buffer.from(text.trim(), 'base64').toString('utf-8');
    const lines = decoded.split('\n').filter(l => l.trim() !== '');
    
    for (const line of lines) {
      try {
        if (line.startsWith('vless://')) {
          const parsed = parseVless(line.trim());
          if (parsed) nodes.push(parsed);
        } else if (line.startsWith('vmess://')) {
          const parsed = parseVmess(line.trim());
          if (parsed) nodes.push(parsed);
        }
      } catch (err) {
        console.error('Failed to parse node', line, err);
      }
    }
    
    return nodes;
  } catch (err) {
    console.error(err);
    throw err;
  }
}

function parseVless(link: string): ServerNode | null {
  // vless://uuid@host:port?params#name
  const match = link.match(/^vless:\/\/([^@]+)@([^:]+):(\d+)\??(.*)#(.*)$/);
  if (!match) return null;
  
  const [_, uuid, address, port, qs, name] = match;
  const params = new URLSearchParams(qs);
  
  return {
    id: Math.random().toString(36).substring(7),
    protocol: 'vless',
    uuid,
    address,
    port: parseInt(port, 10),
    name: decodeURIComponent(name),
    network: params.get('type') || 'tcp',
    security: params.get('security') || 'none',
    sni: params.get('sni') || '',
    path: decodeURIComponent(params.get('path') || ''),
    host: params.get('host') || '',
    flow: params.get('flow') || '',
    alpn: params.get('alpn') || '',
    fingerprint: params.get('fp') || '',
  };
}

function parseVmess(link: string): ServerNode | null {
  // vmess://base64
  const b64 = link.replace('vmess://', '');
  const decoded = Buffer.from(b64, 'base64').toString('utf-8');
  const config = JSON.parse(decoded);
  
  return {
    id: Math.random().toString(36).substring(7),
    protocol: 'vmess',
    name: config.ps || 'VMess Server',
    address: config.add,
    port: parseInt(config.port, 10),
    uuid: config.id,
    network: config.net || 'tcp',
    security: config.tls === 'tls' ? 'tls' : 'none',
    sni: config.sni || '',
    path: config.path || '',
    host: config.host || '',
  };
}

export function generateXrayConfig(node: ServerNode, localSocksPort = 10808, localHttpPort = 10809) {
  let outboundConf: any = {
    protocol: node.protocol,
    settings: {
      vnext: [
        {
          address: node.address,
          port: node.port,
          users: [
            {
              id: node.uuid,
              encryption: "none",
              flow: node.flow || undefined,
            }
          ]
        }
      ]
    },
    streamSettings: {
      network: node.network,
      security: node.security,
    }
  };

  // Setup stream settings
  if (node.security === 'tls' || node.security === 'reality') {
    outboundConf.streamSettings[node.security + 'Settings'] = {
      serverName: node.sni || node.host,
      fingerprint: node.fingerprint || 'chrome',
      alpn: node.alpn ? node.alpn.split(',') : undefined,
    }
  }

  if (node.network === 'ws') {
    outboundConf.streamSettings.wsSettings = {
      path: node.path,
      headers: {
        Host: node.host
      }
    }
  }

  return {
    log: {
      loglevel: "warning"
    },
    inbounds: [
      {
        port: localSocksPort,
        listen: "127.0.0.1",
        protocol: "socks",
        settings: {
          udp: true
        }
      },
      {
        port: localHttpPort,
        listen: "127.0.0.1",
        protocol: "http"
      }
    ],
    outbounds: [
      outboundConf,
      {
        protocol: "freedom",
        tag: "direct"
      },
      {
        protocol: "blackhole",
        tag: "block"
      }
    ],
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: [
        {
          type: "field",
          ip: ["geoip:private"],
          outboundTag: "direct"
        }
      ]
    }
  };
}
