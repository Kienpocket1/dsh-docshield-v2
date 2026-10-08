# Make Docker Desktop usable, build this instance's three images if missing, and prepare its Docker
# volumes on first use: migrate a Windows runtime (-RuntimeDir) or start a clean instance
# (container/init-instance.mjs). Used by start.cmd (settings in local.cmd).
#   powershell -File exec-router\ensure-docker.ps1 [-Rebuild] [-Prefix docshield] [-ToolImage ...] [-MainImage ...] [-ProxyImage ...]
#                                                  [-RuntimeDir E:\...\runtime] [-DshSource E:\...\deepseek-harness]
#                                                  [-ModelFrom docshield-storage]
param(
  [switch]$Rebuild,
  [string]$Prefix = 'docshield',
  [string]$ToolImage = 'docshield-tools:dev',
  [string]$MainImage = 'docshield-dsh-main:dev',
  [string]$ProxyImage = 'docshield-egress-proxy:dev',
  # Windows runtime to copy on first use; empty = start a clean instance instead.
  [string]$RuntimeDir = '',
  # DeepSeek Harness source checkout (read only; container/prepare.mjs takes the SSH packages from it).
  [string]$DshSource = '',
  # Clean instance: Docker volume holding .docshield/models to copy the embedding model from (read only).
  [string]$ModelFrom = ''
)
# Not 'Stop': in Windows PowerShell 5.1 any stderr line from a native command (even with 2>$null)
# becomes a terminating error. Every docker/npm/node call below checks $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
if ($Prefix -notmatch '^[a-z][a-z0-9-]{1,20}$') { Write-Host "[LOI] Prefix khong hop le: $Prefix"; exit 1 }
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$docker = 'E:\Docker\DockerDesktop\resources\bin\docker.exe'
if (-not (Test-Path $docker)) { $docker = 'docker' }
$desktop = 'E:\Docker\DockerDesktop\Docker Desktop.exe'
if (-not (Test-Path $desktop)) { $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe' }

function Engine { & $docker version --format '{{.Server.Version}}' 2>$null }

# Docker Desktop on this machine breaks after an unclean stop ("engine.sock ... cannot be accessed").
# Order matters: stop every Docker process FIRST (a running one recreates the bad socket), then move
# the socket folders away, then start. A failed start can leave a fresh broken socket: do it twice.
function Repair-Start {
  Get-Process | Where-Object { $_.ProcessName -in @('Docker Desktop','com.docker.backend','com.docker.build','docker','vpnkit') } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  foreach ($d in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
    if (Test-Path -LiteralPath $d) { Rename-Item -LiteralPath $d -NewName ((Split-Path $d -Leaf) + '.stale-' + (Get-Date -Format yyyyMMddHHmmss)) }
  }
  Start-Process -FilePath $desktop
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Engine)) {
    if ((Get-Date) -gt $deadline) { return $false }
    Start-Sleep -Seconds 4
  }
  return $true
}

if (-not (Engine)) {
  Write-Host '  Docker chua chay: tat tien trinh Docker cu, don socket hong, mo lai...'
  if (-not (Repair-Start)) {
    Write-Host '  Lan 1 chua duoc, thu lai mot lan nua...'
    if (-not (Repair-Start)) { Write-Host '[LOI] Docker khong khoi dong duoc.'; exit 1 }
  }
}
Write-Host "  Docker san sang (engine $(Engine))."

Push-Location $repo
try {
  # The proxy image is node + one file: no docshield build or prepare step.
  foreach ($img in @(@{ tag = $ToolImage; file = 'container/tools.Dockerfile'; prep = $true }, @{ tag = $MainImage; file = 'container/dsh-main.Dockerfile'; prep = $true },
                     @{ tag = $ProxyImage; file = 'container/egress-proxy.Dockerfile'; prep = $false })) {
    & $docker image inspect $img.tag 2>$null | Out-Null
    if ($Rebuild -or $LASTEXITCODE -ne 0) {
      Write-Host "  Build $($img.tag) (lan dau mat vai phut)..."
      if ($img.prep) {
        npm --prefix docshield run build; if ($LASTEXITCODE -ne 0) { Write-Host '[LOI] build docshield that bai.'; exit 1 }
        if ($DshSource) { node container/prepare.mjs $DshSource } else { node container/prepare.mjs }
        if ($LASTEXITCODE -ne 0) { Write-Host '[LOI] prepare that bai (can ma nguon deepseek-harness, xem DSH_SOURCE trong local.cmd).'; exit 1 }
      }
      & $docker build -f $img.file -t $img.tag .; if ($LASTEXITCODE -ne 0) { Write-Host "[LOI] docker build $($img.tag) that bai."; exit 1 }
    }
  }
  # First run of this instance: its home volume is empty.
  & $docker volume inspect "$Prefix-home" 2>$null | Out-Null
  $hasHome = $LASTEXITCODE -eq 0 -and ((& $docker run --rm -v "${Prefix}-home:/h" alpine sh -c 'ls -A /h | head -1') -ne $null)
  if (-not $hasHome) {
    if ($RuntimeDir) {
      Write-Host "  Lan dau: chep du lieu tu $RuntimeDir vao volume $Prefix-* (khong xoa ban goc)..."
      node container/migrate.mjs --from $RuntimeDir --prefix $Prefix
    } else {
      Write-Host "  Lan dau: tao ban sach $Prefix-* (khong du lieu, khong tai khoan, khong khoa API)..."
      if ($ModelFrom) { node container/init-instance.mjs --prefix $Prefix --model-from $ModelFrom } else { node container/init-instance.mjs --prefix $Prefix }
    }
    if ($LASTEXITCODE -ne 0) { Write-Host '[LOI] chuan bi du lieu that bai.'; exit 1 }
  }
} finally { Pop-Location }
exit 0
