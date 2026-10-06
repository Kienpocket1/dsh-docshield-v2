@echo off
setlocal
rem DocShield (che do Docker) cho MOT ban cai dat. Cau hinh rieng cua ban nay nam trong local.cmd
rem (chep tu local.example.cmd, khong dua vao git): prefix, cong, ten image, nguon du lieu.
rem Tham so: lan     = may khac trong mang LAN vao duoc (khong tin header IP)
rem          tunnel  = link https://....trycloudflare.com cho nguoi ngoai (can cloudflared)
rem          rebuild = build lai image sau khi sua code
rem Dong cua so nay la tat ca he thong cua ban nay.
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
if not exist "%REPO%\local.cmd" (
  echo [LOI] Chua co %REPO%\local.cmd. Chep local.example.cmd thanh local.cmd roi sua.
  goto :end
)
call "%REPO%\local.cmd"
if not defined TOOL_PREFIX goto :badcfg
if not defined GATE_PORT goto :badcfg
if not defined TOOL_MANAGER_PORT goto :badcfg
if not defined TOOL_IMAGE goto :badcfg
if not defined MAIN_IMAGE goto :badcfg
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

set "NET="
set "REBUILD="
for %%A in (%*) do (
  if /I "%%~A"=="lan" set "NET=lan"
  if /I "%%~A"=="tunnel" set "NET=tunnel"
  if /I "%%~A"=="rebuild" set "REBUILD=-Rebuild"
)

netstat -ano | findstr /R /C:":%GATE_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Ban %TOOL_PREFIX% DANG CHAY roi, hoac cong %GATE_PORT% dang bi chiem. Mo: http://127.0.0.1:%GATE_PORT%
  goto :end
)
netstat -ano | findstr /R /C:"127.0.0.1:20128 .*LISTENING" >nul
if errorlevel 1 (
  echo [CANH BAO] 9Router chua chay tren 127.0.0.1:20128 - bot se khong tra loi duoc.
  echo.
)

set "GATE_PUBLISH=127.0.0.1:%GATE_PORT%"
if "%NET%"=="lan" set "GATE_PUBLISH=0.0.0.0:%GATE_PORT%"
if not "%NET%"=="tunnel" goto :tunnel_done
set "CLOUDFLARED=cloudflared"
if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" set "CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if exist "C:\Program Files\cloudflared\cloudflared.exe" set "CLOUDFLARED=C:\Program Files\cloudflared\cloudflared.exe"
"%CLOUDFLARED%" --version >nul 2>nul
if not errorlevel 1 goto :tunnel_start
echo [LOI] Chua cai cloudflared: winget install --id Cloudflare.cloudflared
goto :end
:tunnel_start
set "GATE_TRUST_PROXY=1"
start "Cloudflare Tunnel %TOOL_PREFIX% - link nam trong cua so nay" "%CLOUDFLARED%" tunnel --url http://127.0.0.1:%GATE_PORT%
:tunnel_done

echo Kiem tra Docker, image va du lieu cua ban %TOOL_PREFIX%...
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\exec-router\ensure-docker.ps1" %REBUILD% -Prefix "%TOOL_PREFIX%" -ToolImage "%TOOL_IMAGE%" -MainImage "%MAIN_IMAGE%" -RuntimeDir "%RUNTIME_DIR%" -DshSource "%DSH_SOURCE%" -ModelFrom "%MODEL_FROM%"
if errorlevel 1 goto :end

echo Dang khoi dong ban %TOOL_PREFIX%:
echo   - Dang nhap tai:  http://127.0.0.1:%GATE_PORT%  (lan dau: trang /gate/setup, ma thiet lap in ben duoi)
echo   - Tao tai khoan:  docker exec -it -e GATE_VAR_DIR=/var/gate %TOOL_PREFIX%-dsh-main node /opt/plugins/dsh-gate/bin/gate.mjs user add ^<ten^>
echo   - Dong cua so nay de tat.
echo.
cd /d "%REPO%"
"%NODE_EXE%" exec-router\tool-manager.mjs
goto :end

:badcfg
echo [LOI] local.cmd thieu bien: can TOOL_PREFIX, GATE_PORT, TOOL_MANAGER_PORT, TOOL_IMAGE, MAIN_IMAGE.

:end
echo.
echo [Nhan phim bat ky de dong cua so.]
pause >nul
endlocal
