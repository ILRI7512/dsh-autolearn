/**
 * 文件访问策略：路径穿越与符号链接逃逸必须被真实路径解析挡住。
 *
 * 允许根 = security.allowed_roots ∪ data_dir（缺省 cwd）。
 * 对不存在的目标，解析最近存在祖先的 realpath 后再拼接剩余部分，
 * 因此 `data/../etc/passwd` 与 `data/link-to-etc` 都会被拒绝。
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { PolicyDeniedError } from '../core/errors.ts'

export interface PathPolicyOptions {
  allowedRoots: readonly string[]
  dataDir?: string
  workspace?: string
}

export class PathPolicy {
  private readonly roots: string[]

  constructor(options: PathPolicyOptions) {
    const roots = options.allowedRoots.filter((root) => root.trim().length > 0)
    if (options.dataDir) roots.push(options.dataDir)
    if (roots.length === 0) roots.push(options.workspace ?? process.cwd())
    this.roots = [...new Set(roots.map((root) => safeRealpath(resolve(root))))]
  }

  get allowedRoots(): readonly string[] {
    return this.roots
  }

  /** 解析为真实路径（对不存在的尾部逐级回退到存在的祖先）。 */
  resolveTarget(input: string): string {
    const absolute = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input)
    return safeRealpath(absolute)
  }

  isAllowed(input: string): boolean {
    const target = this.resolveTarget(input)
    return this.roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
  }

  assertReadable(input: string): string {
    const target = this.resolveTarget(input)
    if (!this.isAllowed(target)) {
      throw new PolicyDeniedError(`路径不在授权根目录内（禁止读取）: ${target}`, {
        allowed_roots: this.roots,
      })
    }
    return target
  }

  assertWritable(input: string): string {
    const target = this.resolveTarget(input)
    if (!this.isAllowed(target)) {
      throw new PolicyDeniedError(`写入路径不在允许范围内（仅 data 目录与授权根目录）: ${target}`, {
        allowed_roots: this.roots,
      })
    }
    return target
  }

  /** 相对授权根的展示路径，供工具结果使用（不泄漏绝对路径）。 */
  displayPath(input: string): string {
    const target = this.resolveTarget(input)
    for (const root of this.roots) {
      const rel = relative(root, target)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
    }
    return basename(target)
  }

  isFile(input: string): boolean {
    try {
      return statSync(this.resolveTarget(input)).isFile()
    } catch {
      return false
    }
  }

  exists(input: string): boolean {
    return existsSync(this.resolveTarget(input))
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    // 目标不存在：解析存在的最近祖先，防止符号链接目录逃逸。
    let current = path
    const suffix: string[] = []
    for (let depth = 0; depth < 40; depth += 1) {
      try {
        const real = realpathSync.native(current)
        return suffix.length === 0 ? real : resolve(real, ...suffix.reverse())
      } catch {
        const parent = dirname(current)
        if (parent === current) break
        suffix.push(basename(current))
        current = parent
      }
    }
    return path
  }
}
