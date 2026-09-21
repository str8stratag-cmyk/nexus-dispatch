[CmdletBinding()]
param(
  [string]$OutputPath = "",
  [string]$Text = "Unit one responding to emergency at Main Street and Fifth Avenue. Suspect is fleeing northbound on foot."
)

$ErrorActionPreference = "Stop"

$repoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { Get-Location }
if (-not $OutputPath) {
  $OutputPath = Join-Path $repoRoot "test-audio.wav"
}

$resolvedPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile($resolvedPath)
$synth.Speak($Text)
$synth.SetOutputToDefaultAudioDevice()
$synth.Dispose()
Write-Host "Created test audio: $resolvedPath"
