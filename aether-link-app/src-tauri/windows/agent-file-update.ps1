param([string]$PayloadRoot, [int]$InstallerProcessId)

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
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $cursor = $self
  while ($cursor -and $seen.Count -lt 64 -and $seen.Add([int]$cursor.ProcessId)) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($cursor.ParentProcessId)"
    if (-not $parent -or ($parent.CreationDate -and $cursor.CreationDate -and
        [datetime]$parent.CreationDate -gt [datetime]$cursor.CreationDate)) { break }
    if ($InstallerProcessId -eq 0 -or [int]$parent.ProcessId -eq $InstallerProcessId) { return $parent.ExecutablePath }
    $cursor = $parent
  }
  throw 'The Agent file updater caller is not an ancestor of this helper.'
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
  & (Join-Path $PSScriptRoot 'stop-wonremote-processes.ps1') -Product Agent -InstallRoot $Root -InstallerProcessId $InstallerProcessId
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the Agent for file replacement.' }
}

function Get-UpdateFileHash([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($Path)
    try { [BitConverter]::ToString($algorithm.ComputeHash($stream)) }
    finally { $stream.Dispose() }
  } finally { $algorithm.Dispose() }
}

function Invoke-AgentFileUpdate([string]$Source) {
  $root = Resolve-AgentUpdateRoot
  if ((Get-Item -LiteralPath (Join-Path $root 'wonremote-viewer.exe')).VersionInfo.ProductVersion -cne '0.1.120') {
    throw 'The bridge can replace only a protected Agent 0.1.120 installation.'
  }
  $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\')
  Assert-UpdatePath $sourceRoot
  $files = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force)
  $required = @('wonremote-viewer.exe', 'agent\index.mjs', 'updater\index.mjs', 'server\index.mjs', 'runtime\node.exe', 'bin\wonremote-poc.exe')
  $entries = @()
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($sourceRoot.Length + 1)
    if ($relative -notmatch '^(wonremote-viewer\.exe|updater\\index\.mjs|(?:manage-agent-login-task|agent-update-health|update-handoff-broker|manage-agent-firewall)\.ps1|(?:agent|server|runtime|bin|node_modules|icons)\\[^:]+)$') {
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
  $handoffStage = Split-Path -Parent $env:WONREMOTE_HANDOFF_INSTALLER_PATH
  $transaction = Join-Path $handoffStage ('file-transaction-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $transaction | Out-Null
  $changes = [Collections.Generic.List[object]]::new()
  $keepBackup = $false
  try {
    Assert-UpdatePath $transaction
    $paths = for ($index = 0; $index -lt $entries.Count; $index++) {
      $entry = $entries[$index]
      if ($entry.Relative -ieq 'bin\wonremote-poc.exe' -and (Test-Path -LiteralPath $entry.Target -PathType Leaf)) {
        # The transition carries the original capture helper; a matching image can remain open.
        try { $installedHash = Get-UpdateFileHash $entry.Target } catch { $installedHash = $null }
        if ($installedHash -and $installedHash -ceq (Get-UpdateFileHash $entry.Source)) { continue }
      }
      $next = Join-Path $transaction "$index.new"
      Copy-Item -LiteralPath $entry.Source -Destination $next
      [pscustomobject]@{ Target = $entry.Target; Next = $next; Previous = (Join-Path $transaction "$index.old"); Added = $false }
    }

    # The outer handoff owns post-restart health. Undo an interrupted copy before returning to it.
    Stop-AgentForFileUpdate $root
    foreach ($change in $paths) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $change.Target) -Force | Out-Null
      $changes.Add($change)
      if (Test-Path -LiteralPath $change.Target -PathType Leaf) {
        [IO.File]::Replace($change.Next, $change.Target, $change.Previous)
      } else {
        [IO.File]::Move($change.Next, $change.Target)
        $change.Added = $true
      }
    }
  } catch {
    $failure = $_
    for ($index = $changes.Count - 1; $index -ge 0; $index--) {
      $change = $changes[$index]
      try {
        if (Test-Path -LiteralPath $change.Previous -PathType Leaf) {
          if (Test-Path -LiteralPath $change.Target -PathType Leaf) {
            [IO.File]::Replace($change.Previous, $change.Target, ($change.Previous + '.displaced'))
          } else {
            [IO.File]::Move($change.Previous, $change.Target)
          }
        } elseif ($change.Added) {
          Remove-Item -LiteralPath $change.Target -Force
        }
      } catch {
        $keepBackup = $true
        Write-Warning "Could not restore $($change.Target): $($_.Exception.Message)"
      }
    }
    if ($keepBackup) { throw "Agent file replacement recovery incomplete; protected backup retained at $transaction. $($failure.Exception.Message)" }
    throw $failure
  } finally {
    if (-not $keepBackup) {
      Assert-UpdatePath $transaction
      Remove-Item -LiteralPath $transaction -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try { Invoke-AgentFileUpdate $PayloadRoot; exit 0 }
  catch { Write-Error $_ -ErrorAction Continue; exit 1 }
}
