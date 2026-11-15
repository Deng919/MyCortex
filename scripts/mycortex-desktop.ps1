param(
    [Parameter(Mandatory = $true)][string]$Store,
    [Parameter(Mandatory = $true)][string]$BrowserProfile
)
$ErrorActionPreference = 'Stop'
$desktopPreloadUrl = [System.Uri]::new((Join-Path $PSScriptRoot 'tsx.mjs')).AbsoluteUri
$desktopArguments = @('--import', $desktopPreloadUrl, (Join-Path $PSScriptRoot 'mycortex-desktop.mts'), '--store', $Store, '--open', '--profile', $BrowserProfile)
$desktopInfo = [Diagnostics.ProcessStartInfo]::new()
$desktopInfo.FileName = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$desktopInfo.UseShellExecute = $false
$desktopInfo.CreateNoWindow = $true
$desktopInfo.WorkingDirectory = (Split-Path $PSScriptRoot -Parent)
$desktopInfo.Arguments = ($desktopArguments | ForEach-Object {
    '"' + [regex]::Replace([regex]::Replace([string]$_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}) -join ' '
try {
    $desktopProcess = [Diagnostics.Process]::Start($desktopInfo)
    $desktopProcess.WaitForExit()
    if ($desktopProcess.ExitCode -ne 0) { throw 'MyCortex could not start. Run this script from PowerShell to see the error.' }
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'MyCortex') | Out-Null
} finally {
    if ($desktopProcess) { $desktopProcess.Dispose() }
}
