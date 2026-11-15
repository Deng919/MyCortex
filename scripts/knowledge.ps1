# Local source-checkout entry. All material paths and the store directory are explicit.
$ErrorActionPreference = 'Stop'
$knowledgePreloadUrl = [System.Uri]::new((Join-Path $PSScriptRoot 'tsx.mjs')).AbsoluteUri
$knowledgeNodeArguments = @('--import', $knowledgePreloadUrl, (Join-Path $PSScriptRoot 'mycortex-knowledge.mts'), 'knowledge') + $args
$knowledgeProcessInfo = [Diagnostics.ProcessStartInfo]::new()
$knowledgeProcessInfo.FileName = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$knowledgeProcessInfo.UseShellExecute = $false
$knowledgeProcessInfo.WorkingDirectory = (Get-Location).ProviderPath
$knowledgeProcessInfo.RedirectStandardOutput = $true
$knowledgeProcessInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
# Windows argv quoting preserves literal quotes and trailing backslashes on both PS 5.1 and PS 7.
# ProcessStartInfo bypasses PS 5.1's lossy native argument serialization.
$knowledgeProcessInfo.Arguments = ($knowledgeNodeArguments | ForEach-Object {
    '"' + [regex]::Replace([regex]::Replace([string]$_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}) -join ' '
$knowledgeProcess = [Diagnostics.Process]::Start($knowledgeProcessInfo)
try {
    while (($knowledgeLine = $knowledgeProcess.StandardOutput.ReadLine()) -ne $null) {
        Write-Output $knowledgeLine
    }
    $knowledgeProcess.WaitForExit()
    $knowledgeExitCode = $knowledgeProcess.ExitCode
} finally {
    $knowledgeProcess.Dispose()
}
exit $knowledgeExitCode
