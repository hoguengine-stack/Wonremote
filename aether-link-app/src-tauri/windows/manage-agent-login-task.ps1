param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Uninstall")]
  [string]$Mode,
  [string]$AgentPath
)

$ErrorActionPreference = "Stop"
$taskName = "WonRemote Agent"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)

if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "WonRemote 원격프로그램 설치 또는 업데이트입니다.`r`n다음 관리자 승인 창에서 '예'를 눌러주세요.",
    "WonRemote 업데이트",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode $Mode"
  if ($AgentPath) {
    $arguments += " -AgentPath `"$AgentPath`""
  }
  try {
    $process = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList $arguments
    exit $process.ExitCode
  } catch {
    Write-Error "Administrator approval is required to configure WonRemote Agent startup."
    exit 1
  }
}

if ($Mode -eq "Uninstall") {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

if (-not (Test-Path -LiteralPath $AgentPath -PathType Leaf)) {
  throw "WonRemote Agent executable was not found: $AgentPath"
}

$resolvedAgentPath = (Resolve-Path -LiteralPath $AgentPath).Path
$action = New-ScheduledTaskAction -Execute $resolvedAgentPath -Argument "--agent" -WorkingDirectory (Split-Path -Parent $resolvedAgentPath)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$task = Get-ScheduledTask -TaskName $taskName
if ($task.Principal.RunLevel -ne "Highest" -or $task.Actions.Execute -ne $resolvedAgentPath -or $task.Actions.Arguments -ne "--agent") {
  throw "WonRemote Agent scheduled task verification failed."
}
