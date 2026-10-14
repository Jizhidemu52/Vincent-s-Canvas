param(
    [ValidateSet('fabric', 'tldraw', 'brand-sdk')]
    [string[]]$Only = @('fabric', 'tldraw', 'brand-sdk'),
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$labRoot = $PSScriptRoot
$labSpecs = @(
    @{ Folder = 'fabric'; Port = 4330; Marker = 'local-qa-boundary'; Command = 'node'; Script = 'node_modules\vite\bin\vite.js'; Extra = @('--config', 'vite.local.config.ts'); Sources = @('fabric') },
    @{ Folder = 'tldraw'; Port = 4332; Marker = 'original-source-lab-notice'; Command = 'node'; Script = 'node_modules\vite\bin\vite.js'; Extra = @('--config', 'vite.config.mjs'); Sources = @('tldraw') },
    @{ Folder = 'brand-sdk'; Port = 4331; Marker = '/host.js'; Command = 'bun'; Script = 'sdk-server.ts'; Extra = @(); Sources = @('sdk', 'loomic') }
) | Where-Object { $_.Folder -in $Only }
# Preflight all selected labs. Never stop another process or reuse an unknown server.
foreach ($labSpec in $labSpecs) {
    $labDir = Join-Path $labRoot $labSpec.Folder
    $labSpec.Exe = (Get-Command $labSpec.Command -ErrorAction Stop).Source
    if (Get-NetTCPConnection -State Listen -LocalPort $labSpec.Port -ErrorAction SilentlyContinue) { throw ('端口 ' + $labSpec.Port + ' 已占用，未停止任何进程。请先自行确认已有服务。') }
    if (-not (Test-Path -LiteralPath (Join-Path $labDir $labSpec.Script))) { throw ('缺少本地依赖或启动文件：' + $labSpec.Folder + '。请按 README.txt 安装。') }
    & (Join-Path $labRoot 'Setup-Sources.ps1') -Only $labSpec.Sources -VerifyOnly
    if ($labSpec.Folder -eq 'brand-sdk' -and -not (Test-Path -LiteralPath (Join-Path $labDir 'qa\public\host.js'))) { throw '插件尚未编译，请先在 brand-sdk 目录执行 node build-sdk.mjs。' }
}
foreach ($labSpec in $labSpecs) {
    $labDir = Join-Path $labRoot $labSpec.Folder
    $labUrl = 'http://127.0.0.1:' + $labSpec.Port + '/'
    $labAlive = $false
    if (-not $labAlive) {
        if (Get-NetTCPConnection -State Listen -LocalPort $labSpec.Port -ErrorAction SilentlyContinue) { throw ('端口 ' + $labSpec.Port + ' 已被其他服务占用，未停止任何进程。') }
        $labScript = Join-Path $labDir $labSpec.Script
        if (-not (Test-Path -LiteralPath $labScript)) { throw ('缺少本地运行依赖或启动文件：' + $labScript) }
        $labArgs = @(('"' + $labScript + '"')) + $labSpec.Extra
        if ($labSpec.Folder -eq 'brand-sdk') { $labArgs = @('--no-env-file', 'run') + $labArgs }
        Start-Process -FilePath $labSpec.Exe -ArgumentList $labArgs -WorkingDirectory $labDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $labDir 'launcher.stdout.log') -RedirectStandardError (Join-Path $labDir 'launcher.stderr.log') | Out-Null
        for ($labAttempt = 0; $labAttempt -lt 35; $labAttempt++) {
            Start-Sleep -Milliseconds 200
            try { $labResponse = Invoke-WebRequest -UseBasicParsing -Uri $labUrl -Headers @{ Accept = 'text/html' } -TimeoutSec 1; if ($labResponse.Content.Contains($labSpec.Marker)) { $labAlive = $true; break } } catch { }
        }
        if (-not $labAlive) { throw ('工作台启动失败：' + $labSpec.Folder + '。请查看对应目录中的 launcher.stderr.log。') }
    }
    Write-Output ('实验页已就绪（仅本机访问）：' + $labUrl)
    if (-not $NoBrowser) { Start-Process $labUrl }
}
