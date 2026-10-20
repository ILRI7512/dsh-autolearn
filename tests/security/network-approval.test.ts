import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEngine } from '../helpers.ts'
import { ApprovalService } from '../../src/security/approval.ts'
import { isPublicAddress, resolveTarget, domainAllowed } from '../../src/security/network.ts'

describe('审批令牌：作用域、单次、失败关闭', () => {
  it('未批准的令牌不能消费', () => {
    const { engine, close } = makeEngine()
    try {
      const token = engine.permissions.requestConfirmation('delete_chunk', 'chunk_x', 'prj_1')
      assert.equal(engine.approval.consume(token, 'delete_chunk', 'chunk_x'), false)
      const decision = engine.permissions.decide('delete_chunk', 'destructive', 'chunk_x', {
        projectId: 'prj_1', confirmedToken: token,
      })
      assert.equal(decision.allowed, false)
      assert.equal(decision.needs_confirmation, true)
    } finally {
      close()
    }
  })

  it('用户批准后只能消费一次；重放被拒绝', () => {
    const { engine, close } = makeEngine()
    try {
      const token = engine.permissions.requestConfirmation('delete_chunk', 'chunk_x')
      assert.throws(() => engine.approval.approve(token, 'agent'), /用户侧/)
      assert.throws(() => engine.approval.approve(token, 'model'), /用户侧/)
      assert.equal(engine.approval.approve(token, 'user'), true)
      const first = engine.permissions.decide('delete_chunk', 'destructive', 'chunk_x', { confirmedToken: token })
      assert.equal(first.allowed, true)
      const replay = engine.permissions.decide('delete_chunk', 'destructive', 'chunk_x', { confirmedToken: token })
      assert.equal(replay.allowed, false)
    } finally {
      close()
    }
  })

  it('令牌作用域不匹配时拒绝', () => {
    const { engine, close } = makeEngine()
    try {
      const token = engine.permissions.requestConfirmation('delete_chunk', 'chunk_x')
      engine.approval.approve(token, 'user')
      const wrong = engine.permissions.decide('restore_knowledge_base', 'destructive', 'chunk_x', { confirmedToken: token })
      assert.equal(wrong.allowed, false)
      const wrongTarget = engine.permissions.decide('delete_chunk', 'destructive', 'chunk_y', { confirmedToken: token })
      assert.equal(wrongTarget.allowed, false)
    } finally {
      close()
    }
  })

  it('过期令牌不可批准/消费', () => {
    const { engine, close } = makeEngine()
    try {
      const service = new ApprovalService(engine.db, { ttlSeconds: -1 })
      const { token } = service.request('delete_chunk', 'chunk_x')
      assert.equal(service.approve(token, 'user'), false)
      assert.equal(service.consume(token, 'delete_chunk', 'chunk_x'), false)
    } finally {
      close()
    }
  })
})

describe('权限矩阵', () => {
  it('读取授权根之外的路径被硬拒绝（确认令牌也不放行）', () => {
    const { engine, close } = makeEngine()
    try {
      const decision = engine.permissions.decide('read_source', 'read', '/etc/passwd')
      assert.equal(decision.allowed, false)
      assert.match(decision.reason, /授权根目录|允许范围/)
    } finally {
      close()
    }
  })

  it('写入路径越界被拒绝', () => {
    const { engine, close } = makeEngine()
    try {
      const decision = engine.permissions.decide('export_knowledge', 'write', '/tmp/../etc/evil.json')
      assert.equal(decision.allowed, false)
    } finally {
      close()
    }
  })

  it('未开启 allow_network 时外部访问被拒绝', () => {
    const { engine, close } = makeEngine()
    try {
      const decision = engine.permissions.decide('fetch_url', 'external', 'https://example.com')
      assert.equal(decision.allowed, false)
      assert.match(decision.reason, /allow_network/)
    } finally {
      close()
    }
  })

  it('非 lab 模式禁止执行代码；lab 需要宿主审批或本地流程', () => {
    const { engine, close } = makeEngine()
    try {
      assert.equal(engine.permissions.decide('run_code_test', 'execute').allowed, false)
      engine.permissions.setMode('lab')
      assert.equal(engine.permissions.decide('run_code_test', 'execute').allowed, true)
    } finally {
      close()
    }
  })

  it('内容含密钥时拒绝写入（任意模式）', () => {
    const { engine, close } = makeEngine()
    try {
      engine.permissions.setMode('lab')
      const decision = engine.permissions.decide('save_knowledge', 'write', 'pending_knowledge', {
        content: 'token = ghp_abcdefghijklmnopqrstuvwxyz012345',
      })
      assert.equal(decision.allowed, false)
      assert.match(decision.reason, /密钥|令牌/)
    } finally {
      close()
    }
  })

  it('宿主审批生效时高风险动作放行；不生效时必须确认', () => {
    const local = makeEngine()
    const hosted = makeEngine({ hostApproval: true })
    try {
      assert.equal(local.engine.permissions.decide('delete_chunk', 'destructive', 'chunk_x').needs_confirmation, true)
      assert.equal(hosted.engine.permissions.decide('delete_chunk', 'destructive', 'chunk_x').allowed, true)
    } finally {
      local.close()
      hosted.close()
    }
  })
})

