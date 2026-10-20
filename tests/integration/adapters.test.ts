import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeEngine } from '../helpers.ts'
import { buildNativeTools, needsApproval, approvalReason, truncateValue } from '../../src/adapters/dsh/tools.ts'
import { apply as applyPlugin, resolveEngineHome } from '../../src/adapters/dsh/plugin.ts'
import { McpServer } from '../../src/adapters/mcp/server.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

describe('DSH 原生工具', () => {
  it('11 个工具都有 JSON Schema 与渲染器', () => {
    const { engine, close } = makeEngine()
    try {
      const tools = buildNativeTools({ services: engine.services, maxOutputBytes: 65536 })
      assert.equal(tools.length, 11)
      for (const tool of tools) {
        assert.equal(typeof tool.name, 'string')
        assert.equal(tool.parameters.type, 'object')
        assert.equal(typeof tool.output.render, 'function')
      }
    } finally {
      close()
    }
  })

  it('正常调用返回真实数据；非法参数返回结构化错误', async () => {
    const { engine, close } = makeEngine()
    try {
      const tools = buildNativeTools({ services: engine.services, maxOutputBytes: 65536 })
      const create = tools.find((tool) => tool.name === 'learning_create')
      assert.ok(create)
      const result = await create.execute({ goal: '学习外汇风险管理', domain: 'quant' })
      assert.equal((result as Record<string, unknown>).project !== undefined, true)
      const invalid = await create.execute({ goal: '' })
      assert.equal((invalid as { ok: boolean }).ok, false)
      assert.match(JSON.stringify(invalid), /VALIDATION_FAILED|参数校验失败/)
      const search = tools.find((tool) => tool.name === 'knowledge_search')
      assert.ok(search)
      const missing = await search.execute({ query: '' })
      assert.equal((missing as { ok: boolean }).ok, false)
    } finally {
      close()
    }
  })

  it('危险工具与危险 action 都需要宿主审批', () => {
    assert.equal(needsApproval('system_maintenance', { action: 'backup' }), true)
    assert.equal(needsApproval('knowledge_manage', { action: 'invalidate' }), true)
    assert.equal(needsApproval('knowledge_manage', { action: 'rollback' }), true)
    assert.equal(needsApproval('knowledge_manage', { action: 'save' }), false)
    assert.equal(needsApproval('knowledge_search', {}), false)
    assert.match(approvalReason('system_maintenance', { action: 'restore' }), /高风险操作/)
  })

  it('输出按预算截断，不把整库塞回上下文', () => {
    const big = { content: 'x'.repeat(200_000) }
    const result = truncateValue(big, 1000) as { content: string }
    assert.ok(result.content.length < 2000)
    assert.ok(result.content.includes('[truncated]'))
  })

  it('插件注册工具、审批失败关闭、卸载释放资源', async () => {
    const { dir, engine, close } = makeEngine()
    engine.close()
    const previousHome = process.env.DSH_AL_HOME
    process.env.DSH_AL_HOME = dir
    try {
      const registered: string[] = []
      let hook: ((...args: unknown[]) => unknown) | undefined
      let cleanup: (() => void) | undefined
      const ctx = {
        tools: {
          register: (tool: unknown) => {
            registered.push((tool as { name: string }).name)
            return () => {}
          },
        },
        on: (_event: string, listener: (...args: unknown[]) => unknown) => {
          hook = listener
          return () => {}
        },
        effect: (callback: () => (() => void) | void) => {
          const dispose = callback()
          if (typeof dispose === 'function') cleanup = dispose
          return dispose
        },
      }
      applyPlugin(ctx, { home: dir })
      assert.equal(registered.length, 11)
      assert.ok(hook)
      const ask = hook?.({ name: 'system_maintenance', args: { action: 'backup' } }, () => 'next') as { kind: string; reason: string }
      assert.equal(ask.kind, 'ask')
      assert.equal(typeof ask.reason, 'string')
      assert.match(String((ask as Record<string, unknown>).reason), /高风险操作/)
      const pass = hook?.({ name: 'knowledge_search', args: {} }, () => 'next')
      assert.equal(pass, 'next')
      assert.equal(typeof cleanup, 'function')
      cleanup?.()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_AL_HOME
      else process.env.DSH_AL_HOME = previousHome
      close()
    }
  })

  it('引擎目录解析兼容旧布局（dsh_autonomous_learning）', () => {
    const previous = process.env.DSH_AL_HOME
    delete process.env.DSH_AL_HOME
    try {
      const home = resolveEngineHome({}, { ...process.env, DSH_AL_HOME: '' } as NodeJS.ProcessEnv)
      assert.equal(typeof home, 'string')
      assert.ok(home.length > 0)
    } finally {
      if (previous !== undefined) process.env.DSH_AL_HOME = previous
    }
  })
})

describe('MCP 兼容适配器（同一引擎）', () => {
  it('initialize / tools/list / tools/call 协议正确', async () => {
    const { engine, close } = makeEngine()
    try {
      const server = new McpServer(engine)
      const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })
      assert.equal((init?.result as Record<string, unknown>).protocolVersion, '2024-11-05')
      const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      const tools = (list?.result as { tools: unknown[] }).tools
      assert.equal(tools.length, 11)
      assert.ok((tools[0] as Record<string, unknown>).inputSchema)
      const call = await server.handle({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'learning_create', arguments: { goal: 'MCP 测试项目', plan: false } },
      })
      const result = call?.result as { content: Array<{ text: string }>; isError: boolean }
      assert.equal(result.isError, false)
      assert.ok(result.content[0]?.text.includes('prj_'))
      const unknown = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } })
      assert.equal((unknown?.result as { isError: boolean }).isError, true)
      const badMethod = await server.handle({ jsonrpc: '2.0', id: 5, method: 'not/a/method' })
      assert.equal(badMethod?.error?.code, -32601)
    } finally {
      close()
    }
  })

  it('stdio 进程真实可启动并响应（跨进程协议验证）', async () => {
    const { dir, engine, close } = makeEngine()
    engine.close()
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'adapters', 'mcp', 'server.ts')], {
      env: {
        ...process.env,
        DSH_AL_HOME: dir,
        DSH_AL_DATA_DIR: join(dir, 'data'),
        DSH_AL_CONFIG: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const lines: string[] = []
      child.stdout.on('data', (chunk: Buffer) => {
        lines.push(...chunk.toString('utf8').split('\n').filter(Boolean))
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
      const response = await waitFor(() => lines.length >= 2, 5000)
      assert.equal(response, true)
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.equal(parsed[0]?.id, 1)
      const tools = (parsed[1]?.result as { tools: unknown[] }).tools
      assert.equal(tools.length, 11)
      child.stdin.end()
    } finally {
      child.kill('SIGKILL')
      close()
    }
  })
})

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 25)
  })
}
