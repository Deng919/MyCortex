# Local source-checkout entry. All material paths and the store directory are explicit.
$ErrorActionPreference = 'Stop'
$knowledgePreloadUrl = [System.Uri]::new((Join-Path $PSScriptRoot 'tsx.mjs')).AbsoluteUri
& node --import $knowledgePreloadUrl (Join-Path $PSScriptRoot 'mycortex-knowledge.mts') knowledge @args
exit $LASTEXITCODE
