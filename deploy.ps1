# Deploy this static site to GitHub Pages.
#
# Usage (run from the web/ folder):
#     .\deploy.ps1 -Repo https://github.com/<your-name>/kaoyan-english2-vocab.git
#
# The first push asks you to sign in to GitHub. Git opens a browser window,
# you authorize once, and this machine remembers it afterwards.
#
# NOTE: this file is deliberately PURE ASCII with LF line endings.
# Windows PowerShell 5.1 reads .ps1 using the OEM code page, so non-ASCII
# bytes (e.g. Chinese comments) get mis-decoded and can break the parser
# outright. Keep all text here in English.

param(
  [Parameter(Mandatory = $true)]
  [string]$Repo,

  [string]$Branch = 'main',

  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
  Write-Host ''
  Write-Host ('  [ERROR] ' + $msg) -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host '  GitHub Pages deploy' -ForegroundColor Cyan
Write-Host '  ----------------------------------------'

# Must run from web/ (needs index.html and a git repo here).
if (-not (Test-Path 'index.html') -or -not (Test-Path '.git')) {
  Fail 'Run this from the web/ folder (needs index.html and .git).'
}

# Warn if the built files are older than the sources.
$root = Split-Path -Parent $PSScriptRoot
$pairs = @(
  @{ src = 'public\app.mjs';      out = 'app.mjs' },
  @{ src = 'public\schedule.mjs'; out = 'schedule.mjs' },
  @{ src = 'public\style.css';    out = 'style.css' },
  @{ src = 'public\index.html';   out = 'index.html' }
)
$stale = @()
foreach ($p in $pairs) {
  $s = Join-Path $root $p.src
  $o = Join-Path $PSScriptRoot $p.out
  if ((Test-Path $s) -and (Test-Path $o)) {
    if ((Get-Item $s).LastWriteTime -gt (Get-Item $o).LastWriteTime) { $stale += $p.out }
  }
}
if ($stale.Count -gt 0) {
  Write-Host ('  [WARN] stale build: ' + ($stale -join ', ')) -ForegroundColor Yellow
  Write-Host '         run: node tools/build-web.mjs' -ForegroundColor Yellow
}

# Point origin at the given repo.
$existing = ''
try { $existing = (git remote get-url origin 2>$null) } catch { $existing = '' }
if ($existing -ne $Repo) {
  if ($existing) { git remote set-url origin $Repo } else { git remote add origin $Repo }
  Write-Host ('  remote set    ' + $Repo)
} else {
  Write-Host ('  remote ok     ' + $Repo)
}

# Commit whatever changed.
git add -A
$pending = git status --porcelain
if ($pending) {
  if (-not $Message) { $Message = 'update site ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
  git commit -q -m $Message
  Write-Host ('  committed     ' + $Message)
} else {
  Write-Host '  committed     (nothing new)'
}

# Push.
$current = git rev-parse --abbrev-ref HEAD
if ($current -ne $Branch) {
  git branch -M $Branch
  Write-Host ('  branch        renamed to ' + $Branch)
}

Write-Host '  pushing...'
git push -u origin $Branch
if ($LASTEXITCODE -ne 0) {
  Fail 'Push failed. If it asked for credentials and you cancelled, just run this script again.'
}

Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
Write-Host '  GitHub Pages takes about a minute to publish.'
Write-Host '  Site: https://<your-username>.github.io/kaoyan-english2-vocab/'
Write-Host ''
Write-Host '  Enable Pages first if you have not: repo -> Settings -> Pages'
Write-Host ('    Source: Deploy from a branch | Branch: ' + $Branch + ' / (root) | Save')
Write-Host ''
