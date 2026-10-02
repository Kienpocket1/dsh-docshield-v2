# Make Docker Desktop usable, build the two images if missing, migrate the
# Windows runtime into the Docker volumes on first use. Used by start-gate.cmd docker.
#   powershell -File exec-router\ensure-docker.ps1 [-Rebuild]
param([switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$docker = 'E:\Docker\DockerDesktop\resources\bin\docker.exe'
if (-not (Test-Path $docker)) { $docker = 'docker' }
$desktop = 'E:\Docker\DockerDesktop\Docker Desktop.exe'
if (-not (Test-Path $desktop)) { $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe' }

function Engine { & $docker version --format '{{.Server.Version}}' 2>$null }

if (-not (Engine)) {
  Write-Host '  Docker chua chay: tat tien trinh Docker cu, don socket hong, mo lai...'
  # Order matters: a running Docker process recreates the broken socket right after a rename.
  Get-Process | Where-Object { $_.ProcessName -in @('Docker Desktop','com.docker.backend','com.docker.build','docker','vpnkit') } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  foreach ($d in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
    if (Test-Path -LiteralPath $d) { Rename-Item -LiteralPath $d -NewName ((Split-Path $d -Leaf) + '.stale-' + (Get-Date -Format yyyyMMddHHmmss)) }
  }
  Start-Process -FilePath $desktop
  $deadline = (Get-Date).AddMinutes(4)
  while (-not (Engine)) {
    if ((Get-Date) -gt $deadline) { Write-Host '[LOI] Docker khong khoi dong duoc sau 4 phut.'; exit 1 }
    Start-Sleep -Seconds 4
  }
}
Write-Host "  Docker san sang (engine $(Engine))."

Push-Location $repo
try {
  foreach ($img in @(@{ tag = 'docshield-tools:dev'; file = 'container/tools.Dockerfile' }, @{ tag = 'docshield-dsh-main:dev'; file = 'container/dsh-main.Dockerfile' })) {
    & $docker image inspect $img.tag 2>$null | Out-Null
    if ($Rebuild -or $LASTEXITCODE -ne 0) {
      Write-Host "  Build $($img.tag) (lan dau mat vai phut)..."
      npm --prefix docshield run build; if ($LASTEXITCODE -ne 0) { Write-Host '[LOI] build docshield that bai.'; exit 1 }
      node container/prepare.mjs; if ($LASTEXITCODE -ne 0) { Write-Host '[LOI] prepare that bai (can E:\Deepseek_Harness\deepseek-harness).'; exit 1 }
      & $docker build -f $img.file -t $img.tag .; if ($LASTEXITCODE -ne 0) { Write-Host "[LOI] docker build $($img.tag) that bai."; exit 1 }
    }
  }
  # First container run: copy the Windows runtime (never deletes it).
  & $docker volume inspect docshield-home 2>$null | Out-Null
  $hasHome = $LASTEXITCODE -eq 0 -and ((& $docker run --rm -v docshield-home:/h alpine sh -c 'ls -A /h | head -1') -ne $null)
  if (-not $hasHome) {
    Write-Host '  Lan dau chay che do Docker: chep du lieu tu E:\Deepseek_Harness\runtime vao volume (khong xoa ban goc)...'
    node container/migrate.mjs --from E:\Deepseek_Harness\runtime --prefix docshield
    if ($LASTEXITCODE -ne 0) { Write-Host '[LOI] chep du lieu that bai.'; exit 1 }
  }
} finally { Pop-Location }
exit 0
