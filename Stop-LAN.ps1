Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $projectRoot 'tools/lan-process.ps1')
Write-Warning 'Stopping the local service ends local task observation; already submitted provider work may continue. Finish active work before using this command.'
Stop-RecordedLanProcess $projectRoot
