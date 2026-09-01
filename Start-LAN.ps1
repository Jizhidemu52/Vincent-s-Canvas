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

$config = Get-NetIPConfiguration |
    Where-Object { ($null -ne $_.IPv4DefaultGateway) -and ($null -ne $_.IPv4Address) } |
    Sort-Object { $_.IPv4Address.PrefixLength } |
    Select-Object -First 1
if ($null -eq $config) {
    Write-Error "No active LAN IPv4 connection was found."
    exit 1
}

$network = Get-NetConnectionProfile -InterfaceIndex $config.InterfaceIndex -ErrorAction Stop
$firewallProfile = if ($network.NetworkCategory -eq "Private") { "Private" } else { "Public" }
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($null -eq $existingRule) {
    try {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile $firewallProfile -RemoteAddress LocalSubnet | Out-Null
    }
    catch {
        Write-Warning "Windows blocked the LAN firewall rule. Run Start-LAN.bat once as administrator, then restart it normally."
        exit 1
    }
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
    Start-Process -FilePath $bun.Source -ArgumentList "src/demo-server.ts" -WorkingDirectory $serverRoot -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

$address = $config.IPv4Address.IPAddress
Write-Output "LAN trial is ready: http://${address}:$port/"
