#Requires -Version 7.0
<#
.SYNOPSIS
  从 DSH Desktop 的 profile 里卸载 dsh-local-library。

.DESCRIPTION
  只撤销 install.ps1 做的两件事（patch 条目、node_modules 里的 junction）。
  资料库里的文件默认保留；加 -PurgeData 才会连 $DSH_HOME\local-library 一起删。
  卸载完同样需要重启 DSH Desktop 才生效。

.EXAMPLE
  pwsh -File uninstall.ps1
  pwsh -File uninstall.ps1 -PurgeData
#>
[CmdletBinding()]
param(
  [string]$ProfileRoot = (Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web'),
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-local-library'
$LinkPath = Join-Path $ProfileRoot "node_modules\$PackageName"
$PatchPath = Join-Path $ProfileRoot 'cordis.patch.yml'

# 1) 撤销 junction（只删链接，不动仓库里的包体）
if (Test-Path -LiteralPath $LinkPath) {
  $item = Get-Item -LiteralPath $LinkPath -Force
  if ($item.LinkType -ne 'Junction') {
    Write-Host "× $LinkPath 不是 junction，拒绝删除" -ForegroundColor Red
    exit 1
  }
  & cmd /c rmdir "$LinkPath" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "× rmdir 失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
    exit 1
  }
  Write-Host "- junction 已移除" -ForegroundColor Green
} else {
  Write-Host '= junction 不存在，跳过' -ForegroundColor DarkGray
}

# 2) 从 cordis.patch.yml 删掉 install 加的那几行
if (Test-Path -LiteralPath $PatchPath) {
  $raw = [IO.File]::ReadAllText($PatchPath)
  $eol = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = [string[]]($raw -split "\r?\n")

  $kept = [Collections.Generic.List[string]]::new()
  $removed = 0
  $skipNext = $false
  foreach ($line in $lines) {
    if ($skipNext) {
      $skipNext = $false
      if ($line -match "^\s+name:\s*$([regex]::Escape($PackageName))\s*$") { $removed++; continue }
    }
    if ($line -match "^\s+-\s+id:\s*$([regex]::Escape($PackageName))\s*$") {
      $removed++
      $skipNext = $true
      # 顺手回收紧贴在它上面的说明注释（缩进注释；顶格注释属于别的段落，不动）
      while ($kept.Count -gt 0 -and $kept[$kept.Count - 1] -match '^\s+#') { $kept.RemoveAt($kept.Count - 1) }
      continue
    }
    $kept.Add($line)
  }

  if ($removed -gt 0) {
    $backup = "$PatchPath.bak-$PackageName-uninstall-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $PatchPath -Destination $backup
    [IO.File]::WriteAllText($PatchPath, ($kept -join $eol), (New-Object Text.UTF8Encoding($false)))
    Write-Host "- cordis.patch.yml 已清掉 $removed 行（备份：$backup）" -ForegroundColor Green
  } else {
    Write-Host '= cordis.patch.yml 里没有本插件，跳过' -ForegroundColor DarkGray
  }
}

# 3) 资料库数据
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:APPDATA 'dsh-desktop\harness' }
$dataDir = Join-Path $dshHome 'local-library'
if ($PurgeData) {
  if (Test-Path -LiteralPath $dataDir) {
    Remove-Item -LiteralPath $dataDir -Recurse -Force
    Write-Host "- 数据目录已删除：$dataDir" -ForegroundColor Yellow
  }
} elseif (Test-Path -LiteralPath $dataDir) {
  Write-Host "= 资料库文件保留在：$dataDir（要一起删就加 -PurgeData）" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '重启 DSH Desktop 后插件即彻底卸载。' -ForegroundColor Cyan
