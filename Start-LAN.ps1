param([switch]$CompanyOa)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'tools/lan-process.ps1')
$serverRoot = Join-Path $root "server"
$webRoot = Join-Path $root "web\\dist"
$ruleName = "Wireless Canvas LAN Pilot TCP 5188 LocalSubnet"
$port = 5188

$editionManifest = Join-Path $webRoot "deployment-edition.json"
if (!(Test-Path -LiteralPath $editionManifest)) {
    throw "Build metadata is missing. Run Build-LAN.bat before starting."
}
$edition = Get-Content -LiteralPath $editionManifest -Raw | ConvertFrom-Json
if ($edition.standalone -ne $false) {
    throw "This is a simplified build without admin pages. Run Build-LAN.bat to build the full version."
}

if (!(Test-Path -LiteralPath (Join-Path $webRoot "index.html"))) {
    Write-Error "The web build is missing. Run the web production build before starting LAN mode."
    exit 1
}

$bun = Get-Command bun.exe -ErrorAction SilentlyContinue
if ($null -eq $bun) {
    $bun = Get-Command bun -ErrorAction Stop
}

$lanInterfaceIds = @(Get-NetAdapter | Where-Object { $_.HardwareInterface -and $_.Status -eq "Up" } | Select-Object -ExpandProperty InterfaceIndex)
$config = Get-NetIPConfiguration |
    Where-Object { ($_.InterfaceIndex -in $lanInterfaceIds) -and ($null -ne $_.IPv4DefaultGateway) -and ($null -ne $_.IPv4Address) } |
    Sort-Object { $_.IPv4Address.PrefixLength } |
    Select-Object -First 1
if ($null -eq $config) {
    Write-Error "No active LAN IPv4 connection was found."
    exit 1
}

$network = Get-NetConnectionProfile -InterfaceIndex $config.InterfaceIndex -ErrorAction Stop
$firewallProfile = if ($network.NetworkCategory -eq "DomainAuthenticated") { "Domain" } elseif ($network.NetworkCategory -eq "Private") { "Private" } else { "Public" }
$address = $config.IPv4Address.IPAddress
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($null -eq $existingRule) {
    try {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile $firewallProfile -InterfaceAlias $config.InterfaceAlias -LocalAddress $address -RemoteAddress LocalSubnet | Out-Null
    }
    catch {
        Write-Warning "Windows blocked the LAN firewall rule. Run Start-LAN.bat once as administrator, then restart it normally."
        exit 1
    }
}
else {
    $existingRule | Set-NetFirewallRule -Enabled True -Profile $firewallProfile -InterfaceAlias $config.InterfaceAlias -LocalAddress $address -RemoteAddress LocalSubnet
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($null -ne $listener) {
    $listenerIds = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
    $owners = @($listenerIds | ForEach-Object {
        $ownerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$_)"
        "$($_) ($($ownerProcess.Name))"
    }) -join ', '
    Write-Output "Port $port is occupied by PID $owners. Verifying that it is the expected Canvas service and access mode."
}
else {
    $recordedProcess = Get-RecordedLanProcess $root
    if ($null -ne $recordedProcess) {
        throw "This project's LAN process ($($recordedProcess.ProcessId)) is already starting or uses another port. Inspect its logs or use Stop-LAN.bat before restarting."
    }
    $env:LOCAL_STANDALONE = "false"
    # The default remains a local trial. CompanyOa requires an existing trusted OA entry.
    $env:OA_LOGIN_ENABLED = if ($CompanyOa) { "true" } else { "false" }
    $env:AUTH_ENABLED = "false"
    $env:CREDITS_ENABLED = "false"
    $env:ROLE_PORTALS_ENABLED = "false"
    $env:STANDALONE_WEB_DIR = $webRoot
    $env:DEMO_PORT = "$port"
    $env:DEMO_HOST = "0.0.0.0"
    $started = Start-RecordedLanProcess $root $bun.Source
    Write-Output "Started LAN process $($started.ProcessId). Logs: $($started.OutputLog) and $($started.ErrorLog)"
}

$ready = $false
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    try {
        $request = [System.Net.WebRequest]::Create("http://${address}:$port/api/health")
        $request.Proxy = $null
        $request.Timeout = 2000
        $response = $request.GetResponse()
        try {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            try { $health = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
            $ready = $health.status -eq "ok" -and $health.mode -eq "local-demo"
        } finally { $response.Close() }
        if ($ready) { break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (!$ready) { throw "LAN service health check failed; port $port is not a healthy Canvas local-demo service. Check its owning PID and server/.data/lan-server-*.err.log. No existing process was stopped." }
$deploymentRequest = [System.Net.WebRequest]::Create("http://${address}:$port/api/deployment")
$deploymentRequest.Proxy = $null
$deploymentRequest.Timeout = 5000
$deploymentResponse = $deploymentRequest.GetResponse()
try {
    $deploymentReader = New-Object System.IO.StreamReader($deploymentResponse.GetResponseStream())
    try { $deployment = $deploymentReader.ReadToEnd() | ConvertFrom-Json } finally { $deploymentReader.Dispose() }
} finally { $deploymentResponse.Close() }
if (($deployment.oaLoginEnabled -ne [bool]$CompanyOa) -or ($deployment.authenticationEnabled -ne [bool]$CompanyOa) -or $deployment.creditsEnabled -or $deployment.rolePortalsEnabled) {
    throw "The running service uses a different access mode. After active tasks finish, stop that service and start again with the intended CompanyOa option."
}
if ($CompanyOa) {
    Write-Output "Company OA pilot is ready at http://${address}:$port/. Enter through the company OA. IT must configure HTTPS and company-only network access before rollout."
} else {
    Write-Output "LAN trial is ready: http://${address}:$port/"
}
