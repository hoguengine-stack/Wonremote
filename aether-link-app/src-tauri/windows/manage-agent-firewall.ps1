param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall')]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [string]$AgentPath
)

$ErrorActionPreference = 'Stop'
$ruleName = 'WonRemote.Agent.Node.Inbound'
$existing = Get-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName -ErrorAction SilentlyContinue

if ($Mode -eq 'Uninstall') {
    if ($existing) {
        Remove-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName -ErrorAction Stop
    }
    return
}

$nodePath = Join-Path (Split-Path -Parent $AgentPath) 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) {
    throw "WonRemote Agent Node runtime is missing: $nodePath"
}

$rule = @{
    PolicyStore = 'PersistentStore'
    Name = $ruleName
    Direction = 'Inbound'
    Action = 'Allow'
    Program = $nodePath
    Profile = @('Private', 'Public')
    Protocol = 'Any'
    Enabled = 'True'
    ErrorAction = 'Stop'
}
if ($existing) {
    Set-NetFirewallRule @rule
} else {
    New-NetFirewallRule @rule -DisplayName 'WonRemote Agent (Node.js)' | Out-Null
}
