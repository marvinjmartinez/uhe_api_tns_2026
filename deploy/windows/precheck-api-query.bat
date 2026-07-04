@echo off
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI\"
set "DEPLOY_CONFIG_FILE=%SCRIPT_DIR%deploy-config.json"
set "DEPLOY_CONFIG_LOADER=%SCRIPT_DIR%load-deploy-config.ps1"
for %%I in ("%SCRIPT_DIR%\..\..\..\..") do set "PROJECT_ROOT=%%~fI"
for %%I in ("%SCRIPT_DIR%\..\..") do set "SOURCE_APP_DIR=%%~fI"
set "CONFIG_SOURCE_APP_DIR="
set "CONFIG_INSTALL_PATH="
set "CONFIG_SERVICE_NAME="
set "CONFIG_SERVICE_PORT="
set "CONFIG_ENV_FILE="

call :LoadDeployConfig

rem Allow explicit overrides, but default to paths derived from this running .bat
if defined TNS_PROJECT_ROOT (
  for %%I in ("%TNS_PROJECT_ROOT%") do set "PROJECT_ROOT=%%~fI"
)
if defined TNS_SOURCE_APP_DIR (
  for %%I in ("%TNS_SOURCE_APP_DIR%") do set "SOURCE_APP_DIR=%%~fI"
)
set "INSTALL_PATH=C:\tns-local-api-service"
if defined CONFIG_INSTALL_PATH set "INSTALL_PATH=%CONFIG_INSTALL_PATH%"
set "SERVICE_NAME=TNSLocalAPI"
if defined CONFIG_SERVICE_NAME set "SERVICE_NAME=%CONFIG_SERVICE_NAME%"
set "SERVICE_PORT=8086"
if defined CONFIG_SERVICE_PORT set "SERVICE_PORT=%CONFIG_SERVICE_PORT%"
set "FAIL=0"
set "ENV_FILE=.env.api"
if defined CONFIG_ENV_FILE set "ENV_FILE=%CONFIG_ENV_FILE%"
set "SOURCE_ENV_FILE=%SOURCE_APP_DIR%\%ENV_FILE%"
set "LOG_DIR=%SCRIPT_DIR%logs"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"`) do if not defined LOG_STAMP set "LOG_STAMP=%%~A"
if not defined LOG_STAMP set "LOG_STAMP=%RANDOM%"
set "LOG_FILE=%LOG_DIR%\precheck-api-query-%LOG_STAMP%.log"
set "LOG_CONTEXT=[API_QUERY][PRECHECK]"
set "SCRIPT_NAME=precheck-api-query.bat"

if defined TNS_INSTALL_PATH set "INSTALL_PATH=%TNS_INSTALL_PATH%"
if defined TNS_SERVICE_NAME set "SERVICE_NAME=%TNS_SERVICE_NAME%"
if defined TNS_SERVICE_PORT set "SERVICE_PORT=%TNS_SERVICE_PORT%"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
type nul > "%LOG_FILE%"
call :Log "============================================================"
call :Log "Log initialized. Script=%SCRIPT_NAME%"
call :Log "Process=API_QUERY PRECHECK"
call :Log "============================================================"

if not defined TNS_SOURCE_APP_DIR if not defined CONFIG_SOURCE_APP_DIR call :LoadSourceAppDirFromEnv "%SOURCE_ENV_FILE%"
if not defined TNS_INSTALL_PATH if not defined CONFIG_INSTALL_PATH call :LoadInstallPathFromEnv "%SOURCE_ENV_FILE%"
if not defined TNS_SERVICE_PORT if not defined CONFIG_SERVICE_PORT call :LoadServicePortFromEnv "%SOURCE_ENV_FILE%"

call :Log "Starting precheck for %SERVICE_NAME%."
call :Log "SCRIPT_DIR=%SCRIPT_DIR%"
call :Log "PROJECT_ROOT=%PROJECT_ROOT%"
call :Log "SOURCE_APP_DIR=%SOURCE_APP_DIR%"
if exist "%SOURCE_APP_DIR%\" (
  call :Log "listing %SOURCE_APP_DIR%:"
  for /f "delims=" %%A in ('dir /b "%SOURCE_APP_DIR%" 2^>nul') do call :Log "%%A"
) else (
  call :Log "source app dir does not exist: %SOURCE_APP_DIR%"
  call :Log "Use TNS_SOURCE_APP_DIR to point to the real source tree, for example:"
  call :Log "  set TNS_SOURCE_APP_DIR=E:\Desarrollo Actual\TNS-LOCAL\tns-local-API\apps\api"
)

