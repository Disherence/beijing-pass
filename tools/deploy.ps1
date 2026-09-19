# 一键部署到目标主机：打包 → 上传 → 解包 → 重启服务
# 用法：pwsh tools/deploy.ps1 -Target root@192.168.1.10 [-RemoteDir /opt/beijing-pass]
# 也可以先设置环境变量 JJZ_TARGET，省去每次传参
param(
  [string]$Target = $env:JJZ_TARGET,
  [string]$RemoteDir = '/opt/beijing-pass',
  [switch]$Restart = $true
)

$ErrorActionPreference = 'Stop'
if (-not $Target) {
  throw '请用 -Target 指定目标主机（例如 -Target root@192.168.1.10），或设置环境变量 JJZ_TARGET'
}
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'beijing-pass-deploy.tgz'

Write-Host "打包 $root ..." -ForegroundColor Cyan
Remove-Item $stage -Force -ErrorAction SilentlyContinue
# 排除抓包文件与运行时数据，避免凭证外泄
tar.exe -czf $stage --exclude=./.git --exclude=./data --exclude=./*.har -C $root .
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
Write-Host ("  包大小 {0:N1} KB" -f ((Get-Item $stage).Length / 1KB))

Write-Host "上传到 $Target ..." -ForegroundColor Cyan
scp -o BatchMode=yes $stage "${Target}:/tmp/beijing-pass-deploy.tgz"
if ($LASTEXITCODE -ne 0) { throw '上传失败' }

Write-Host "解包并处理权限 ..." -ForegroundColor Cyan
$remote = "tar -xzf /tmp/beijing-pass-deploy.tgz -C $RemoteDir && rm -f /tmp/beijing-pass-deploy.tgz && chown -R jjz:jjz $RemoteDir"
if ($Restart) { $remote += ' && systemctl restart beijing-pass' }
$remote += ' && sleep 1 && systemctl is-active beijing-pass'
ssh -o BatchMode=yes $Target $remote
if ($LASTEXITCODE -ne 0) { throw '远程部署失败' }

Write-Host "完成，服务状态：" -ForegroundColor Green
ssh -o BatchMode=yes $Target 'curl -s http://127.0.0.1:3000/api/health'
