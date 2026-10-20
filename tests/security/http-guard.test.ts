import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import { makeEngine } from '../helpers.ts'
import { fetchText } from '../../src/security/network.ts'

/**
 * 策略只允许 80/443/8080/8443，测试必须使用白名单端口（不能用随机端口，
 * 否则测到的是端口拒绝而不是抓取逻辑）。本机 8080 已被占用，用 8443。
 */
function startServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number; count: () => number }> {
  return new Promise((resolve, reject) => {
    let requests = 0
    const server = createServer((req, res) => {
      requests += 1
      handler(req, res)
    })
    server.once('error', reject)
    server.listen(8443, '127.0.0.1', () => {
      resolve({ server, port: 8443, count: () => requests })
    })
  })
}

const basePolicy = {
  allowNetwork: true,
  allowedDomains: [],
  allowPrivateNetworks: true,
  maxRedirects: 2,
  maxBytes: 1024,
  allowedContentTypes: ['text/'],
  timeoutMs: 1500,
}

describe('HTTP 抓取的真实策略路径（本地服务器，不依赖外网）', () => {
  it('逐跳重定向后返回正文，并统计真实请求次数', async () => {
    const { server, port, count } = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/middle' })
        res.end()
      } else if (req.url === '/middle') {
        res.writeHead(302, { location: '/final' })
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('风险管理的正常内容')
      }
    })
    try {
      const result = await fetchText(`http://127.0.0.1:${port}/start`, basePolicy)
      assert.equal(result.ok, true)
      assert.equal(result.redirects, 2)
      assert.equal(result.body, '风险管理的正常内容')
      assert.equal(count(), 3)
    } finally {
      server.close()
    }
  })

  it('超过 maxRedirects 时拒绝，不会无限跟随', async () => {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' })
      res.end()
    })
    try {
      await assert.rejects(() => fetchText(`http://127.0.0.1:${port}/a`, { ...basePolicy, maxRedirects: 2 }), /重定向次数超过上限|重定向循环/)
    } finally {
      server.close()
    }
  })

  it('响应体超过上限时中止（流式读取也不会放大内存）', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('x'.repeat(800))
      res.write('y'.repeat(800))
      res.end()
    })
    try {
      await assert.rejects(() => fetchText(`http://127.0.0.1:${port}/big`, basePolicy), /超过上限/)
    } finally {
      server.close()
    }
  })

  it('content-type 不在白名单时拒绝（避免把二进制当文本入库）', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0, 1, 2, 3]))
    })
    try {
      await assert.rejects(() => fetchText(`http://127.0.0.1:${port}/bin`, basePolicy), /content-type/)
    } finally {
      server.close()
    }
  })

  it('请求超时生效（返回明确错误，不挂死）', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      // 故意不结束响应
    })
    try {
      await assert.rejects(
        () => fetchText(`http://127.0.0.1:${port}/slow`, { ...basePolicy, timeoutMs: 100 }),
        /超时/,
      )
    } finally {
      server.close()
    }
  })

  it('DNS 结果钉死：解析到 127.0.0.1 时，未放开私有网络会被拒绝', async () => {
    const { engine, close } = makeEngine({
      overrides: { security: { allow_network: true, allow_private_networks: false } },
    })
    try {
      const read = await engine.reader.read('http://127.0.0.1:8080/secret')
      assert.equal(read.ok, false)
      assert.match(read.error, /内网|私有|保留|端口/)
    } finally {
      close()
    }
  })
})
