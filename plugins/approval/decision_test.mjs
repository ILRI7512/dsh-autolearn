/**
 * 审批判定自测（不启动 Harness）。
 *
 * 风险清单优先用仓库内的 engine/tool_risks.json；从已安装目录运行时
 * 退回旧的工作区路径。这样同一份测试在仓库与本地安装目录都能跑。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decideApproval } from './index.js'

function loadManifest() {
  const candidates = [
    fileURLToPath(new URL('../../engine/tool_risks.json', import.meta.url)),
    'D:/Adsh/Zdsh/dsh_autonomous_learning/tool_risks.json',
  ]
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')).tools
    } catch {
      continue
    }
  }
  throw new Error(`tool_risks.json not found; tried: ${candidates.join(', ')}`)
}

const table = loadManifest()
const base = {
  prefix: 'mcp__autolearn__',
  table,
  askRisks: ['execute', 'destructive'],
  askTools: ['update_knowledge'],
  allowTools: [],
}
const cases = [
  ['mcp__autolearn__run_code_test', { code: 'print(1)' }, true],
  ['mcp__autolearn__invalidate_knowledge', { chunk_id: 'chunk_abc' }, true],
  ['mcp__autolearn__update_knowledge', { chunk_id: 'chunk_abc' }, true],
  ['mcp__autolearn__save_knowledge', { project_id: 'prj_1' }, false],
  ['mcp__autolearn__search_knowledge', { query: '滑点' }, false],
  ['mcp__autolearn__get_runtime_info', {}, false],
  ['mcp__other__run_code_test', {}, false],
]

let ok = true
for (const [name, args, expectAsk] of cases) {
  const decision = decideApproval({ ...base, name, args })
  const asked = decision !== null
  const pass = asked === expectAsk
  ok = ok && pass
  console.log(pass ? 'PASS' : 'FAIL', name, 'asked=' + asked, asked ? '| ' + decision.reason : '')
}

const allowed = decideApproval({
  ...base,
  name: 'mcp__autolearn__run_code_test',
  args: {},
  allowTools: ['run_code_test'],
})
const allowPass = allowed === null
ok = ok && allowPass
console.log(allowPass ? 'PASS' : 'FAIL', 'allowTools override')

process.exit(ok ? 0 : 1)
