/**
 * 代码执行沙盒：能力探测 + 执行计划。
 *
 * 目标：把 lab 模式下的“进程级隔离”升级为可验证的沙盒，而不是宣称安全。
 *
 * 隔离层（strict）：
 * 1. 降权：root 运行时通过 setpriv 切到 nobody（65534），避免 root 信号/文件权限风险；
 * 2. 网络命名空间：unshare -n，进程没有可用网络（含 loopback）；
 * 3. Node Permission Model：--permission，只允许读写产物目录；
 *    未开启 --allow-child-process / --allow-worker / --allow-addons / --allow-inspector。
 *
 * 明确边界：
 * - 这不是内核级沙箱（没有 seccomp/LSM），而是“权限 + 命名空间 + 运行时权限模型”组合；
 * - 依赖 unshare/setpriv/Node 版本；能力不足时 strict **失败关闭**，绝不静默降级；
 * - 磁盘配额是产物目录软上限（执行后检查），不是实时 quota。
 */
import { spawnSync } from 'node:child_process'
import { chownSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type SandboxMode = 'strict' | 'process'

export interface SandboxCapabilities {
  root: boolean
  hasUnshare: boolean
  hasSetpriv: boolean
  permissionModel: boolean
  /** strict 全部前置条件是否满足。 */
  strictAvailable: boolean
  /** 失败原因（strict 不可用时）。 */
  reasons: string[]
}

export interface SandboxPlan {
  mode: SandboxMode
  command: string
  args: string[]
  networkIsolated: boolean
  uidDropped: boolean
  dropUidTo?: number
  warnings: string[]
}

export interface SandboxPlanInput {
  mode: SandboxMode
  scriptPath: string
  artifactDir: string
  memoryMb: number
  capabilities?: SandboxCapabilities
}

let cached: SandboxCapabilities | null = null

function commandExists(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5000 })
    return result.status === 0
  } catch {
    return false
  }
}

/** 用临时脚本探测 Node Permission Model 是否真的可用（而不是只看版本号）。 */
function probePermissionModel(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'al-perm-probe-'))
  try {
    const script = join(dir, 'probe.mjs')
    writeFileSync(script, "process.stdout.write('PERMISSION_OK')\n", 'utf8')
    const result = spawnSync(
      process.execPath,
      ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, script],
      { encoding: 'utf8', timeout: 5000 },
    )
    return result.status === 0 && String(result.stdout).includes('PERMISSION_OK')
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function sandboxCapabilities(force = false): SandboxCapabilities {
  if (cached && !force) return cached
  const root = typeof process.getuid === 'function' && process.getuid() === 0
  const hasUnshare = commandExists('unshare', ['--version'])
  const hasSetpriv = commandExists('setpriv', ['--version'])
  const permissionModel = probePermissionModel()
  const reasons: string[] = []
  if (!permissionModel) reasons.push('当前 Node 不支持 --permission（Permission Model）')
  if (!hasUnshare) reasons.push('缺少 unshare，无法建立网络命名空间')
  if (root && !hasSetpriv) reasons.push('root 运行时缺少 setpriv，无法降权到 nobody')
  cached = {
    root,
    hasUnshare,
    hasSetpriv,
    permissionModel,
    strictAvailable: reasons.length === 0,
    reasons,
  }
  return cached
}

export function buildSandboxPlan(input: SandboxPlanInput): { ok: true; plan: SandboxPlan } | { ok: false; error: string } {
  if (input.mode === 'process') {
    return {
      ok: true,
      plan: {
        mode: 'process',
        command: process.execPath,
        args: [input.scriptPath],
        networkIsolated: false,
        uidDropped: false,
        warnings: ['执行模式为 process：仅进程级隔离，没有文件系统/网络/权限沙盒（显式配置）'],
      },
    }
  }

  const capabilities = input.capabilities ?? sandboxCapabilities()
  if (!capabilities.strictAvailable) {
    return {
      ok: false,
      error: `严格沙盒不可用：${capabilities.reasons.join('；')}。如确需执行，请显式把 security.exec_sandbox 设为 process（不推荐）。`,
    }
  }

  const nodeFlags = [
    '--permission',
    `--allow-fs-read=${input.artifactDir}`,
    `--allow-fs-write=${input.artifactDir}`,
    `--max-old-space-size=${Math.max(32, Math.trunc(input.memoryMb))}`,
    input.scriptPath,
  ]

  if (capabilities.root) {
    return {
      ok: true,
      plan: {
        mode: 'strict',
        command: 'setpriv',
        args: [
          '--reuid=65534', '--regid=65534', '--clear-groups',
          'unshare', '-n',
          process.execPath, ...nodeFlags,
        ],
        networkIsolated: true,
        uidDropped: true,
        dropUidTo: 65534,
        warnings: [],
      },
    }
  }

  return {
    ok: true,
    plan: {
      mode: 'strict',
      command: 'unshare',
      args: ['-n', process.execPath, ...nodeFlags],
      networkIsolated: true,
      uidDropped: false,
      warnings: ['当前进程非 root：使用 unshare -n + Permission Model，未额外降权'],
    },
  }
}

/** 诊断展示：不执行用户代码，只报告能力。 */
export function describeSandbox(capabilities: SandboxCapabilities = sandboxCapabilities()): Record<string, unknown> {
  return {
    strict_available: capabilities.strictAvailable,
    layers: {
      privilege_drop: capabilities.root ? capabilities.hasSetpriv : true,
      network_namespace: capabilities.hasUnshare,
      node_permission_model: capabilities.permissionModel,
    },
    reasons: capabilities.reasons,
    boundary: '权限 + 命名空间 + Node Permission Model；不是 seccomp/LSM 内核沙箱',
  }
}

/** 让产物目录对降权后的 uid 可写（仅 runner 使用）。 */
export function prepareArtifactDir(dir: string, plan: SandboxPlan): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (plan.dropUidTo !== undefined) {
    try {
      chownSync(dir, plan.dropUidTo, plan.dropUidTo)
    } catch {
      // 非 root 或平台不支持：由权限模型兜底，记录在 runner 结果里。
    }
  }
}