call :EnsureAdmin || goto :Abort
call :CheckNode
call :CheckFile "%SCRIPT_DIR%nssm.exe" "deploy\\windows\\nssm.exe"
call :CheckFile "%SOURCE_APP_DIR%\server.js" "apps\\api\\server.js"
call :CheckFile "%SOURCE_APP_DIR%\localConfigStore.js" "apps\\api\\localConfigStore.js"
call :CheckFile "%SOURCE_APP_DIR%\package.json" "apps\\api\\package.json"
call :CheckFile "%SOURCE_APP_DIR%\package-lock.json" "apps\\api\\package-lock.json"
call :CheckFile "%SOURCE_APP_DIR%\.env.api" "apps\\api\\.env.api"
call :CheckFile "%SOURCE_APP_DIR%\.env.example" "apps\\api\\.env.example"
call :CheckInstallRoot
call :CheckPort %SERVICE_PORT%
call :CheckServiceState

if "%FAIL%"=="0" (
  call :Log "RESULT: READY"
  goto :Success
)
call :Log "RESULT: NOT READY"
goto :Abort

:CheckNode
where node >nul 2>&1
if errorlevel 1 (call :Log "FAIL node was not found in PATH" & set /a FAIL+=1 & goto :eof)
where npm.cmd >nul 2>&1
if errorlevel 1 (call :Log "FAIL npm.cmd was not found in PATH" & set /a FAIL+=1 & goto :eof)
for /f "delims=" %%A in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%~fA"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
for /f "tokens=1 delims=." %%A in ('"%NODE_EXE%" -v') do set "NODE_MAJOR=%%A"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if not defined NODE_MAJOR (call :Log "FAIL could not determine Node.js major version" & set /a FAIL+=1 & goto :eof)
if %NODE_MAJOR% LSS 18 (call :Log "FAIL Node.js 18 or newer is required" & set /a FAIL+=1) else call :Log "OK node version is compatible"
call :Log "OK npm.cmd"
goto :eof

:CheckFile
if exist "%~1" (call :Log "OK %~2") else (call :Log "FAIL %~2 not found" & set /a FAIL+=1)
goto :eof

:CheckInstallRoot
set "PRECHECK_DIR=%INSTALL_PATH%\__precheck__"
mkdir "%PRECHECK_DIR%" >nul 2>&1
if errorlevel 1 (call :Log "FAIL cannot create %PRECHECK_DIR%" & set /a FAIL+=1 & goto :eof)
rmdir "%PRECHECK_DIR%" >nul 2>&1
call :Log "OK install root is writable: %INSTALL_PATH%"
goto :eof

:CheckPort
set "PORT_IN_USE="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %~1; $tcp = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($tcp) { $tcp } else { $udp = Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($udp) { $udp } }"`) do set "PORT_IN_USE=%%A"
if defined PORT_IN_USE (
  call :Log "WARN port %~1 is already in use by PID %PORT_IN_USE%"
  set /a FAIL+=1
) else (
  call :Log "OK port %~1 is free"
)
goto :eof

:CheckServiceState
if /I "%TNS_SKIP_SERVICE%"=="1" (call :Log "OK service checks skipped because TNS_SKIP_SERVICE=1" & goto :eof)
sc.exe query "%SERVICE_NAME%" >nul 2>&1
if errorlevel 1 (call :Log "OK service %SERVICE_NAME% is not currently installed") else (call :Log "WARN service %SERVICE_NAME% already exists" & set /a FAIL+=1)
goto :eof

:LoadInstallPathFromEnv
set "ENV_CONFIG_FILE=%~1"
set "ENV_INSTALL_PATH="
if not defined ENV_CONFIG_FILE goto :eof
if not exist "%ENV_CONFIG_FILE%" goto :eof
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$path = '%ENV_CONFIG_FILE%'; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path | Where-Object { $_ -notmatch '^\s*(#|$)' } | ForEach-Object { $parts = $_ -split '=', 2; if ($parts.Count -eq 2 -and $parts[0].Trim() -eq 'INSTALL_PATH') { $parts[1].Trim() } } | Select-Object -First 1 }"`) do if not defined ENV_INSTALL_PATH set "ENV_INSTALL_PATH=%%~A"
if not defined ENV_INSTALL_PATH goto :eof
set "ENV_INSTALL_PATH=%ENV_INSTALL_PATH:"=%"
for %%I in ("%ENV_INSTALL_PATH%") do set "INSTALL_PATH=%%~fI"
call :Log "INSTALL_PATH loaded from %ENV_CONFIG_FILE%: %INSTALL_PATH%"
goto :eof

