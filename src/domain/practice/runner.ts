/**
 * 受限代码执行（lab 模式专用）。
 *
 * 安全边界（必须与安全测试一致）：
 * - 只执行 JavaScript（node --input-type=module -e）；Python 执行不在 TS 版支持范围；
 * - 工作目录限定在 data/experiments 内的新建目录；
 * - 超时强制 kill；stdout/stderr 截断到 max_output_bytes；
 * - 环境变量白名单，不继承 API Key；
 * - 明确声明这是**进程级隔离**，不是安全沙箱。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId, utcnowIso } from '../../core/ids.ts'
import type { PathPolicy } from '../../security/paths.ts'

const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'NODE_PATH']

export interface CodeRunOptions {
  trusted: boolean
  timeoutSeconds: number
  maxOutputBytes: number
  experimentsDir: string
  pathPolicy: PathPolicy
  practiceId?: string
  projectId?: string
  language?: string
}

export interface CodeRunResult {
  ok: boolean
  status: 'pass' | 'fail' | 'timeout' | 'error'
  exit_code: number | null
  timed_out: boolean
  duration_ms: number
  stdout: string
  stderr: string
  environment: Record<string, unknown>
  isolation: string
  artifact_dir: string
}

function pickEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export class CodeTestRunner {
  private readonly options: Omit<CodeRunOptions, 'trusted' | 'practiceId' | 'projectId' | 'language'>

  constructor(options: Omit<CodeRunOptions, 'trusted' | 'practiceId' | 'projectId' | 'language'>) {
    this.options = options
  }

  async run(code: string, options: Partial<CodeRunOptions> = {}): Promise<CodeRunResult> {
    const experimentsDir = options.experimentsDir ?? this.options.experimentsDir
    const timeoutSeconds = options.timeoutSeconds ?? this.options.timeoutSeconds
    const maxOutput = options.maxOutputBytes ?? this.options.maxOutputBytes
    const language = (options.language ?? 'javascript').toLowerCase()
    const started = Date.now()
    const artifactDir = join(experimentsDir, newId('exp'))
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'main.mjs'), code, 'utf8')
    writeFileSync(join(artifactDir, 'spec.json'), `${JSON.stringify({ language, created_at: utcnowIso(), trusted: options.trusted ?? false }, null, 2)}\n`, 'utf8')

    if (!['javascript', 'js', 'mjs', 'node', 'typescript', 'ts'].includes(language)) {
      return {
        ok: false, status: 'error', exit_code: null, timed_out: false, duration_ms: 0,
        stdout: '', stderr: `不支持的语言: ${language}（TypeScript 引擎只执行 JavaScript；Python 运行时已移除）`,
        environment: { node: process.version },
        isolation: 'process', artifact_dir: artifactDir,
      }
    }

    const result = await runProcess(process.execPath, ['--input-type=module', join(artifactDir, 'main.mjs')], {
      cwd: artifactDir,
      timeoutMs: timeoutSeconds * 1000,
      maxOutputBytes: maxOutput,
      env: pickEnv(),
    })
    const duration = Date.now() - started
    writeFileSync(join(artifactDir, 'stdout.txt'), result.stdout, 'utf8')
    writeFileSync(join(artifactDir, 'stderr.txt'), result.stderr, 'utf8')
    const ok = result.exitCode === 0 && !result.timedOut
    return {
      ok,
      status: result.timedOut ? 'timeout' : ok ? 'pass' : 'fail',
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      duration_ms: duration,
      stdout: result.stdout,
      stderr: result.stderr,
      environment: { node: process.version, platform: process.platform, cwd: artifactDir, env_allowlist: ENV_ALLOWLIST },
      isolation: 'process（非安全沙箱）',
      artifact_dir: artifactDir,
    }
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: Record<string, string> },
): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') {
        if (stdout.length < options.maxOutputBytes) stdout += text.slice(0, options.maxOutputBytes - stdout.length)
      } else if (stderr.length < options.maxOutputBytes) {
        stderr += text.slice(0, options.maxOutputBytes - stderr.length)
      }
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: null, timedOut, stdout, stderr: `${stderr}\nspawn error: ${error.message}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code, timedOut, stdout, stderr })
    })
  })
}
