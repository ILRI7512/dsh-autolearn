import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, CONFIG_ENV } from '../../src/core/config.ts'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'al-cfg-'))
}

describe('配置加载', () => {
  it('缺省即可运行，路径落在 home/data 下', () => {
    const home = tempHome()
    const cfg = loadConfig({ home, env: { ...process.env, DSH_AL_CONFIG: '' } as NodeJS.ProcessEnv })
    assert.equal(cfg.paths.home, home)
    assert.equal(cfg.paths.db_path, join(home, 'data', 'metadata.sqlite3'))
    assert.equal(cfg.embedding.provider, 'hashing')
    assert.equal(cfg.learning.chunk_size, 900)
    assert.equal(cfg.security.allow_network, false)
    rmSync(home, { recursive: true, force: true })
  })

  it('未知配置项直接报错（不允许静默失效）', () => {
    const home = tempHome()
    const file = join(home, 'config.json')
    writeFileSync(file, JSON.stringify({ learning: { chunk_sise: 100 } }))
    assert.throws(
      () => loadConfig({ path: file, home, env: { ...process.env } as NodeJS.ProcessEnv }),
      /未知配置项/,
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('YAML 配置明确报错（不再依赖 PyYAML）', () => {
    const home = tempHome()
    const file = join(home, 'config.yaml')
    writeFileSync(file, 'learning:\n  chunk_size: 300\n')
    assert.throws(
      () => loadConfig({ path: file, home, env: { ...process.env } as NodeJS.ProcessEnv }),
      /YAML/,
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('环境变量覆盖关键项', () => {
    const home = tempHome()
    const cfg = loadConfig({
      home,
      env: {
        ...process.env,
        DSH_AL_CONFIG: '',
        DSH_AL_MODE: 'lab',
        DSH_AL_ALLOW_NETWORK: 'true',
        DSH_AL_EMBEDDING_PROVIDER: 'hashing',
        DSH_AL_DATA_DIR: join(home, 'custom'),
      } as NodeJS.ProcessEnv,
    })
    assert.equal(cfg.learning.default_mode, 'lab')
    assert.equal(cfg.security.allow_network, true)
    assert.equal(cfg.paths.data_dir, join(home, 'custom'))
    rmSync(home, { recursive: true, force: true })
  })

  it('宿主设置卡只接受白名单键并生效', () => {
    const home = tempHome()
    mkdirSync(join(home, 'data'), { recursive: true })
    writeFileSync(join(home, 'data', 'settings.json'), JSON.stringify({
      mode: 'auto', dailyBudgetUsd: 2.5, maxTasksPerRun: 7, evil: 'x',
    }))
    const cfg = loadConfig({ home, env: { ...process.env, DSH_AL_CONFIG: '' } as NodeJS.ProcessEnv })
    assert.equal(cfg.learning.default_mode, 'auto')
    assert.equal(cfg.learning.daily_budget_usd, 2.5)
    assert.equal(cfg.learning.max_tasks_per_run, 7)
    rmSync(home, { recursive: true, force: true })
  })

  it('非法值被拒绝（chunk_overlap >= chunk_size）', () => {
    const home = tempHome()
    const file = join(home, 'config.json')
    writeFileSync(file, JSON.stringify({ learning: { chunk_size: 200, chunk_overlap: 300 } }))
    assert.throws(
      () => loadConfig({ path: file, home, env: { ...process.env } as NodeJS.ProcessEnv }),
      /chunk_overlap/,
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('openai 模型缺密钥时明确报错（密钥不得写进配置）', () => {
    const home = tempHome()
    const file = join(home, 'config.json')
    writeFileSync(file, JSON.stringify({ model: { provider: 'openai', base_url: 'https://example.com' } }))
    assert.throws(
      () => loadConfig({ path: file, home, env: { ...process.env, [CONFIG_ENV]: '' } as NodeJS.ProcessEnv }),
      /环境变量/,
    )
    rmSync(home, { recursive: true, force: true })
  })
})
