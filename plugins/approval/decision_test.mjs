import { readFileSync } from "node:fs"
import { decideApproval } from "./index.js"
const table = JSON.parse(readFileSync("D:/Adsh/Zdsh/dsh_autonomous_learning/tool_risks.json", "utf8")).tools
const base = { prefix: "mcp__autolearn__", table, askRisks: ["execute","destructive"], askTools: ["update_knowledge"], allowTools: [] }
const cases = [
  ["mcp__autolearn__run_code_test", {code:"print(1)"}, true],
  ["mcp__autolearn__invalidate_knowledge", {chunk_id:"chunk_abc"}, true],
  ["mcp__autolearn__update_knowledge", {chunk_id:"chunk_abc"}, true],
  ["mcp__autolearn__save_knowledge", {project_id:"prj_1"}, false],
  ["mcp__autolearn__search_knowledge", {query:"滑点"}, false],
  ["mcp__autolearn__get_runtime_info", {}, false],
  ["mcp__other__run_code_test", {}, false],
]
let ok = true
for (const [name, args, expectAsk] of cases) {
  const d = decideApproval({ ...base, name, args })
  const asked = d !== null
  const pass = asked === expectAsk
  ok = ok && pass
  console.log((pass?"PASS":"FAIL"), name, "asked=" + asked, asked ? "| " + d.reason : "")
}
const allowed = decideApproval({ ...base, name:"mcp__autolearn__run_code_test", args:{}, allowTools:["run_code_test"] })
console.log(allowed === null ? "PASS allowTools override" : "FAIL allowTools override")
process.exit(ok && allowed === null ? 0 : 1)
