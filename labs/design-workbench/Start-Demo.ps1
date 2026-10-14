param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$demoPortNumber = if ($env:DESIGN_DEMO_PORT) { [int]$env:DESIGN_DEMO_PORT } else { 4328 }
$demoUrl = 'http://127.0.0.1:' + $demoPortNumber
$demoRoot = $PSScriptRoot
$demoRunning = $false
try {
    $demoHealth = Invoke-RestMethod -Uri ($demoUrl + '/health') -TimeoutSec 2
    $demoRunning = $demoHealth.app -eq 'vincent-design-lab'
} catch { }
if (-not $demoRunning) {
    $demoPort = Get-NetTCPConnection -State Listen -LocalPort $demoPortNumber -ErrorAction SilentlyContinue
    if ($demoPort) { throw ('端口 ' + $demoPortNumber + ' 已被其他程序占用，未停止任何进程。') }
    $demoBun = (Get-Command bun -ErrorAction Stop).Source
    $demoServer = Join-Path $demoRoot 'server.ts'
    Start-Process -FilePath $demoBun -ArgumentList @('--no-env-file', 'run', ('"' + $demoServer + '"')) -WorkingDirectory $demoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $demoRoot 'server.log') -RedirectStandardError (Join-Path $demoRoot 'server-error.log') | Out-Null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        try { $demoHealth = Invoke-RestMethod -Uri ($demoUrl + '/health') -TimeoutSec 1; if ($demoHealth.app -eq 'vincent-design-lab') { $demoRunning = $true; break } } catch { }
    }
    if (-not $demoRunning) { throw '设计工作台未能启动，请查看此文件夹中的 server-error.log。' }
}
if (-not $NoBrowser) { Start-Process $demoUrl }
