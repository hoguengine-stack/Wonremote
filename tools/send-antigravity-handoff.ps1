[CmdletBinding(DefaultParameterSetName = "NewConversation")]
param(
  [Parameter(ParameterSetName = "NewConversation", Mandatory = $true)]
  [string]$Prompt,

  [Parameter(ParameterSetName = "SendMessage", Mandatory = $true)]
  [string]$RecipientId,

  [Parameter(ParameterSetName = "SendMessage", Mandatory = $true)]
  [Parameter(ParameterSetName = "SendMessageByTitle", Mandatory = $true)]
  [string]$Message,

  [Parameter(ParameterSetName = "SendMessageByTitle", Mandatory = $true)]
  [string]$ConversationTitle,

  [Parameter(ParameterSetName = "NewConversation")]
  [ValidateSet("flash_lite", "flash", "pro")]
  [string]$Model = "flash",

  [Parameter(ParameterSetName = "NewConversation")]
  [string]$FallbackRecipientId = $env:ANTIGRAVITY_FALLBACK_RECIPIENT_ID,

  [Parameter(ParameterSetName = "NewConversation")]
  [string]$FallbackConversationTitle,

  [switch]$WaitForResponse,

  [int]$WaitTimeoutSeconds = 240,

  [switch]$StrictQuarantineResponse,

  [string]$ResponseMustContain,

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Get-AgentApiPath {
  $candidate = Join-Path $env:USERPROFILE ".gemini\antigravity\bin\agentapi.bat"
  if (Test-Path -LiteralPath $candidate) {
    return $candidate
  }

  throw "Antigravity agentapi.bat was not found at $candidate"
}

function Get-AntigravityLanguageServer {
  $processes = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "language_server.exe" -and
      $_.CommandLine -like "*--override_ide_name antigravity*"
    } |
    Sort-Object ProcessId -Descending

  if (-not $processes) {
    throw "Antigravity language_server.exe is not running."
  }

  $process = $processes | Select-Object -First 1
  $csrfMatch = [regex]::Match($process.CommandLine, "--csrf_token\s+([^\s]+)")
  if (-not $csrfMatch.Success) {
    throw "Could not read Antigravity CSRF token from language server command line."
  }

  [pscustomobject]@{
    ProcessId = [int]$process.ProcessId
    CsrfToken = $csrfMatch.Groups[1].Value
  }
}

function Invoke-AgentApi {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AgentApiPath,

    [Parameter(Mandatory = $true)]
    [string]$Address,

    [Parameter(Mandatory = $true)]
    [string]$CsrfToken,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $previousAddress = $env:ANTIGRAVITY_LS_ADDRESS
  $previousToken = $env:ANTIGRAVITY_CSRF_TOKEN

  try {
    $env:ANTIGRAVITY_LS_ADDRESS = $Address
    $env:ANTIGRAVITY_CSRF_TOKEN = $CsrfToken
    $output = & $AgentApiPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    [pscustomobject]@{
      ExitCode = $exitCode
      Output = ($output -join [Environment]::NewLine)
    }
  } finally {
    $env:ANTIGRAVITY_LS_ADDRESS = $previousAddress
    $env:ANTIGRAVITY_CSRF_TOKEN = $previousToken
  }
}

function Resolve-AntigravityConversationId {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Title
  )

  $knownConversations = [System.Collections.Generic.Dictionary[string,string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  $knownConversations["Low Latency Remote Desktop Plan"] = "9314a52e-d7de-48b0-a662-8b45e48d08c4"
  $knownConversations["너는 보조작업자야"] = "210cc7e0-19f1-4764-a88b-e542c6260963"
  $knownConversations["Gemini Worker"] = "210cc7e0-19f1-4764-a88b-e542c6260963"

  if ($knownConversations.ContainsKey($Title)) {
    return $knownConversations[$Title]
  }

  throw "Unknown Antigravity conversation title '$Title'. Add a knownConversations mapping in this script or use -RecipientId directly."
}

function Resolve-AgentApiAddress {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AgentApiPath,

    [Parameter(Mandatory = $true)]
    [int]$LanguageServerPid,

    [Parameter(Mandatory = $true)]
    [string]$CsrfToken
  )

  $ports = Get-NetTCPConnection -State Listen |
    Where-Object { $_.OwningProcess -eq $LanguageServerPid -and $_.LocalAddress -eq "127.0.0.1" } |
    Select-Object -ExpandProperty LocalPort -Unique |
    Sort-Object -Descending

  foreach ($port in $ports) {
    $address = "http://127.0.0.1:$port"
    $probe = Invoke-AgentApi `
      -AgentApiPath $AgentApiPath `
      -Address $address `
      -CsrfToken $CsrfToken `
      -Arguments @("get-conversation-metadata", "codex-readonly-probe")

    if ($probe.Output -like "*trajectory not found*") {
      return $address
    }
  }

  throw "Could not find a usable Antigravity agentapi listener for PID $LanguageServerPid."
}

function Get-ConversationDbPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ConversationId
  )

  Join-Path $env:USERPROFILE ".gemini\antigravity\conversations\$ConversationId.db"
}

function Get-LatestAntigravityStepIndex {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ConversationDbPath
  )

  if (-not (Test-Path -LiteralPath $ConversationDbPath)) {
    return 0
  }

  $script = @"