describe('SSRF 防护', () => {
  it('私有/环回/链路本地/元数据地址都判定为非公网', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) {
      assert.equal(isPublicAddress(address), false, address)
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      assert.equal(isPublicAddress(address), true, address)
    }
  })

  const policy = {
    allowNetwork: true, allowedDomains: [], allowPrivateNetworks: false,
    maxRedirects: 5, maxBytes: 1024 * 1024, allowedContentTypes: ['text/'], timeoutMs: 1000,
  }

  it('拒绝非 http(s)、私有地址、元数据地址与非常规端口', async () => {
    await assert.rejects(() => resolveTarget('file:///etc/passwd', policy), /http\/https/)
    await assert.rejects(() => resolveTarget('http://127.0.0.1:6379/', policy), /端口|内网|私有|保留/)
    await assert.rejects(() => resolveTarget('http://169.254.169.254/latest/meta-data/', policy), /内网|私有|保留/)
    await assert.rejects(() => resolveTarget('http://[::1]/', policy), /内网|私有|保留/)
    await assert.rejects(() => resolveTarget('http://example.com:22/', policy), /端口/)
  })

  it('域名白名单与子域后缀匹配', () => {
    assert.equal(domainAllowed('docs.example.com', ['example.com']), true)
    assert.equal(domainAllowed('evil-example.com', ['example.com']), false)
    assert.equal(domainAllowed('anything.org', []), true)
  })

  it('allow_private_networks 可显式放开（默认关闭）', async () => {
    const relaxed = { ...policy, allowPrivateNetworks: true }
    const target = await resolveTarget('http://127.0.0.1:8080/', relaxed)
    assert.equal(target.address, '127.0.0.1')
  })

  it('allow_network=false 时直接拒绝', async () => {
    await assert.rejects(
      () => resolveTarget('https://example.com/', { ...policy, allowNetwork: false }),
      /allow_network/,
    )
  })
})

describe('路径穿越与符号链接逃逸', () => {
  it('拒绝 ../ 与绝对路径越界', () => {
    const { engine, close } = makeEngine()
    try {
      assert.throws(() => engine.pathPolicy.assertReadable('../etc/passwd'), /授权根目录/)
      assert.throws(() => engine.pathPolicy.assertWritable('/etc/evil'), /允许范围/)
      assert.ok(engine.pathPolicy.assertWritable(join(engine.config.paths.data_dir, 'ok.txt')))
    } finally {
      close()
    }
  })

  it('符号链接指向外部目录时被拒绝（realpath 解析）', () => {
    const { engine, dir, close } = makeEngine()
    try {
      const link = join(engine.config.paths.data_dir, 'escape')
      symlinkSync('/etc', link)
      assert.throws(() => engine.pathPolicy.assertReadable(join(link, 'passwd')), /授权根目录/)
      assert.equal(engine.pathPolicy.isAllowed(join(link, 'passwd')), false)
      void dir
    } finally {
      close()
    }
  })

  it('不存在的目标按最近存在祖先判定，不能借不存在路径逃逸', () => {
    const { engine, close } = makeEngine()
    try {
      const target = join(engine.config.paths.data_dir, '..', '..', '..', 'etc', 'passwd')
      assert.throws(() => engine.pathPolicy.assertReadable(target), /授权根目录/)
    } finally {
      close()
    }
  })

  it('source_manage 读取越界路径返回明确错误而不是内容', async () => {
    const { engine, close } = makeEngine()
    try {
      const result = await engine.services.sourceManage({ action: 'read', locations: ['/etc/passwd'] })
      const first = (result.results as Array<Record<string, unknown>>)[0]
      assert.equal(first?.ok, false)
      assert.match(String(first?.error), /授权根目录|允许范围/)
    } finally {
      close()
    }
  })
})

describe('网络抓取的真实请求路径', () => {
  it('私有地址在 DNS 解析后仍被拦截（检查与实际连接绑定）', async () => {
    const { engine, close } = makeEngine({
      overrides: { security: { allow_network: true } },
    })
    try {
      const read = await engine.reader.read('http://127.0.0.1:8080/secret')
      assert.equal(read.ok, false)
      assert.match(read.error, /内网|私有|保留/)
    } finally {
      close()
    }
  })

  it('付费墙站点不抓取（不绕过访问控制）', async () => {
    const { engine, close } = makeEngine({ overrides: { security: { allow_network: true } } })
    try {
      const read = await engine.reader.read('https://www.linkedin.com/feed/')
      assert.equal(read.ok, false)
      assert.match(read.error, /登录|付费墙/)
    } finally {
      close()
    }
  })
})
