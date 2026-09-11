Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverRoot = Join-Path $root "server"
$webRoot = Join-Path $root "web\\dist"
$ruleName = "Wireless Canvas LAN Pilot TCP 5188 LocalSubnet"
$port = 5188

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
    Write-Output "Wireless Canvas is already listening on port $port."
}
else {
    $env:LOCAL_STANDALONE = "true"
    $env:STANDALONE_WEB_DIR = $webRoot
    $env:DEMO_PORT = "$port"
    $env:DEMO_HOST = "0.0.0.0"
    $logRoot = Join-Path $serverRoot ".data"
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    Start-Process -FilePath $bun.Source -ArgumentList "src/demo-server.ts" -WorkingDirectory $serverRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot "lan-server.out.log") -RedirectStandardError (Join-Path $logRoot "lan-server.err.log")
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
if (!$ready) { throw "LAN service health check failed. Check server/.data/lan-server.err.log and the process on port $port." }
Write-Output "LAN trial is ready: http://${address}:$port/"