:LoadServicePortFromEnv
set "ENV_CONFIG_FILE=%~1"
set "ENV_SERVICE_PORT="
if not defined ENV_CONFIG_FILE goto :eof
if not exist "%ENV_CONFIG_FILE%" goto :eof
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$path = '%ENV_CONFIG_FILE%'; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path | Where-Object { $_ -notmatch '^\s*(#|$)' } | ForEach-Object { $parts = $_ -split '=', 2; if ($parts.Count -eq 2 -and $parts[0].Trim() -eq 'PORT') { $parts[1].Trim() } } | Select-Object -First 1 }"`) do if not defined ENV_SERVICE_PORT set "ENV_SERVICE_PORT=%%~A"
if not defined ENV_SERVICE_PORT goto :eof
set "ENV_SERVICE_PORT=%ENV_SERVICE_PORT:"=%"
set "SERVICE_PORT=%ENV_SERVICE_PORT%"
call :Log "SERVICE_PORT loaded from %ENV_CONFIG_FILE%: %SERVICE_PORT%"
goto :eof

:LoadSourceAppDirFromEnv
set "ENV_CONFIG_FILE=%~1"
set "ENV_SOURCE_APP_DIR="
if not defined ENV_CONFIG_FILE goto :eof
if not exist "%ENV_CONFIG_FILE%" goto :eof
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$path = '%ENV_CONFIG_FILE%'; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path | Where-Object { $_ -notmatch '^\s*(#|$)' } | ForEach-Object { $parts = $_ -split '=', 2; if ($parts.Count -eq 2 -and $parts[0].Trim() -eq 'SOURCE_APP_DIR') { $parts[1].Trim() } } | Select-Object -First 1 }"`) do if not defined ENV_SOURCE_APP_DIR set "ENV_SOURCE_APP_DIR=%%~A"
if not defined ENV_SOURCE_APP_DIR goto :eof
set "ENV_SOURCE_APP_DIR=%ENV_SOURCE_APP_DIR:"=%"
for %%I in ("%ENV_SOURCE_APP_DIR%") do set "SOURCE_APP_DIR=%%~fI"
set "SOURCE_ENV_FILE=%SOURCE_APP_DIR%\%ENV_FILE%"
call :Log "SOURCE_APP_DIR loaded from %ENV_CONFIG_FILE%: %SOURCE_APP_DIR%"
goto :eof

:EnsureAdmin
if /I "%TNS_SKIP_ADMIN_CHECK%"=="1" exit /b 0
net session >nul 2>&1
if %errorlevel% equ 0 exit /b 0
call :Log "ERROR Run this script as Administrator."
exit /b 1

:Success
call :Log "PROCESS RESULT: SUCCESS"
call :PauseBeforeClose
exit /b 0

:Abort
call :Log "PROCESS RESULT: FAILED"
call :PauseBeforeClose
exit /b 1

:PauseBeforeClose
if /I "%TNS_NO_PAUSE%"=="1" exit /b 0
echo.
set /p "=Press any key to close this window... " <nul
pause >nul
exit /b 0

:Log
echo [%DATE% %TIME%] %LOG_CONTEXT% %~1
>> "%LOG_FILE%" echo [%DATE% %TIME%] %LOG_CONTEXT% %~1
exit /b 0

:LoadDeployConfig
if not exist "%DEPLOY_CONFIG_FILE%" goto :eof
if not exist "%DEPLOY_CONFIG_LOADER%" goto :eof
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%DEPLOY_CONFIG_LOADER%" "%DEPLOY_CONFIG_FILE%"`) do (
  if /I "%%~A"=="SOURCE_APP_DIR" set "CONFIG_SOURCE_APP_DIR=%%~B"
  if /I "%%~A"=="INSTALL_PATH" set "CONFIG_INSTALL_PATH=%%~B"
  if /I "%%~A"=="SERVICE_NAME" set "CONFIG_SERVICE_NAME=%%~B"
  if /I "%%~A"=="SERVICE_PORT" set "CONFIG_SERVICE_PORT=%%~B"
  if /I "%%~A"=="ENV_FILE" set "CONFIG_ENV_FILE=%%~B"
)
if defined CONFIG_SOURCE_APP_DIR set "SOURCE_APP_DIR=%CONFIG_SOURCE_APP_DIR%"
goto :eof
