[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$TaskTitle,

  [Parameter(Mandatory = $true)]
  [string]$TargetFile,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedText,

  [string]$ConversationTitle = "Gemini Worker",

  [int]$WaitTimeoutSeconds = 180,

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$handoff = Join-Path $PSScriptRoot "send-antigravity-handoff.ps1"
if (-not (Test-Path -LiteralPath $handoff)) {
  throw "send-antigravity-handoff.ps1 not found at $handoff"
}

$message = @"
[Gemini Worker Task] $TaskTitle

너는 보고자가 아니라 보조 작업자다.
수정 금지. 해석 금지. 요약 금지. 추가 명령 실행 금지.

작업:
아래 파일 하나만 확인하고 지정 문자열이 포함된 원문 한 줄만 반환해라.

파일:
$TargetFile

지정 문자열:
$ExpectedText

반드시 아래 3줄만 출력해라.
직접 실행/확인: $TargetFile
원문 결과: $ExpectedText
수정 여부: 수정 없음
"@

$arguments = @(
  "-ExecutionPolicy", "Bypass",
  "-File", $handoff,
  "-ConversationTitle", $ConversationTitle,
  "-Message", $message,
  "-WaitForResponse",
  "-WaitTimeoutSeconds", "$WaitTimeoutSeconds",
  "-StrictQuarantineResponse",
  "-ResponseMustContain", $ExpectedText
)

if ($DryRun) {
  $arguments += "-DryRun"
}

powershell @arguments
