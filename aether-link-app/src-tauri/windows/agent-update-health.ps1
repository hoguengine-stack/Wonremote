# Availability proof only. Signed payload and protected-task checks remain separate.
function Test-AgentOnlineReceipt($Receipt, $Process, [string]$Root, [string]$Version, $Identity, [datetime]$Since) {
  try {
    if (-not $Receipt -or -not $Process -or -not $Identity -or
        [string]::IsNullOrWhiteSpace([string]$Identity.registeredDeviceId) -or
        [string]::IsNullOrWhiteSpace([string]$Identity.installId) -or
        $Receipt.schemaVersion -ne 1 -or $Receipt.version -cne $Version -or
        $Receipt.deviceId -cne $Identity.registeredDeviceId -or $Receipt.installId -cne $Identity.installId -or
        $Receipt.pid -ne $Process.ProcessId) { return $false }
    $expectedNode = [IO.Path]::GetFullPath((Join-Path $Root 'runtime\node.exe'))
    $actualNode = [IO.Path]::GetFullPath([string]$Process.ExecutablePath)
    $receiptNode = [IO.Path]::GetFullPath([string]$Receipt.executablePath)
    if (-not $expectedNode.Equals($actualNode, [StringComparison]::OrdinalIgnoreCase) -or
        -not $expectedNode.Equals($receiptNode, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$Process.CommandLine -notmatch '(?i)[\\/]agent[\\/]index\.mjs' -or
        [string]$Process.CommandLine -notmatch '(?i)(^|\s)--watch(\s|$)') { return $false }
    $created = ([datetime]$Process.CreationDate).ToUniversalTime()
    $started = ([datetime]$Receipt.startedAt).ToUniversalTime()
    $accepted = ([datetime]$Receipt.acceptedAt).ToUniversalTime()
    return $created -ge $Since.ToUniversalTime() -and
      [Math]::Abs(($created - $started).TotalSeconds) -lt 3 -and
      $accepted -ge $created -and $accepted -le [datetime]::UtcNow.AddSeconds(5)
  } catch { return $false }
}

function Wait-AgentOnlineReceipt([string]$ReceiptPath, [string]$Root, [string]$Version, $Identity, [datetime]$Since) {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $receipt = Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
      $runtimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$receipt.pid)" -ErrorAction Stop
      if (Test-AgentOnlineReceipt $receipt $runtimeProcess $Root $Version $Identity $Since) { return }
    } catch { }
    if ($attempt -lt 59) { Start-Sleep -Seconds 1 }
  }
  throw "Agent online verification failed: target version, original identity and fresh server heartbeat were not confirmed. Previous files are retained."
}
