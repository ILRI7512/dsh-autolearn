/**
 * 网络访问策略：SSRF 防护 + 域名白名单 + 体积/超时限制。
 *
 * 关键加固（相比旧实现的差异会在审计文档标注）：
 * 1. DNS 解析结果与**实际连接地址**绑定（自定义 lookup），消除 DNS rebinding
 *    在「检查后解析」与「真正连接」之间切换地址的窗口；
 * 2. 每一跳重定向都重新做目标校验（禁止 302 → 内网/云元数据）；
 * 3. 只接受 http/https，端口限定 80/443/8080/8443；
 * 4. 默认拒绝私有/环回/链路本地/保留地址，含云元数据 169.254.169.254。
 */
import { lookup as dnsLookup } from 'node:dns'
import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { AutolearnError, ERROR_CODES } from '../core/errors.ts'

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443])
const USER_AGENT = 'DSH-Autonomous-Learning/2.0 (+local research agent)'

/**
 * 不复用连接：抓取是低频操作，keep-alive 只会带来“服务器关闭后复用死 socket”
 * 的偶发 socket hang up（vNext 审计 D-05 的实际表现）。
 */
const HTTP_AGENT = new HttpAgent({ keepAlive: false })
const HTTPS_AGENT = new HttpsAgent({ keepAlive: false })

export interface NetworkPolicyOptions {
  allowNetwork: boolean
  allowedDomains: readonly string[]
  allowPrivateNetworks: boolean
  maxRedirects: number
  maxBytes: number
  allowedContentTypes: readonly string[]
  timeoutMs?: number
}

export interface ResolvedTarget {
  url: URL
  hostname: string
  port: number
  address: string
  family: 4 | 6 | 0
}

export interface FetchTextResult {
  ok: boolean
  status: number
  headers: IncomingHttpHeaders
  contentType: string
  body: string
  finalUrl: string
  redirects: number
  bytes: number
  notModified: boolean
}

function networkError(message: string, details: Record<string, unknown> = {}): AutolearnError {
  return new AutolearnError(message, { code: ERROR_CODES.NETWORK_DENIED, details })
}

/** 判断 IP 是否公网可访问（IPv4 + IPv6，含 IPv4-mapped 解映射）。 */
/** 把 IPv6 文本展开成 8 个 16 位分组；非法返回 null。支持 :: 与 IPv4 尾部。 */
function parseIPv6(input: string): number[] | null {
  let address = input.trim().toLowerCase()
  const zone = address.indexOf('%')
  if (zone >= 0) address = address.slice(0, zone)

  const parseGroups = (part: string): number[] | null => {
    if (!part) return []
    const out: number[] = []
    for (const item of part.split(':')) {
      if (item.includes('.')) {
        if (isIP(item) !== 4) return null
        const octets = item.split('.').map((value) => Number.parseInt(value, 10))
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null
        out.push(((octets[0] as number) << 8) | (octets[1] as number))
        out.push(((octets[2] as number) << 8) | (octets[3] as number))
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null
      out.push(Number.parseInt(item, 16))
    }
    return out
  }

  const doubleColon = address.indexOf('::')
  if (doubleColon >= 0) {
    if (address.indexOf('::', doubleColon + 1) >= 0) return null
    const left = parseGroups(address.slice(0, doubleColon))
    const right = parseGroups(address.slice(doubleColon + 2))
    if (!left || !right) return null
    if (left.length + right.length > 8) return null
    return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
  }
  const groups = parseGroups(address)
  return groups && groups.length === 8 ? groups : null
}

function ipv4FromGroups(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

function isPublicIPv6(address: string): boolean {
  const groups = parseIPv6(address)
  if (!groups) return false
  const g = groups
  const isZero = g.every((value) => value === 0)
  if (isZero) return false
  if (g.slice(0, 7).every((value) => value === 0) && g[7] === 1) return false // ::1 任意写法
  if (((g[0] as number) & 0xfe00) === 0xfc00) return false // fc00::/7 ULA
  if (((g[0] as number) & 0xffc0) === 0xfe80) return false // fe80::/10 link-local
  if (((g[0] as number) & 0xffc0) === 0xfec0) return false // fec0::/10 site-local（已废弃）
  if (((g[0] as number) & 0xff00) === 0xff00) return false // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false // 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return false // 2001::/32 Teredo（可隧道私网）
  if (g[0] === 0x2002) return isPublicIPv4(ipv4FromGroups(g[1] as number, g[2] as number)) // 6to4
  // IPv4-mapped ::ffff:0:0/96（十进制与十六进制写法）
  if (g.slice(0, 5).every((value) => value === 0) && g[5] === 0xffff) {
    return isPublicIPv4(ipv4FromGroups(g[6] as number, g[7] as number))
  }
  // IPv4-compatible ::/96（已废弃，但对 SSRF 仍有效）
  if (g.slice(0, 6).every((value) => value === 0)) {
    return isPublicIPv4(ipv4FromGroups(g[6] as number, g[7] as number))
  }
  // NAT64 64:ff9b::/96
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((value) => value === 0)) {
    return isPublicIPv4(ipv4FromGroups(g[6] as number, g[7] as number))
  }
  return true
}

export function isPublicAddress(input: string): boolean {
  const address = input.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const version = isIP(address)
  if (version === 4) return isPublicIPv4(address)
  if (version === 6) return isPublicIPv6(address)
  return false
}

function isPublicIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local + 云元数据
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51) return false
  if (a === 203 && b === 0) return false
  if (a >= 224) return false // multicast + reserved + broadcast
  return true
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
}

