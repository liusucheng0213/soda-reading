param(
  [Parameter(Mandatory = $true)][string]$EncryptedDump,
  [Parameter(Mandatory = $true)][string]$AgeIdentityFile,
  [Parameter(Mandatory = $true)][string]$RestoreDatabaseUrl
)

$resolvedDump = (Resolve-Path -LiteralPath $EncryptedDump).Path
$resolvedIdentity = (Resolve-Path -LiteralPath $AgeIdentityFile).Path
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("soda-restore-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $decrypted = Join-Path $temporary "soda-reading.dump"
  & age --decrypt --identity $resolvedIdentity --output $decrypted $resolvedDump
  if ($LASTEXITCODE -ne 0) { throw "age 解密失败" }
  & pg_restore --dbname $RestoreDatabaseUrl --clean --if-exists --no-owner --no-acl $decrypted
  if ($LASTEXITCODE -ne 0) { throw "pg_restore 恢复失败" }
  Write-Host "恢复演练完成。请连接临时数据库检查 profiles、article_variants 和 daily_editions。"
} finally {
  $resolvedTemporary = (Resolve-Path -LiteralPath $temporary).Path
  if (-not $resolvedTemporary.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝删除非临时目录"
  }
  Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
}
