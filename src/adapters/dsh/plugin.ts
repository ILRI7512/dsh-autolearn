/**
 * DSH 原生插件入口（Host-only）。
 *
 * 生命周期：创建引擎 → 注册工具 → 注册 pre-execute 审批 → 卸载时关闭数据库。
 * 审批失败关闭（fail-closed）：判定异常时返回 ask，而不是放行。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AutolearnEngine } from '../../index.ts'
import { buildNativeTools, needsApproval, approvalReason } from './tools.ts'

interface ToolRegistration {
  name: string
}

interface ToolRegistry {
  register: (tool: unknown) => () => void
}

interface PluginContextLike {
  tools?: ToolRegistry
  on?: (event: string, listener: (...args: unknown[]) => unknown) => (() => void) | undefined
  effect?: (callback: () => (() => void) | void, label?: string) => unknown
  get?: (name: string) => unknown
}

export interface PluginConfig {
  home?: string
  settingsFile?: string
}

/**
 * 引擎目录：显式配置 > DSH_AL_HOME > 仓库布局探测。
 *
 * 探测顺序同时看 cwd 与插件自身位置（dist/adapters/dsh → 上三级是仓库根），
 * 这样 DSH 进程 cwd 不是仓库根（常见为 /root）时也不会把数据写到错误目录。
 */
export function resolveEngineHome(config: PluginConfig = {}, env: NodeJS.ProcessEnv = process.env): string {
  if (config.home) return config.home
  if (env.DSH_AL_HOME) return env.DSH_AL_HOME
  let moduleRoot = process.cwd()
  try {
    moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  } catch {
    /* 非文件入口（测试打包）时退回 cwd */
  }
  for (const base of [process.cwd(), moduleRoot]) {
    if (existsSync(join(base, 'config.json'))) return base
    const legacy = join(base, 'dsh_autonomous_learning')
    if (existsSync(join(legacy, 'config.json'))) return legacy
  }
  return process.cwd()
}

function telemetry(event: string, fields: Record<string, unknown>): void {
  if (process.env.DSH_AL_LOG_LEVEL?.toUpperCase() === 'DEBUG') {
    console.log(`[dsh-autolearn] ${event} ${JSON.stringify(fields)}`)
  }
}

export function apply(ctx: PluginContextLike, config: PluginConfig = {}): (() => void) | void {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    console.warn('[dsh-autolearn] ctx.tools 不可用：原生工具未注册')
    return
  }
  let engine: AutolearnEngine
  try {
    engine = AutolearnEngine.open({ home: resolveEngineHome(config), hostApproval: true, telemetry })
  } catch (error) {
    // 启动失败必须显式暴露，不能静默降级成"没有工具"。
    console.error(`[dsh-autolearn] 引擎启动失败: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const tools = buildNativeTools({
    services: engine.services,
    maxOutputBytes: engine.config.security.max_output_bytes,
  })

  const dispose = (): void => {
    engine.close()
  }
  const register = (): (() => void) => {
    const disposers: Array<() => void> = []
    for (const tool of tools) {
      try {
        const off = ctx.tools?.register(tool)
        if (typeof off === 'function') disposers.push(off)
      } catch (error) {
        console.error(`[dsh-autolearn] 工具注册失败 ${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let offHook: (() => void) | undefined
    if (typeof ctx.on === 'function') {
      offHook = ctx.on('tools/pre-execute', (...raw: unknown[]) => {
        const exec = raw[0] as { name?: string; args?: Record<string, unknown> } | undefined
        const next = raw[1] as (() => unknown) | undefined
        try {
          if (exec?.name && needsApproval(exec.name, exec.args ?? {})) {
            return { kind: 'ask', reason: approvalReason(exec.name, exec.args ?? {}) }
          }
          return typeof next === 'function' ? next() : undefined
        } catch (error) {
          // 失败关闭：审批判定异常时仍然 ask，绝不自动放行。
          console.warn(`[dsh-autolearn] 审批判定异常，按失败关闭: ${error instanceof Error ? error.message : String(error)}`)
          return { kind: 'ask', reason: '自主学习插件的审批判定异常，已按失败关闭处理；请确认后再执行。' }
        }
      }) as unknown as () => void
    }
    console.log(`[dsh-autolearn] 原生工具已注册: ${tools.length} 个（${tools.map((tool) => tool.name).join(', ')}）`)
    return () => {
      try { offHook?.() } catch { /* 已注销 */ }
      for (const off of disposers) {
        try { off() } catch { /* 已注销 */ }
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const unregister = register()
      return () => {
        unregister()
        dispose()
      }
    }, 'dsh-autolearn: engine + native tools')
    return
  }
  const unregister = register()
  return () => {
    unregister()
    dispose()
  }
}

export { needsApproval, approvalReason, buildNativeTools }
export type { ToolRegistration }