import sqlite3
from pathlib import Path
p = Path(r'''$ConversationDbPath''')
con = sqlite3.connect(f'file:{p}?mode=ro', uri=True)
row = con.execute('select coalesce(max(idx), 0) from steps').fetchone()
print(row[0] if row else 0)
"@
  $value = $script | python -
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read latest Antigravity step index from $ConversationDbPath"
  }
  [int]($value | Select-Object -Last 1)
}

function Wait-AntigravityResponse {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ConversationDbPath,

    [Parameter(Mandatory = $true)]
    [int]$AfterIndex,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds,

    [Parameter(Mandatory = $true)]
    [bool]$StrictQuarantine
    ,
    [string]$MustContain
  )

  $reader = Join-Path $PSScriptRoot "antigravity_response_reader.py"
  if (-not (Test-Path -LiteralPath $reader)) {
    throw "Antigravity response reader not found at $reader"
  }

  $arguments = @(
    $reader,
    "--db", $ConversationDbPath,
    "--after-idx", "$AfterIndex",
    "--timeout", "$TimeoutSeconds"
  )
  if ($StrictQuarantine) {
    $arguments += "--strict-quarantine"
  }
  if ($MustContain) {
    $arguments += @("--must-contain", $MustContain)
  }

  $json = & python @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Antigravity response reader failed."
  }
  Write-Output $json

  $response = $json | ConvertFrom-Json
  if (-not $response.found) {
    throw "Timed out waiting for Antigravity response after step $AfterIndex."
  }
  if ($StrictQuarantine -and -not $response.compliant) {
    throw "Antigravity response violated Quarantine Mode: $($response.violations -join '; ')"
  }
}

$agentApiPath = Get-AgentApiPath
$languageServer = Get-AntigravityLanguageServer
$address = Resolve-AgentApiAddress `
  -AgentApiPath $agentApiPath `
  -LanguageServerPid $languageServer.ProcessId `
  -CsrfToken $languageServer.CsrfToken

if ($ConversationTitle) {
  $RecipientId = Resolve-AntigravityConversationId -Title $ConversationTitle
}

if ($FallbackConversationTitle) {
  $FallbackRecipientId = Resolve-AntigravityConversationId -Title $FallbackConversationTitle
}

if ($DryRun) {
  if ($PSCmdlet.ParameterSetName -eq "SendMessage" -or $PSCmdlet.ParameterSetName -eq "SendMessageByTitle") {
    Write-Output "DRY RUN: send-message to recipient '$RecipientId' via $address"
  } else {
    Write-Output "DRY RUN: new-conversation with model '$Model' via $address"
    if ($FallbackRecipientId) {
      Write-Output "DRY RUN: fallback send-message to recipient '$FallbackRecipientId' if new-conversation requires project_id"
    }
  }
  exit 0
}

$responseDbPath = $null
$responseAfterIndex = 0
if ($WaitForResponse) {
  if (-not $RecipientId) {
    throw "-WaitForResponse requires an existing Antigravity recipient/conversation id."
  }
  $responseDbPath = Get-ConversationDbPath -ConversationId $RecipientId
  $responseAfterIndex = Get-LatestAntigravityStepIndex -ConversationDbPath $responseDbPath
}

if ($PSCmdlet.ParameterSetName -eq "SendMessage" -or $PSCmdlet.ParameterSetName -eq "SendMessageByTitle") {
  $result = Invoke-AgentApi `
    -AgentApiPath $agentApiPath `
    -Address $address `
    -CsrfToken $languageServer.CsrfToken `
    -Arguments @("send-message", $RecipientId, $Message)
} else {
  $result = Invoke-AgentApi `
    -AgentApiPath $agentApiPath `
    -Address $address `
    -CsrfToken $languageServer.CsrfToken `
    -Arguments @("new-conversation", "--model=$Model", $Prompt)

  if (
    $result.ExitCode -ne 0 -and
    $FallbackRecipientId -and
    $result.Output -like "*project_id is required when providing project_env_config*"
  ) {
    Write-Warning "Antigravity new-conversation requires an internal project_id that agentapi does not expose. Falling back to send-message recipient '$FallbackRecipientId'."
    $result = Invoke-AgentApi `
      -AgentApiPath $agentApiPath `
      -Address $address `
      -CsrfToken $languageServer.CsrfToken `
      -Arguments @("send-message", $FallbackRecipientId, $Prompt)
  }

  if (
    $result.ExitCode -ne 0 -and
    $result.Output -like "*project_id is required when providing project_env_config*"
  ) {
    throw "Antigravity new-conversation failed because project_id is required, but agentapi exposes no project_id flag. Use -RecipientId/-Message for an existing Antigravity conversation, or pass -FallbackRecipientId/set ANTIGRAVITY_FALLBACK_RECIPIENT_ID."
  }
}

Write-Output $result.Output

if ($WaitForResponse) {
  Wait-AntigravityResponse `
    -ConversationDbPath $responseDbPath `
    -AfterIndex $responseAfterIndex `
    -TimeoutSeconds $WaitTimeoutSeconds `
    -StrictQuarantine ([bool]$StrictQuarantineResponse) `
    -MustContain $ResponseMustContain
}

exit $result.ExitCode
