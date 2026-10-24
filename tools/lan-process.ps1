Set-StrictMode -Version Latest

function Get-LanProcessRecordPath([string]$ProjectRoot) {
    return Join-Path $ProjectRoot 'server/.data/lan-server.process.json'
}

function Get-RecordedLanProcess([string]$ProjectRoot) {
    $recordPath = Get-LanProcessRecordPath $ProjectRoot
    if (!(Test-Path -LiteralPath $recordPath)) { return $null }
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $resolvedRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $serverScript = Join-Path $resolvedRoot 'server/src/demo-server.ts'
    if ($record.version -ne 1 -or $record.root -ine $resolvedRoot -or $record.serverScript -ine $serverScript -or $record.processId -lt 1) {
        throw 'The LAN process record belongs to another project or is invalid. No process was stopped.'
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$record.processId)"
    if ($null -eq $process) { return $null }
    if ($process.CreationDate.ToUniversalTime().ToString('o') -cne $record.createdAt -or
        $process.ExecutablePath -ine $record.executablePath -or $process.CommandLine -cne $record.commandLine -or
        $process.CommandLine.IndexOf($serverScript, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "PID $($record.processId) no longer matches this launch record. No process was stopped."
    }
    return $process
}

function Save-LanProcessRecord([string]$ProjectRoot, [int]$ProcessId, [string]$OutputLog, [string]$ErrorLog) {
    $resolvedRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $serverScript = Join-Path $resolvedRoot 'server/src/demo-server.ts'
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
    if ($null -eq $process -or $process.CommandLine.IndexOf($serverScript, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'The newly launched LAN process could not be identified.'
    }
    $record = [ordered]@{ version = 1; root = $resolvedRoot; serverScript = $serverScript; processId = $ProcessId
        createdAt = $process.CreationDate.ToUniversalTime().ToString('o'); executablePath = $process.ExecutablePath
        commandLine = $process.CommandLine; outputLog = $OutputLog; errorLog = $ErrorLog }
    $recordPath = Get-LanProcessRecordPath $resolvedRoot
    $temporary = "$recordPath.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $recordPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}

function Start-RecordedLanProcess([string]$ProjectRoot, [string]$BunPath) {
    $existing = Get-RecordedLanProcess $ProjectRoot
    if ($null -ne $existing) { throw "This project's LAN process ($($existing.ProcessId)) is already running." }
    $serverRoot = Join-Path $ProjectRoot 'server'
    $logRoot = Join-Path $serverRoot '.data'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $launchId = (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    $outputLog = Join-Path $logRoot "lan-server-$launchId.out.log"
    $errorLog = Join-Path $logRoot "lan-server-$launchId.err.log"
    $serverScript = Join-Path $serverRoot 'src/demo-server.ts'
    $started = Start-Process -FilePath $BunPath -ArgumentList "`"$serverScript`"" -WorkingDirectory $serverRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog
    try { Save-LanProcessRecord $ProjectRoot $started.Id $outputLog $errorLog }
    catch {
        if (!$started.HasExited) { $started.Kill() }
        throw
    }
    return [pscustomobject]@{ ProcessId = $started.Id; OutputLog = $outputLog; ErrorLog = $errorLog }
}

function Stop-RecordedLanProcess([string]$ProjectRoot) {
    $process = Get-RecordedLanProcess $ProjectRoot
    if ($null -eq $process) { Write-Output 'No recorded LAN process is running.'; return }
    # Identity was checked against PID, creation time, executable and command.
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Get-LanProcessRecordPath $ProjectRoot)
    Write-Output "Stopped this project's LAN process ($($process.ProcessId)). Logs and database were preserved."
}
