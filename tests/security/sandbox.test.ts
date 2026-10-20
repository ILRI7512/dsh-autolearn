import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { describe, it } from 'node:test'
import { makeEngine } from '../helpers.ts'
import { buildSandboxPlan, sandboxCapabilities, describeSandbox } from '../../src/security/sandbox.ts'

const caps = sandboxCapabilities()
const strict = caps.strictAvailable

const ESCAPE_PROBE = `
import fs from 'node:fs'
const out = {}
try { fs.readFileSync('/etc/passwd', 'utf8'); out.read = 'ALLOWED' } catch (error) { out.read = error.code }
try { fs.writeFileSync('/tmp/al-sandbox-escape.txt', 'x'); out.writeOutside = 'ALLOWED' } catch (error) { out.writeOutside = error.code }
try { fs.writeFileSync('./inside.txt', 'ok'); out.writeInside = 'ALLOWED' } catch (error) { out.writeInside = error.code }
try { const cp = await import('node:child_process'); cp.execSync('id'); out.spawn = 'ALLOWED' } catch (error) { out.spawn = error.code }
try {
  const net = await import('node:net')
  await new Promise((resolve, reject) => {
    const socket = net.connect(8443, '127.0.0.1')
    socket.on('connect', () => { out.net = 'ALLOWED'; socket.destroy(); resolve() })
    socket.on('error', reject)
  })
} catch (error) { out.net = error.code }
console.log(JSON.stringify(out))
`

describe('代码执行沙盒', { skip: !strict ? `strict 沙盒不可用：${caps.reasons.join('；')}` : false }, () => {
  it('strict 模式阻断文件系统/子进程/网络逃逸，但允许产物目录内写入', async () => {
    const { engine, close } = makeEngine()
    try {
      const result = await engine.runner.run(ESCAPE_PROBE)
      assert.equal(result.ok, true, result.stderr)
      assert.equal(result.sandbox.mode, 'strict')
      assert.equal(result.sandbox.network_isolated, true)
      assert.equal(result.sandbox.permission_model, true)
      const output = JSON.parse(result.stdout.trim()) as Record<string, string>
      assert.notEqual(output.read, 'ALLOWED', '读取 /etc/passwd 应被拒绝')
      assert.notEqual(output.writeOutside, 'ALLOWED', '写 /tmp 应被拒绝')
      assert.notEqual(output.spawn, 'ALLOWED', 'child_process 应被拒绝')
      assert.notEqual(output.net, 'ALLOWED', '网络应被拒绝')
      assert.equal(output.writeInside, 'ALLOWED', '产物目录内写入应允许')
      assert.equal(existsSync('/tmp/al-sandbox-escape.txt'), false)
    } finally {
      close()
    }
  })

  it('超时会强制结束整个进程组，不会遗留后台进程', async () => {
    const { engine, close } = makeEngine()
    try {
      const result = await engine.runner.run('while (true) {}', { timeoutSeconds: 1 })
      assert.equal(result.timed_out, true)
      assert.equal(result.status, 'timeout')
      assert.ok(result.duration_ms < 8000, `耗时异常: ${result.duration_ms}ms`)
    } finally {
      close()
    }
  })

  it('产物目录超过上限时判失败（软配额，执行后检查）', async () => {
    const { engine, close } = makeEngine()
    try {
      const result = await engine.runner.run("import fs from 'node:fs'; fs.writeFileSync('./big.bin', Buffer.alloc(2 * 1024 * 1024))", { artifactMb: 1 })
      assert.equal(result.ok, false)
      assert.match(result.stderr, /产物目录超过上限/)
      assert.equal((result.sandbox.artifact_bytes as number) > 1024 * 1024, true)
    } finally {
      close()
    }
  })
})

describe('沙盒计划与能力', () => {
  it('strict 计划包含降权/网络命名空间/权限模型，且不允许子进程', () => {
    const plan = buildSandboxPlan({
      mode: 'strict',
      scriptPath: '/tmp/x/main.mjs',
      artifactDir: '/tmp/x',
      memoryMb: 128,
      capabilities: { root: true, hasUnshare: true, hasSetpriv: true, permissionModel: true, strictAvailable: true, reasons: [] },
    })
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.plan.command, 'setpriv')
    assert.ok(plan.plan.args.includes('unshare'))
    assert.ok(plan.plan.args.includes('-n'))
    assert.ok(plan.plan.args.includes('--permission'))
    assert.ok(plan.plan.args.some((arg) => arg.startsWith('--allow-fs-read=')))
    assert.ok(!plan.plan.args.includes('--allow-child-process'))
    assert.ok(!plan.plan.args.includes('--allow-worker'))
    assert.equal(plan.plan.networkIsolated, true)
    assert.equal(plan.plan.uidDropped, true)
  })

  it('能力不足时 strict 失败关闭，不静默降级', () => {
    const plan = buildSandboxPlan({
      mode: 'strict',
      scriptPath: '/tmp/x/main.mjs',
      artifactDir: '/tmp/x',
      memoryMb: 128,
      capabilities: { root: true, hasUnshare: false, hasSetpriv: true, permissionModel: true, strictAvailable: false, reasons: ['缺少 unshare'] },
    })
    assert.equal(plan.ok, false)
    if (plan.ok) return
    assert.match(plan.error, /严格沙盒不可用/)
    assert.match(plan.error, /process/)
  })

  it('process 模式是显式选择，并在结果中标记为无沙盒', () => {
    const plan = buildSandboxPlan({ mode: 'process', scriptPath: '/tmp/x/main.mjs', artifactDir: '/tmp/x', memoryMb: 128 })
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.plan.mode, 'process')
    assert.equal(plan.plan.networkIsolated, false)
    assert.ok(plan.plan.warnings.some((warning) => warning.includes('进程级隔离')))
  })

  it('诊断暴露沙盒能力与边界声明', () => {
    const { engine, close } = makeEngine()
    try {
      const diagnostics = engine.services.systemDiagnostics()
      const execution = diagnostics.execution as Record<string, unknown>
      assert.equal(typeof execution.strict_available, 'boolean')
      assert.ok(execution.layers)
      assert.match(String(execution.boundary), /不是 seccomp|Permission Model/)
      assert.equal((diagnostics as Record<string, unknown>).ok, true)
    } finally {
      close()
    }
  })

  it('process 模式（显式）允许读取 /etc/passwd，证明它是无沙盒回退', { skip: !strict ? false : false }, async () => {
    const { engine, close } = makeEngine({ overrides: { security: { exec_sandbox: 'process' } } })
    try {
      const result = await engine.runner.run("import fs from 'node:fs'; console.log(fs.readFileSync('/etc/passwd','utf8').slice(0,4))")
      assert.equal(result.ok, true, result.stderr)
      assert.equal(result.sandbox.mode, 'process')
      assert.equal(result.isolation, 'process-only')
      assert.match(result.stdout, /root/)
      rmSync('/tmp/al-sandbox-escape.txt', { force: true })
    } finally {
      close()
    }
  })
})

describe('沙盒边界说明', () => {
  it('describeSandbox 明确“不是内核沙箱”', () => {
    const info = describeSandbox({ root: true, hasUnshare: true, hasSetpriv: true, permissionModel: true, strictAvailable: true, reasons: [] })
    assert.match(String(info.boundary), /不是 seccomp\/LSM 内核沙箱/)
  })
})
