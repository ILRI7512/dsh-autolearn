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
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { AutolearnError, ERROR_CODES } from '../core/errors.ts'

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443])
const USER_AGENT = 'DSH-Autonomous-Learning/2.0 (+local research agent)'

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
export function isPublicAddress(input: string): boolean {
  const address = input.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const version = isIP(address)
  if (version === 4) return isPublicIPv4(address)
  if (version === 6) {
    // IPv4-mapped: ::ffff:127.0.0.1
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped?.[1]) return isPublicIPv4(mapped[1])
    if (address === '::' || address === '::1') return false
    if (/^f[cd][0-9a-f]{2}:/.test(address)) return false // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(address)) return false // fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(address)) return false // ff00::/8
    if (address.startsWith('2001:db8:')) return false // documentation
    if (address.startsWith('64:ff9b::')) return false // NAT64 可映射私网
    return true
  }
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
        servername: isHttps && !isIP(target.hostname) ? target.hostname : undefined,
        lookup: (_hostname, _opts, callback) => {
          // 固定为已校验地址，防止 DNS rebinding 换到内网。
          callback(null, target.address, target.family as 4 | 6)
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let total = 0
        let finished = false
        const fail = (error: Error): void => {
          if (finished) return
          finished = true
          response.destroy()
          reject(error)
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
          if (finished) return
          finished = true
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            bytes: total,
          })
        })
        response.on('error', fail)
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(networkError(`请求超时（>${timeoutMs}ms）`))
    })
    req.on('error', (error) => {
      reject(error instanceof AutolearnError ? error : networkError(`请求失败: ${error.message}`))
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
