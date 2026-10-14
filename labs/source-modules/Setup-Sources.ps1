param(
    [ValidateSet('fabric', 'tldraw', 'loomic', 'sdk', 'invoke', 'comfy')]
    [string[]]$Only = @('fabric', 'tldraw', 'loomic', 'sdk', 'invoke', 'comfy'),
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$labRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$labManifest = Get-Content -LiteralPath (Join-Path $labRoot 'source-manifest.json') -Raw | ConvertFrom-Json
$labGit = (Get-Command git -ErrorAction Stop).Source
function Invoke-LabGit([string[]]$GitArguments) {
    & $labGit @GitArguments
    if ($LASTEXITCODE -ne 0) { throw ('Git 命令失败，请查看上面的错误：' + ($GitArguments -join ' ')) }
}
foreach ($labSource in $labManifest.sources | Where-Object { $_.id -in $Only }) {
    if ($labSource.repository -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$' -or $labSource.commit -notmatch '^[0-9a-f]{40}$') {
        throw '源码清单中的仓库地址或提交号无效。'
    }
    $labTarget = [IO.Path]::GetFullPath((Join-Path $labRoot $labSource.checkout))
    if (-not $labTarget.StartsWith($labRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '源码检出路径超出当前实验目录。' }
    if (-not (Test-Path -LiteralPath $labTarget)) {
        if ($VerifyOnly) { throw ('尚未安装该源码：' + $labSource.id) }
        New-Item -ItemType Directory -Path (Split-Path -Parent $labTarget) -Force | Out-Null
        Invoke-LabGit -GitArguments @('clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--', $labSource.repository, $labTarget)
        Invoke-LabGit -GitArguments (@('-C', $labTarget, 'sparse-checkout', 'set', '--cone', '--') + @($labSource.sparsePaths))
        Invoke-LabGit -GitArguments @('-C', $labTarget, 'fetch', '--depth', '1', 'origin', $labSource.commit)
        Invoke-LabGit -GitArguments @('-C', $labTarget, 'checkout', '--detach', $labSource.commit)
    }
    # Existing checkouts are never reset, overwritten, or switched automatically.
    $labOrigin = (Invoke-LabGit -GitArguments @('-C', $labTarget, 'remote', 'get-url', 'origin')).Trim()
    $labCommit = (Invoke-LabGit -GitArguments @('-C', $labTarget, 'rev-parse', 'HEAD')).Trim()
    if ($labOrigin -ne $labSource.repository -or $labCommit -ne $labSource.commit) { throw ('已有源码与清单不一致，未覆盖：' + $labSource.id) }
    $labDirty = @(Invoke-LabGit -GitArguments @('-C', $labTarget, 'status', '--porcelain'))
    if ($labDirty.Count -gt 0) { throw ('源码存在本地修改，未覆盖：' + $labSource.id) }
    if (-not (Test-Path -LiteralPath (Join-Path $labTarget $labSource.licenseFile))) { throw ('缺少原许可证：' + $labSource.id) }
    Write-Output ('源码已核实：' + $labSource.id + '，提交 ' + $labCommit)
}
