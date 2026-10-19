# 环境检查（不写入任何绝对路径）
#
# 用法：
#   pwsh scripts/check-env.ps1
#
# 安装插件前需要做的唯一“路径”配置：把仓库根告诉 DSH。
# 两种方式任选：
#   1) 在启动 DSH 的进程里设置 DSH_AL_WORKDIR=<repo 绝对路径>；
#   2) 不设也行——两个插件会从自身位置向上查找 dsh_autonomous_learning/。
param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Continue"
$engine = Join-Path $RepoRoot "dsh_autonomous_learning"

Write-Host "repo   : $RepoRoot"
Write-Host "engine : $engine"

$ok = $true
foreach ($item in @(
    @{ name = "engine/config.json"; path = (Join-Path $engine "config.json") },
    @{ name = "engine/tool_risks.json"; path = (Join-Path $engine "tool_risks.json") },
    @{ name = "plugins/autolearn/package.json"; path = (Join-Path $RepoRoot "plugins/autolearn/package.json") },
    @{ name = "plugins/approval/package.json"; path = (Join-Path $RepoRoot "plugins/approval/package.json") }
  )) {
  if (Test-Path $item.path) {
    Write-Host "  ok   $($item.name)"
  } else {
    Write-Host "  MISS $($item.name)" -ForegroundColor Yellow
    $ok = $false
  }
}

foreach ($cmd in @("python", "node", "pnpm")) {
  $found = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($found) { Write-Host "  ok   $cmd -> $($found.Source)" } else { Write-Host "  MISS $cmd" -ForegroundColor Yellow; $ok = $false }
}

# 生成风险清单（引擎侧脚本，幂等）
if ($ok) {
  Write-Host ""
  Write-Host "刷新工具风险清单（可选，工具变化后执行）："
  Write-Host "  `$env:PYTHONPATH='$RepoRoot'; python -m dsh_autonomous_learning.main --home '$engine' export-tool-risks"
}

Write-Host ""
Write-Host "安装插件（DSH 内）："
Write-Host "  plugin_manager install_bundle target=$RepoRoot/plugins/autolearn"
Write-Host "  plugin_manager install_bundle target=$RepoRoot/plugins/approval"
Write-Host ""
Write-Host "如果插件不在仓库布局里，设置 DSH_AL_HOME=<engine 目录> 再启动 DSH。"

if (-not $ok) { exit 1 }
