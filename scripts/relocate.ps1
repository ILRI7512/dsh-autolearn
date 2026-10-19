# 把 plugins/*/cordis.patch.yml 与 plugins/autolearn/index.js 中的示例绝对路径
# 替换为本机仓库路径。用法：
#   pwsh scripts/relocate.ps1 -Root D:/dsh-autolearn
#   pwsh scripts/relocate.ps1 -Root D:/dsh-autolearn -Python D:/Python/python.exe
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $Root).Path.Replace('\', '/').TrimEnd('/')
$engine = "$Root/engine"
$python = $Python.Replace('\', '/')

function Rewrite([string]$path, [hashtable]$pairs) {
  if (-not (Test-Path $path)) { throw "missing: $path" }
  $text = Get-Content $path -Raw -Encoding utf8
  foreach ($key in $pairs.Keys) { $text = $text.Replace($key, $pairs[$key]) }
  Set-Content -Path $path -Value $text -Encoding utf8 -NoNewline
  Write-Host "rewrote $path"
}

Rewrite "$Root/plugins/autolearn/cordis.patch.yml" @{
  "D:/Python/python.exe" = $python
  "D:/Adsh/Zdsh/dsh_autonomous_learning" = $engine
  "D:/Adsh/Zdsh" = $Root
}

Rewrite "$Root/plugins/approval/cordis.patch.yml" @{
  "D:/Adsh/Zdsh/dsh_autonomous_learning" = $engine
  "D:/Adsh/Zdsh" = $Root
}

Rewrite "$Root/plugins/autolearn/index.js" @{
  "D:/Adsh/Zdsh/dsh_autonomous_learning" = $engine
}

Rewrite "$Root/plugins/approval/index.js" @{
  "D:/Adsh/Zdsh/dsh_autonomous_learning" = $engine
}

Write-Host "done: engine=$engine"
