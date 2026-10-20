import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSettings, writeSettings, settingsPath } from "./index.js"

const dir = mkdtempSync(join(tmpdir(), "al-settings-"))
process.env.DSH_AL_SETTINGS_FILE = join(dir, "settings.json")
console.log("path:", settingsPath())
console.log("defaults:", JSON.stringify(readSettings()))

let r = writeSettings({ mode: "lab", dailyBudgetUsd: 2.5, maxTasksPerRun: 12 })
console.log("write ok:", JSON.stringify(r.settings))
console.log("readback:", JSON.stringify(readSettings()))

console.log("invalid mode:", writeSettings({ mode: "yolo" }).error)
console.log("invalid budget:", writeSettings({ dailyBudgetUsd: -1 }).error)
console.log("relative dir:", writeSettings({ dataDir: "relative/path" }).error)
// 用当前平台的绝对路径，避免 Windows 盘符写法在 POSIX 上被判为相对路径
console.log("abs dir:", writeSettings({ dataDir: join(tmpdir(), "al-data") }).settings.dataDir)
rmSync(dir, { recursive: true, force: true })
