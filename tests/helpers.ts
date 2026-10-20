/** 测试辅助：每个用例一个临时 data 目录 + 独立引擎，结束时释放。 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutolearnEngine } from '../src/index.ts'
import { loadConfig } from '../src/core/config.ts'

export interface TestEngine {
  engine: AutolearnEngine
  dir: string
  close: () => void
}

export function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'al-test-'))
}

export function makeEngine(options: { hostApproval?: boolean; overrides?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {}): TestEngine {
  const dir = makeConfigDir()
  const env = {
    ...process.env,
    DSH_AL_HOME: dir,
    DSH_AL_DATA_DIR: join(dir, 'data'),
    DSH_AL_CONFIG: '',
    ...options.env,
  }
  const config = loadConfig({
    home: dir,
    env: env as NodeJS.ProcessEnv,
    overrides: options.overrides,
  })
  const engine = AutolearnEngine.open({ config, hostApproval: options.hostApproval ?? false })
  return {
    engine,
    dir,
    close: () => {
      engine.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function writeCorpus(dir: string, name: string, content: string): string {
  const corpus = join(dir, 'corpus')
  mkdirSync(corpus, { recursive: true })
  const path = join(corpus, name)
  writeFileSync(path, content, 'utf8')
  return path
}

export const SAMPLE_DOC = `# 风险管理与仓位

## 核心原理与机制

风险管理是指通过仓位控制、止损与相关性约束，把最大回撤限制在可接受范围。外汇交易中杠杆会放大滑点与点差的影响，必须把杠杆与保证金占用纳入计算。

公式：最大回撤 = (峰值净值 - 当前净值) / 峰值净值。

## 方法与流程

步骤：第一步确定单笔风险上限，第二步计算仓位，第三步设置止损。不要在没有止损的情况下加仓。

假设点差固定为 1.5 点，滑点为 0.5 点。这个假设可能不成立，需要逐笔核验。
`
