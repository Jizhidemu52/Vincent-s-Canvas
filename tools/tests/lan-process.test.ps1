Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lan-process.ps1')

function Assert($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Expected a mismatched or duplicate process record to be rejected.'
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('canvas-lan-test space-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $fixture 'server/src') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture 'server/src/demo-server.ts'), 'console.log("fixture ready");setInterval(()=>{},1000);')
$bunPath = (Get-Command bun.exe -ErrorAction Stop).Source
$owned = @()
try {
    $first = Start-RecordedLanProcess $fixture $bunPath
    $owned += $first.ProcessId
    Assert ((Get-RecordedLanProcess $fixture).ProcessId -eq $first.ProcessId) 'Launch record did not identify the fixture.'
    Assert-Rejected { Start-RecordedLanProcess $fixture $bunPath }
    $recordPath = Get-LanProcessRecordPath $fixture
    $original = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8
    foreach ($field in @('createdAt', 'root', 'executablePath', 'commandLine')) {
        $invalid = $original | ConvertFrom-Json
        $invalid.$field = 'mismatched-fixture-value'
        [IO.File]::WriteAllText($recordPath, ($invalid | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Assert-Rejected { Stop-RecordedLanProcess $fixture }
        Assert ($null -ne (Get-Process -Id $first.ProcessId -ErrorAction SilentlyContinue)) 'A mismatched PID was stopped.'
    }
    [IO.File]::WriteAllText($recordPath, $original, (New-Object Text.UTF8Encoding($false)))
    Stop-RecordedLanProcess $fixture
    Assert (!(Test-Path -LiteralPath $recordPath)) 'Stopped process record was not removed.'
    Assert (Test-Path -LiteralPath $first.OutputLog) 'First output log was deleted.'
    $firstOutput = [IO.File]::ReadAllText($first.OutputLog)
    $second = Start-RecordedLanProcess $fixture $bunPath
    $owned += $second.ProcessId
    Assert ($first.OutputLog -cne $second.OutputLog) 'A restart reused the previous output log.'
    Assert ($first.ErrorLog -cne $second.ErrorLog) 'A restart reused the previous error log.'
    Assert ([IO.File]::ReadAllText($first.OutputLog) -ceq $firstOutput) 'A restart changed the first output log.'
    Stop-RecordedLanProcess $fixture
    Stop-RecordedLanProcess $fixture
    Write-Output 'LAN_LIFECYCLE_VERIFIED: launch, duplicate protection, four identity mismatches, stop, log preservation, restart, repeat stop.'
} finally {
    foreach ($ownedId in $owned) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedId"
        if ($null -ne $process -and $process.CommandLine.Contains($fixture)) { Stop-Process -Id $ownedId -Force }
    }
    $resolved = (Resolve-Path -LiteralPath $fixture).Path
    $expected = [IO.Path]::GetFullPath($fixture)
    if ($resolved -cne $expected -or [IO.Path]::GetFileName($resolved) -notlike 'canvas-lan-test space-*') { throw 'Refusing unexpected fixture cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
