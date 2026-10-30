#Requires -Version 7.0
<#
.SYNOPSIS
  把 dsh-local-library 装进 DSH Desktop 的 profile（建 junction + cordis.patch.yml insert 一行）。

.DESCRIPTION
  幂等：已经装过就只做自检。不碰 package.json / pnpm-lock.yaml / generation 投影。
  装完需要重启 DSH Desktop（宿主半侧）并刷新页面（客户端半侧）。

.EXAMPLE
  pwsh -File install.ps1
  pwsh -File install.ps1 -ProfileRoot 'C:\Users\me\AppData\Roaming\dsh-desktop\harness\profiles\web'
#>
[CmdletBinding()]
param(
  [string]$ProfileRoot = (Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web')
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-local-library'
$PackageDir = $PSScriptRoot
$LinkPath = Join-Path $ProfileRoot "node_modules\$PackageName"
$PatchPath = Join-Path $ProfileRoot 'cordis.patch.yml'

function Fail([string]$Message) {
  Write-Host "× $Message" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath $PatchPath)) {
  Fail "找不到 $PatchPath —— ProfileRoot 传错了吗？"
}
if (-not (Test-Path -LiteralPath (Join-Path $PackageDir 'lib\index.js'))) {
  Fail "本目录下没有 lib\index.js，请在包根目录运行这个脚本。"
}

# 1) junction：让包名在这个 profile 里解析得到
$linked = $false
if (Test-Path -LiteralPath $LinkPath) {
  $item = Get-Item -LiteralPath $LinkPath -Force
  $target = if ($item.Target) { @($item.Target)[0] } else { $null }
  if ($target -and ((Resolve-Path -LiteralPath $target).Path -eq (Resolve-Path -LiteralPath $PackageDir).Path)) {
    Write-Host "= junction 已存在：$LinkPath" -ForegroundColor DarkGray
    $linked = $true
  } else {
    Fail "$LinkPath 已存在但指向别处（$target）。先删掉它再重跑。"
  }
}
if (-not $linked) {
  $parent = Split-Path -Parent $LinkPath
  if (-not (Test-Path -LiteralPath $parent)) { Fail "profile 下没有 node_modules：$parent" }
  & cmd /c mklink /J "$LinkPath" "$PackageDir" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "mklink /J 失败（退出码 $LASTEXITCODE）" }
  Write-Host "+ junction -> $LinkPath" -ForegroundColor Green
}

# 2) cordis.patch.yml：在已有的 insert 列表末尾追加条目
$raw = [IO.File]::ReadAllText($PatchPath)
$eol = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines = [Collections.Generic.List[string]]::new([string[]]($raw -split "\r?\n"))

$alreadyInstalled = $false
foreach ($line in $lines) {
  if ($line -match "^\s+-\s+id:\s*$([regex]::Escape($PackageName))\s*$") { $alreadyInstalled = $true; break }
}

if ($alreadyInstalled) {
  Write-Host "= cordis.patch.yml 里已有 $PackageName，跳过" -ForegroundColor DarkGray
} else {
  $insertAt = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^-?\s*insert:\s*$') { $insertAt = $i; break }
  }
  if ($insertAt -lt 0) {
    # 没有 insert 段就整个追加一段
    $lines.Add('')
    $lines.Add('- insert:')
    $lines.Add("    - id: $PackageName")
    $lines.Add("      name: $PackageName")
  } else {
    $end = $insertAt + 1
    while ($end -lt $lines.Count) {
      $line = $lines[$end]
      if ($line.Trim() -eq '') { break }
      if ($line -match '^\s') { $end++ } else { break }
    }
    $block = @(
      '    # 本地资料库：设置左栏的「本地资料库」分区 + library_* 工具 + 系统提示词段。'
      "    - id: $PackageName"
      "      name: $PackageName"
    )
    $lines.InsertRange($end, [string[]]$block)
  }

  $backup = "$PatchPath.bak-$PackageName-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item -LiteralPath $PatchPath -Destination $backup
  [IO.File]::WriteAllText($PatchPath, ($lines -join $eol), (New-Object Text.UTF8Encoding($false)))
  Write-Host "+ cordis.patch.yml 已登记（备份：$backup）" -ForegroundColor Green
}

# 3) 解析自检：包名能否解析到宿主半侧与客户端半侧
#    注意：--input-type=module + -e 在这台机器的 electron-as-node 垫片里不输出，
#    所以落一个临时 .mjs 跑。
$node = Join-Path $env:APPDATA 'dsh-desktop\harness\.desktop-bin\node.cmd'
$pkgJson = Join-Path $ProfileRoot 'package.json'
if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $pkgJson)) {
  $probe = Join-Path ([IO.Path]::GetTempPath()) ("dsh-ll-probe-{0}.mjs" -f ([guid]::NewGuid().ToString('N')))
  @'
import { createRequire } from 'node:module'
const require = createRequire(process.argv[2])
let bad = 0
for (const spec of ['dsh-local-library', 'dsh-local-library/client']) {
  try { console.log('  OK   ' + spec + ' -> ' + require.resolve(spec)) }
  catch (error) { bad++; console.log('  FAIL ' + spec + ' -> ' + error.message) }
}
process.exitCode = bad === 0 ? 0 : 1
'@ | Set-Content -LiteralPath $probe -Encoding utf8NoBOM
  $env:ELECTRON_NO_ASAR = '1'
  try {
    & $node $probe $pkgJson
    if ($LASTEXITCODE -ne 0) { Fail '包名解析失败，检查 junction 是否被清理了' }
  } finally {
    Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  1) 重启 DSH Desktop（宿主半侧在启动时加载插件）'
Write-Host '  2) 刷新页面（F5），设置 → 左栏应出现「本地资料库」'
Write-Host '  3) 新开一个对话，模型应能看到 library_* 四个工具'