export function domainAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return true
  const host = normalizeHost(hostname)
  return allowedDomains.some((entry) => {
    const domain = normalizeHost(entry.trim())
    if (!domain) return false
    return host === domain || host.endsWith(`.${domain}`)
  })
}

function resolveAll(hostname: string, port: number): Promise<Array<{ address: string; family: 4 | 6 }>> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(networkError(`DNS 解析失败: ${hostname}（${error.message}）`, { hostname }))
        return
      }
      const list = (addresses as Array<{ address: string; family: number }>).map((item) => ({
        address: item.address,
        family: (item.family === 6 ? 6 : 4) as 4 | 6,
      }))
      if (list.length === 0) reject(networkError(`DNS 未返回地址: ${hostname}`, { hostname, port }))
      else resolve(list)
    })
  })
}

/** 校验目标并返回**将要连接的具体地址**（后续请求必须使用该地址）。 */
export async function resolveTarget(rawUrl: string, options: NetworkPolicyOptions): Promise<ResolvedTarget> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw networkError(`地址非法: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw networkError(`只允许 http/https，收到 ${url.protocol}`)
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) throw networkError('目标地址缺少主机名')
  const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80
  if (!ALLOWED_PORTS.has(port)) {
    throw networkError(`端口 ${port} 不在允许范围（80/443/8080/8443）`, { port })
  }
  if (!options.allowNetwork) {
    throw networkError('未开启 security.allow_network，外部网络访问被拒绝')
  }
  if (!domainAllowed(hostname, options.allowedDomains)) {
    throw networkError(`域名 ${hostname} 不在 allowed_domains 白名单内`, { hostname })
  }
  if (options.allowPrivateNetworks) {
    const literal = isIP(hostname) ? [{ address: hostname, family: (isIP(hostname) as 4 | 6) }] : await resolveAll(hostname, port)
    return { url, hostname, port, address: literal[0]?.address ?? hostname, family: literal[0]?.family ?? 0 }
  }
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }] : await resolveAll(hostname, port)
  const blocked = addresses.filter((item) => !isPublicAddress(item.address))
  if (blocked.length > 0) {
    throw networkError(
      `拒绝抓取内网/私有/保留地址：${hostname} → ${blocked.map((item) => item.address).join(', ')}`,
      { hostname, blocked: blocked.map((item) => item.address) },
    )
  }
  const chosen = addresses[0] as { address: string; family: 4 | 6 }
  return { url, hostname, port, address: chosen.address, family: chosen.family }
}

function pickContentType(headers: IncomingHttpHeaders): string {
  const value = headers['content-type']
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function contentTypeAllowed(contentType: string, allowed: readonly string[]): boolean {
  if (!contentType) return true
  return allowed.some((prefix) => contentType.toLowerCase().startsWith(prefix.toLowerCase()))
}

/** 单跳请求：DNS 结果被钉死为 lookup，连接地址与校验地址一致。 */
function requestOnce(
  target: ResolvedTarget,
  options: NetworkPolicyOptions,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer; bytes: number }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let deadline: NodeJS.Timeout | null = null
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      action()
    }

    const isHttps = target.url.protocol === 'https:'
    const request = isHttps ? httpsRequest : httpRequest
    const req = request(
      {
        protocol: target.url.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
          ...headers,
        },
        agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
        servername: isHttps && !isIP(target.hostname) ? target.hostname : undefined,
        lookup: (_hostname, _opts, callback) => {
          // 固定为已校验地址，防止 DNS rebinding 换到内网。
          callback(null, target.address, target.family as 4 | 6)
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let total = 0
        const fail = (error: Error): void => {
          finish(() => {
            response.destroy()
            reject(error)
          })
        }
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > options.maxBytes) {
            fail(networkError(`响应体超过上限 ${options.maxBytes} 字节（已读 ${total}）`, { maxBytes: options.maxBytes }))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          finish(() => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
              bytes: total,
            })
          })
        })
        response.on('error', fail)
      },
    )

    const timeoutError = (): AutolearnError => networkError(`请求超时（>${timeoutMs}ms）`)
    // req.setTimeout 只覆盖 socket 空闲；再加一个总 deadline，
    // 保证“响应头已到但 body 永远不结束”的情况也会超时。
    deadline = setTimeout(() => {
      finish(() => {
        req.destroy()
        reject(timeoutError())
      })
    }, timeoutMs)
    if (typeof deadline.unref === 'function') deadline.unref()
    req.setTimeout(timeoutMs, () => {
      finish(() => {
        req.destroy()
        reject(timeoutError())
      })
    })
    req.on('error', (error) => {
      finish(() => reject(error instanceof AutolearnError ? error : networkError(`请求失败: ${error.message}`)))
    })
    req.end()
  })
}

/** 带策略的文本抓取：逐跳校验 + 大小/超时/内容类型限制。 */
export async function fetchText(
  rawUrl: string,
  options: NetworkPolicyOptions,
  extraHeaders: Record<string, string> = {},
): Promise<FetchTextResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  let current = rawUrl
  let redirects = 0
  const visited = new Set<string>()
  for (;;) {
    if (visited.has(current)) throw networkError('检测到重定向循环', { url: current })
    visited.add(current)
    const target = await resolveTarget(current, options)
    const response = await requestOnce(target, options, extraHeaders, timeoutMs)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location
      if (typeof location !== 'string' || !location) {
        throw networkError(`重定向缺少 Location（HTTP ${response.status}）`)
      }
      if (redirects >= options.maxRedirects) {
        throw networkError(`重定向次数超过上限 ${options.maxRedirects}`)
      }
      redirects += 1
      current = new URL(location, target.url).toString()
      continue
    }
    if (response.status === 304) {
      return {
        ok: false, status: 304, headers: response.headers, contentType: '',
        body: '', finalUrl: target.url.toString(), redirects, bytes: 0, notModified: true,
      }
    }
    if (response.status >= 400) {
      throw networkError(`HTTP ${response.status}`, {
        status: response.status, url: target.url.toString(),
      })
    }
    const contentType = pickContentType(response.headers)
    if (!contentTypeAllowed(contentType, options.allowedContentTypes)) {
      throw networkError(`content-type 不在允许范围: ${contentType}`, { contentType })
    }
    const charsetMatch = /charset=([^\s;]+)/i.exec(contentType)
    const charset = charsetMatch?.[1]?.replace(/["']/g, '') ?? 'utf-8'
    let body: string
    try {
      body = new TextDecoder(charset).decode(response.body)
    } catch {
      body = new TextDecoder('utf-8').decode(response.body)
    }
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      contentType,
      body,
      finalUrl: target.url.toString(),
      redirects,
      bytes: response.bytes,
      notModified: false,
    }
  }
}

/** 仅供策略自检/诊断展示，不发起请求。 */
export function describeNetworkPolicy(options: NetworkPolicyOptions): Record<string, unknown> {
  return {
    allow_network: options.allowNetwork,
    allowed_domains: options.allowedDomains,
    allow_private_networks: options.allowPrivateNetworks,
    max_redirects: options.maxRedirects,
    max_bytes: options.maxBytes,
    allowed_content_types: options.allowedContentTypes,
    blocked: ['private', 'loopback', 'link-local', 'metadata', 'multicast', 'reserved'],
  }
}
