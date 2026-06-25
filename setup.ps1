#Requires -Version 5.1
<#
  One-pass installer for Icarus on a clean Windows machine.
  No admin required except the final service registration (one UAC prompt).
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host '== 1/5  System tools via winget ==' -ForegroundColor Cyan
function Ensure-Winget($id) {
  $installed = winget list --id $id -e 2>$null | Select-String $id
  if (-not $installed) {
    winget install --id $id -e --scope user --accept-source-agreements --accept-package-agreements
  } else {
    Write-Host "  $id already present"
  }
}
Ensure-Winget 'OpenJS.NodeJS.LTS'
Ensure-Winget 'Python.Python.3.12'
Ensure-Winget 'Git.Git'

# Refresh PATH for this session so node/python/git resolve below.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','User') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path','Machine')

Write-Host '== 2/5  Node dependencies ==' -ForegroundColor Cyan
npm ci
npm run build

Write-Host '== 3/5  Python venv for document skills ==' -ForegroundColor Cyan
if (-not (Test-Path '.venv')) { python -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install python-docx openpyxl python-pptx pdfplumber pypdf pypdfium2

Write-Host '== 4/5  .env check ==' -ForegroundColor Cyan
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Warning 'Created .env from .env.example — fill it in (tokens, channel ids, CLAUDE_CODE_OAUTH_TOKEN) before starting the service.'
}

Write-Host '== 5/5  WinSW service ==' -ForegroundColor Cyan
$winsw = Join-Path $root 'service\WinSW.exe'
if (-not (Test-Path $winsw)) {
  $url = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
  Write-Host "  downloading WinSW from $url"
  Invoke-WebRequest -Uri $url -OutFile $winsw
}
Push-Location (Join-Path $root 'service')
& .\WinSW.exe install icarus.xml
Pop-Location
Write-Host 'Done. Fill in .env (if just created), then:  .\service\WinSW.exe start service\icarus.xml' -ForegroundColor Green
