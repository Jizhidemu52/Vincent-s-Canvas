Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$previousEdition = $env:VITE_STANDALONE_EDITION
Push-Location (Join-Path $projectRoot "web")
try {
    $env:VITE_STANDALONE_EDITION = "false"
    & bun run build
    if ($LASTEXITCODE -ne 0) { throw "Full LAN build failed. Do not restart the service." }
    Write-Output "Full LAN build ready. Start with Start-LAN.bat."
} finally {
    $env:VITE_STANDALONE_EDITION = $previousEdition
    Pop-Location
}
