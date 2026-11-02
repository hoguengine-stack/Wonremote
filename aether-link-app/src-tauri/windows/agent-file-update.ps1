param([string]$PayloadRoot)

$ErrorActionPreference = 'Stop'

function Assert-UpdatePath([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  while ($null -ne $item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing a file update through a reparse point: $Path"
    }
    if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
  }
}

function Get-RegisteredAgentRoots {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
    try {
      $key = $hive.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\WonRemote Agent')
      if ($null -ne $key) {
        try { [string]$key.GetValue('InstallLocation', '') } finally { $key.Dispose() }
      }
    } finally { $hive.Dispose() }
  }
}

function Get-UpdateCallerPath {
  $self = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
  return (Get-CimInstance Win32_Process -Filter "ProcessId = $($self.ParentProcessId)").ExecutablePath
}

function Resolve-AgentUpdateRoot {
  $installer = $env:WONREMOTE_HANDOFF_INSTALLER_PATH
  if ([string]::IsNullOrWhiteSpace($installer) -or -not [IO.Path]::IsPathRooted($installer)) {
    throw 'An existing protected Agent update handoff is required; this is not a Setup.'
  }
  $installer = [IO.Path]::GetFullPath($installer)
  $stage = Split-Path -Parent $installer
  $handoff = Split-Path -Parent $stage
  $root = Split-Path -Parent $handoff
  if ((Split-Path -Leaf $installer) -ine 'installer.exe' -or
      (Split-Path -Leaf $stage) -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
      (Split-Path -Leaf $handoff) -ine '.update-handoff' -or
      (Get-UpdateCallerPath) -ine $installer) {
    throw 'The Agent file updater did not originate from the protected handoff.'
  }
  Assert-UpdatePath $installer
  $protected = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432) | Where-Object {
    $_ -and $root.StartsWith(([IO.Path]::GetFullPath($_).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)
  }
  $registered = @(Get-RegisteredAgentRoots | Where-Object {
    $_ -and [IO.Path]::GetFullPath($_.Trim('"')).TrimEnd('\') -ieq $root
  })
  if ($protected.Count -eq 0 -or $registered.Count -eq 0 -or
      -not (Test-Path -LiteralPath (Join-Path $root 'wonremote-viewer.exe') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $root 'update-handoff-broker.ps1') -PathType Leaf)) {
    throw 'No matching protected Agent installation exists. No files were changed.'
  }
  return $root
}

function Stop-AgentForFileUpdate([string]$Root) {
  & (Join-Path $PSScriptRoot 'stop-wonremote-processes.ps1') -Product Agent -InstallRoot $Root
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the Agent for file replacement.' }
}

function Invoke-AgentFileUpdate([string]$Source) {
  $root = Resolve-AgentUpdateRoot
  $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\')
  Assert-UpdatePath $sourceRoot
  $files = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force)
  $required = @('wonremote-viewer.exe', 'agent\index.mjs', 'server\index.mjs', 'runtime\node.exe', 'bin\wonremote-poc.exe')
  $entries = @()
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($sourceRoot.Length + 1)
    if ($relative -notmatch '^(wonremote-viewer\.exe|(?:manage-agent-login-task|agent-update-health|update-handoff-broker|manage-agent-firewall)\.ps1|(?:agent|server|runtime|bin|node_modules|icons)\\[^:]+)$') {
      throw "Unexpected Agent update entry: $relative"
    }
    $target = Join-Path $root $relative
    Assert-UpdatePath $file.FullName
    # Check existing ancestors even when the destination file does not exist yet.
    $ancestor = $target
    while (-not (Test-Path -LiteralPath $ancestor)) { $ancestor = Split-Path -Parent $ancestor }
    Assert-UpdatePath $ancestor
    $entries += [pscustomobject]@{ Source = $file.FullName; Target = $target; Relative = $relative }
  }
  foreach ($relative in $required) {
    if ($relative -notin $entries.Relative) { throw "Incomplete Agent update: $relative" }
  }
  # The independent handoff already owns the backup and post-restart online proof.
  Stop-AgentForFileUpdate $root
  foreach ($entry in $entries) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $entry.Target) -Force | Out-Null
    Copy-Item -LiteralPath $entry.Source -Destination $entry.Target -Force
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try { Invoke-AgentFileUpdate $PayloadRoot; exit 0 }
  catch { Write-Error $_ -ErrorAction Continue; exit 1 }
}
