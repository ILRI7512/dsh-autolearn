import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeEngine } from '../helpers.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const cliPath = join(here, '..', '..', 'src', 'cli.ts')

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('用户侧 CLI：审批必须 user-only', () => {
  it('pending → approve → 单次消费', async () => {
    const { engine, dir, close } = makeEngine()
    const env = {
      ...process.env, DSH_AL_HOME: dir, DSH_AL_DATA_DIR: join(dir, 'data'), DSH_AL_CONFIG: '',
    }
    try {
      const token = engine.permissions.requestConfirmation('delete_chunk', 'chunk_x', 'prj_1')
      const pending = await runCli(['pending'], env)
      assert.equal(pending.code, 0)
      assert.ok(pending.stdout.includes(token))

      const approved = await runCli(['approve', token], env)
      assert.equal(approved.code, 0)
      assert.ok(approved.stdout.includes('"approved": true'))

      const consumed = engine.approval.consume(token, 'delete_chunk', 'chunk_x')
      assert.equal(consumed, true)
      assert.equal(engine.approval.consume(token, 'delete_chunk', 'chunk_x'), false)
    } finally {
      close()
    }
  })

  it('reject 后不可消费；未知 token 返回非零', async () => {
    const { engine, dir, close } = makeEngine()
    const env = { ...process.env, DSH_AL_HOME: dir, DSH_AL_DATA_DIR: join(dir, 'data'), DSH_AL_CONFIG: '' }
    try {
      const token = engine.permissions.requestConfirmation('restore_knowledge_base', 'db')
      const rejected = await runCli(['reject', token, '不要执行'], env)
      assert.equal(rejected.code, 0)
      const row = engine.approval.get(token)
      assert.equal(row?.status, 'rejected')
      const again = await runCli(['approve', token], env)
      assert.equal(again.code, 1)
      const missing = await runCli(['approve', 'nope'], env)
      assert.equal(missing.code, 1)
    } finally {
      close()
    }
  })

  it('diagnostics 与 search 子命令可用', async () => {
    const { engine, dir, close } = makeEngine()
    const env = { ...process.env, DSH_AL_HOME: dir, DSH_AL_DATA_DIR: join(dir, 'data'), DSH_AL_CONFIG: '' }
    try {
      const diagnostics = await runCli(['diagnostics'], env)
      assert.equal(diagnostics.code, 0)
      assert.ok(diagnostics.stdout.includes('schema_version'))
      const search = await runCli(['search', '滑点'], env)
      assert.equal(search.code, 0)
      assert.ok(search.stdout.includes('results'))
    } finally {
      close()
    }
  })
})
