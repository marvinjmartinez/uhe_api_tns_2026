@echo off
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI\"
set "DEPLOY_CONFIG_FILE=%SCRIPT_DIR%deploy-config.json"
set "DEPLOY_CONFIG_LOADER=%SCRIPT_DIR%load-deploy-config.ps1"
for %%I in ("%SCRIPT_DIR%\..\..\..\..") do set "DERIVED_INSTALL_ROOT=%%~fI"
for %%I in ("%SCRIPT_DIR%\..\..") do set "SOURCE_APP_DIR=%%~fI"
set "CONFIG_SOURCE_APP_DIR="
set "CONFIG_INSTALL_PATH="
set "CONFIG_SERVICE_NAME="
set "CONFIG_ENV_FILE="

call :LoadDeployConfig

set "INSTALL_PATH=C:\tns-local-api-service"
if defined CONFIG_INSTALL_PATH set "INSTALL_PATH=%CONFIG_INSTALL_PATH%"
set "SERVICE_NAME=TNSLocalAPI"
if defined CONFIG_SERVICE_NAME set "SERVICE_NAME=%CONFIG_SERVICE_NAME%"
set "ENV_FILE=.env.api"
if defined CONFIG_ENV_FILE set "ENV_FILE=%CONFIG_ENV_FILE%"
set "SOURCE_ENV_FILE=%SOURCE_APP_DIR%\%ENV_FILE%"
set "LOG_DIR=%SCRIPT_DIR%logs"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"`) do if not defined LOG_STAMP set "LOG_STAMP=%%~A"
if not defined LOG_STAMP set "LOG_STAMP=%RANDOM%"
set "LOG_FILE=%LOG_DIR%\uninstall-api-query-%LOG_STAMP%.log"
set "LOG_CONTEXT=[API_QUERY][UNINSTALL]"
set "SCRIPT_NAME=uninstall-api-query.bat"
for %%I in ("%SCRIPT_DIR%\..\..\..\..") do set "PROJECT_ROOT=%%~fI"
set "LOCK_HELPER=%PROJECT_ROOT%\scripts\windows\Get-LockingProcesses.ps1"

if defined TNS_INSTALL_PATH (
  set "INSTALL_PATH=%TNS_INSTALL_PATH%"
) else (
  call :ResolveInstallPath
)
if defined TNS_SERVICE_NAME set "SERVICE_NAME=%TNS_SERVICE_NAME%"
set "LEGACY_DB_1=%INSTALL_PATH%\data\local-config.sqlite"
set "LEGACY_DB_2=%INSTALL_PATH%\apps\api\data\local-config-api.sqlite"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
type nul > "%LOG_FILE%"
call :Log "============================================================"
call :Log "Log initialized. Script=%SCRIPT_NAME%"
call :Log "Process=API_QUERY UNINSTALL"
call :Log "============================================================"

call :EnsureAdmin || goto :Abort
title TNS Uninstall - API Query
echo ============================================================
echo TNS Local API Query - Uninstall
echo ============================================================
call :Log "Starting uninstall of %SERVICE_NAME%."
call :Log "INSTALL_PATH=%INSTALL_PATH%"
call :Log "SOURCE_APP_DIR=%SOURCE_APP_DIR%"
echo Service: %SERVICE_NAME%
echo Path:    %INSTALL_PATH%
echo Log:     %LOG_FILE%
echo.

call :Step "Stopping and unregistering service"
call :StopAndRemoveService || goto :Abort
call :Step "Unlocking installation folder"
call :UnlockInstallPath
call :Step "Deleting local database files"
call :DeleteKnownDbFiles || goto :Abort

call :RefreshInstallPathState
if "%INSTALL_PATH_EXISTS%"=="1" (
  call :Step "Removing installation folder"
  call :RemoveInstallPathWithRetries || goto :Abort
)

call :EnsureInstallPathRemoved || goto :Abort
call :FinalProcessCleanup || goto :Abort
call :Log "Service %SERVICE_NAME% removed."
echo.
echo Service %SERVICE_NAME% removed.
echo Uninstall log: %LOG_FILE%
call :ShowStatus
goto :Success

:StopAndRemoveService
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
call :ServiceExists
if "%SERVICE_EXISTS%"=="0" exit /b 0
if exist "%INSTALL_PATH%\nssm.exe" (
  call :Log "Stopping service with local NSSM."
  "%INSTALL_PATH%\nssm.exe" stop "%SERVICE_NAME%" >> "%LOG_FILE%" 2>&1
) else (
  call :Log "Stopping service with sc.exe."
  sc.exe stop "%SERVICE_NAME%" >> "%LOG_FILE%" 2>&1
)
call :WaitForServiceState STOPPED 15
if errorlevel 1 call :KillServiceProcessByName "%SERVICE_NAME%"
call :WaitForServiceState STOPPED 10 >nul 2>&1

if exist "%INSTALL_PATH%\nssm.exe" (
  call :Log "Removing service with local NSSM."
  "%INSTALL_PATH%\nssm.exe" remove "%SERVICE_NAME%" confirm >> "%LOG_FILE%" 2>&1
  if errorlevel 1 (call :Fail "NSSM remove failed." & exit /b 1)
) else (
  where nssm.exe >nul 2>&1
  if not errorlevel 1 (
    call :Log "Removing service with NSSM from PATH."
    nssm.exe remove "%SERVICE_NAME%" confirm >> "%LOG_FILE%" 2>&1
    if errorlevel 1 (call :Fail "NSSM remove from PATH failed." & exit /b 1)
  ) else (
    call :Log "Removing service with sc.exe delete."
    sc.exe delete "%SERVICE_NAME%" >> "%LOG_FILE%" 2>&1
    if errorlevel 1 (call :Fail "sc.exe delete failed." & exit /b 1)
  )
)
call :WaitForServiceDeleted 45
if errorlevel 1 (call :Fail "Service still exists after removal attempt." & exit /b 1)
exit /b 0

:ServiceExists
if /I "%TNS_SKIP_SERVICE%"=="1" (
  set "SERVICE_EXISTS=0"
  exit /b 0
)
set "SERVICE_EXISTS=0"
sc.exe query "%SERVICE_NAME%" >nul 2>&1
if not errorlevel 1 set "SERVICE_EXISTS=1"
exit /b 0

:ResolveInstallPath
if exist "%DERIVED_INSTALL_ROOT%\nssm.exe" if exist "%DERIVED_INSTALL_ROOT%\%ENV_FILE%" (
  set "INSTALL_PATH=%DERIVED_INSTALL_ROOT%"
  exit /b 0
)
if defined CONFIG_INSTALL_PATH exit /b 0
call :LoadInstallPathFromEnv "%SOURCE_ENV_FILE%"
exit /b 0

:LoadInstallPathFromEnv
set "ENV_CONFIG_FILE=%~1"
set "ENV_INSTALL_PATH="
if not defined ENV_CONFIG_FILE exit /b 0
if not exist "%ENV_CONFIG_FILE%" exit /b 0
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$path = '%ENV_CONFIG_FILE%'; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path | Where-Object { $_ -notmatch '^\s*(#|$)' } | ForEach-Object { $parts = $_ -split '=', 2; if ($parts.Count -eq 2 -and $parts[0].Trim() -eq 'INSTALL_PATH') { $parts[1].Trim() } } | Select-Object -First 1 }"`) do if not defined ENV_INSTALL_PATH set "ENV_INSTALL_PATH=%%~A"
if not defined ENV_INSTALL_PATH exit /b 0
set "ENV_INSTALL_PATH=%ENV_INSTALL_PATH:"=%"
for %%I in ("%ENV_INSTALL_PATH%") do set "INSTALL_PATH=%%~fI"
exit /b 0

:WaitForServiceState
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
set "WAIT_STATE=%~1"
set "WAIT_SECONDS=%~2"
if not defined WAIT_SECONDS set "WAIT_SECONDS=30"
for /L %%N in (1,1,%WAIT_SECONDS%) do (
  sc.exe query "%SERVICE_NAME%" | findstr /I /C:"STATE" | findstr /I /C:"%WAIT_STATE%" >nul 2>&1
  if not errorlevel 1 exit /b 0
  timeout /t 1 /nobreak >nul
)
exit /b 1

:WaitForServiceDeleted
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
set "WAIT_SECONDS=%~1"
if not defined WAIT_SECONDS set "WAIT_SECONDS=30"
for /L %%N in (1,1,%WAIT_SECONDS%) do (
  sc.exe query "%SERVICE_NAME%" >nul 2>&1
  if errorlevel 1 exit /b 0
  timeout /t 1 /nobreak >nul
)
exit /b 1

:KillPathProcesses
set "KILL_PATH=%~1"
if not defined KILL_PATH exit /b 0
call :Log "Stopping remaining processes that reference %KILL_PATH%."
powershell -NoProfile -Command "$path = '%KILL_PATH%'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm|cmd|conhost)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
exit /b 0

:RefreshInstallPathState
set "INSTALL_PATH_EXISTS=0"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$path = '%INSTALL_PATH%'; if (Test-Path -LiteralPath $path) { '1' } else { '0' }"`) do set "INSTALL_PATH_EXISTS=%%~A"
if not defined INSTALL_PATH_EXISTS set "INSTALL_PATH_EXISTS=0"
exit /b 0

:CountPathProcesses
set "COUNT_PATH=%~1"
set "PATH_PROCESS_COUNT=0"
if not defined COUNT_PATH exit /b 0
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$path = '%COUNT_PATH%'; @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) }).Count"`) do set "PATH_PROCESS_COUNT=%%~A"
if not defined PATH_PROCESS_COUNT set "PATH_PROCESS_COUNT=0"
exit /b 0

:DeleteKnownDbFiles
call :DeleteFileWithRetries "%LEGACY_DB_1%" || exit /b 1
call :DeleteFileWithRetries "%LEGACY_DB_2%" || exit /b 1
exit /b 0

:DeleteFileWithRetries
set "TARGET_FILE=%~1"
if not defined TARGET_FILE exit /b 0
if not exist "%TARGET_FILE%" exit /b 0
for /L %%N in (1,1,5) do (
  call :Log "Deleting file %TARGET_FILE%. Attempt %%N of 5."
  del /f /q "%TARGET_FILE%" >> "%LOG_FILE%" 2>&1
  if not exist "%TARGET_FILE%" exit /b 0
  call :KillProcessesLockingFile "%TARGET_FILE%"
  powershell -NoProfile -Command "$path = '%INSTALL_PATH%'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm|cmd|conhost)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
  timeout /t 2 /nobreak >nul
)
call :Log "Processes locking %TARGET_FILE%:"
call :LogProcessesLockingFile "%TARGET_FILE%"
call :Fail "Could not delete locked file %TARGET_FILE%."
exit /b 1

:UnlockInstallPath
call :RefreshInstallPathState
if "%INSTALL_PATH_EXISTS%"=="0" exit /b 0
call :Log "Unlocking installation path %INSTALL_PATH%."
call :KillPathProcesses "%INSTALL_PATH%"
call :KillProcessesLockingPath "%INSTALL_PATH%"
call :NormalizePathAttributes "%INSTALL_PATH%"
exit /b 0

:RemoveInstallPathWithRetries
call :RefreshInstallPathState
if "%INSTALL_PATH_EXISTS%"=="0" exit /b 0
for /L %%N in (1,1,5) do (
  set "CURRENT_ATTEMPT=%%N"
  echo [*] Removing installation folder ^(attempt !CURRENT_ATTEMPT!/5^)
  call :Log "Removing installation directory %INSTALL_PATH%. Attempt !CURRENT_ATTEMPT! of 5."
  call :UnlockInstallPath
  call :DeleteKnownDbFiles || exit /b 1
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Remove-Item -LiteralPath '%INSTALL_PATH%' -Recurse -Force -ErrorAction Stop } catch {}" >> "%LOG_FILE%" 2>&1
  if exist "%INSTALL_PATH%" rmdir /s /q "%INSTALL_PATH%" >> "%LOG_FILE%" 2>&1
  call :RefreshInstallPathState
  if "%INSTALL_PATH_EXISTS%"=="0" exit /b 0
  call :TryMoveInstallPathAway !CURRENT_ATTEMPT!
  call :RefreshInstallPathState
  if "%INSTALL_PATH_EXISTS%"=="0" exit /b 0
  call :Log "Removal attempt !CURRENT_ATTEMPT! did not fully delete %INSTALL_PATH%."
  call :LogProcessesLockingPath "%INSTALL_PATH%"
  timeout /t 2 /nobreak >nul
)
call :Log "Processes still locking %INSTALL_PATH% after all retries:"
call :LogProcessesLockingPath "%INSTALL_PATH%"
call :Fail "Could not remove %INSTALL_PATH%."
exit /b 1

:FinalProcessCleanup
call :Log "Running final process cleanup verification."
call :KillPathProcesses "%INSTALL_PATH%"
call :CountPathProcesses "%INSTALL_PATH%"
if "%PATH_PROCESS_COUNT%"=="0" exit /b 0
call :Log "Processes still reference %INSTALL_PATH% after cleanup. Count=%PATH_PROCESS_COUNT%."
timeout /t 2 /nobreak >nul
call :KillPathProcesses "%INSTALL_PATH%"
call :CountPathProcesses "%INSTALL_PATH%"
if "%PATH_PROCESS_COUNT%"=="0" exit /b 0
call :Log "Final process cleanup failed. Remaining count=%PATH_PROCESS_COUNT%."
call :Fail "Some processes still reference %INSTALL_PATH%."
exit /b 1

:TryMoveInstallPathAway
call :RefreshInstallPathState
if "%INSTALL_PATH_EXISTS%"=="0" exit /b 0
set "MOVE_ATTEMPT=%~1"
set "PENDING_DELETE_PATH=%TEMP%\tns-pending-delete-%SERVICE_NAME%-%LOG_STAMP%-%MOVE_ATTEMPT%"
call :Log "Attempting to move locked installation directory to %PENDING_DELETE_PATH%."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$source = '%INSTALL_PATH%'; $target = '%PENDING_DELETE_PATH%'; try { if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }; Move-Item -LiteralPath $source -Destination $target -Force -ErrorAction Stop } catch {}" >> "%LOG_FILE%" 2>&1
call :RefreshInstallPathState
if "%INSTALL_PATH_EXISTS%"=="1" exit /b 0
call :Log "Installation directory moved out of target path to %PENDING_DELETE_PATH%."
echo [*] Moved locked folder out of destination
call :DeleteMovedPathWithRetries "%PENDING_DELETE_PATH%"
exit /b 0

:DeleteMovedPathWithRetries
set "MOVED_PATH=%~1"
if not defined MOVED_PATH exit /b 0
if not exist "%MOVED_PATH%" exit /b 0
for /L %%N in (1,1,3) do (
  call :Log "Deleting moved directory %MOVED_PATH%. Attempt %%N of 3."
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Remove-Item -LiteralPath '%MOVED_PATH%' -Recurse -Force -ErrorAction Stop } catch {}" >> "%LOG_FILE%" 2>&1
  rmdir /s /q "%MOVED_PATH%" >> "%LOG_FILE%" 2>&1
  if not exist "%MOVED_PATH%" exit /b 0
  timeout /t 2 /nobreak >nul
)
call :Log "Moved directory still exists after retries: %MOVED_PATH%."
exit /b 0

:EnsureInstallPathRemoved
call :RefreshInstallPathState
if "%INSTALL_PATH_EXISTS%"=="0" exit /b 0
call :Log "Installation path still exists after uninstall flow: %INSTALL_PATH%"
call :LogProcessesLockingPath "%INSTALL_PATH%"
call :Fail "Installation folder still exists: %INSTALL_PATH%."
exit /b 1

:KillServiceProcessByName
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
set "SERVICE_PID="
for /f "tokens=3" %%A in ('sc.exe queryex "%~1" ^| findstr /R /C:"PID[ ]*:[ ]*[0-9][0-9]*"') do set "SERVICE_PID=%%A"
if defined SERVICE_PID if not "%SERVICE_PID%"=="0" (
  call :Log "Killing service PID %SERVICE_PID%."
  taskkill /PID %SERVICE_PID% /T /F >> "%LOG_FILE%" 2>&1
  timeout /t 2 /nobreak >nul
)
exit /b 0

:KillProcessesLockingFile
set "LOCK_FILE=%~1"
if not defined LOCK_FILE exit /b 0
if not exist "%LOCK_HELPER%" exit /b 0
call :Log "Stopping processes locking file %LOCK_FILE%."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items = & '%LOCK_HELPER%' '%LOCK_FILE%'; foreach ($item in $items) { try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
exit /b 0

:KillProcessesLockingPath
set "LOCK_PATH=%~1"
if not defined LOCK_PATH exit /b 0
if not exist "%LOCK_PATH%" exit /b 0
if not exist "%LOCK_HELPER%" exit /b 0
call :Log "Stopping processes locking path %LOCK_PATH%."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items = & '%LOCK_HELPER%' '%LOCK_PATH%'; foreach ($item in $items) { try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
exit /b 0

:LogProcessesLockingFile
set "LOCK_FILE=%~1"
if not defined LOCK_FILE exit /b 0
if not exist "%LOCK_HELPER%" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items = & '%LOCK_HELPER%' '%LOCK_FILE%'; if ($items) { $items | Format-Table -AutoSize }" >> "%LOG_FILE%" 2>&1
exit /b 0

:LogProcessesLockingPath
set "LOCK_PATH=%~1"
if not defined LOCK_PATH exit /b 0
if not exist "%LOCK_PATH%" exit /b 0
if not exist "%LOCK_HELPER%" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items = & '%LOCK_HELPER%' '%LOCK_PATH%'; if ($items) { $items | Format-Table -AutoSize }" >> "%LOG_FILE%" 2>&1
exit /b 0

:NormalizePathAttributes
set "NORMALIZE_PATH=%~1"
if not defined NORMALIZE_PATH exit /b 0
if not exist "%NORMALIZE_PATH%" exit /b 0
call :Log "Normalizing file attributes under %NORMALIZE_PATH%."
attrib -r -s -h "%NORMALIZE_PATH%" /s /d >> "%LOG_FILE%" 2>&1
if exist "%NORMALIZE_PATH%\*" attrib -r -s -h "%NORMALIZE_PATH%\*" /s /d >> "%LOG_FILE%" 2>&1
exit /b 0

:ShowStatus
call :Log "Showing related processes and recent logs."
echo.
echo Result summary:
echo Processes related to "%INSTALL_PATH%":
powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like '%INSTALL_PATH%*') -or ($_.Name -match '^(node|nssm)$' -and $_.CommandLine -and $_.CommandLine -like '*%INSTALL_PATH%*') } | Select-Object ProcessId, ExecutablePath, CommandLine | Format-Table -AutoSize"
echo.
echo -- Last lines of %LOG_FILE% --
powershell -NoProfile -Command "Get-Content '%LOG_FILE%' -Tail 80"
exit /b 0

:EnsureAdmin
if /I "%TNS_SKIP_ADMIN_CHECK%"=="1" exit /b 0
net session >nul 2>&1
if %errorlevel% equ 0 exit /b 0
call :Fail "Run this script as Administrator."
exit /b 1

:Success
call :Log "PROCESS RESULT: SUCCESS"
call :PauseBeforeClose
exit /b 0

:Abort
call :Log "PROCESS RESULT: FAILED"
call :PauseBeforeClose
exit /b 1

:Fail
call :Log "ERROR: %~1"
echo ERROR: %~1
exit /b 0

:Step
call :Log "STEP: %~1"
echo [*] %~1
exit /b 0

:Log
echo [%DATE% %TIME%] %LOG_CONTEXT% %~1>> "%LOG_FILE%"
exit /b 0

:LoadDeployConfig
if not exist "%DEPLOY_CONFIG_FILE%" exit /b 0
if not exist "%DEPLOY_CONFIG_LOADER%" exit /b 0
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%DEPLOY_CONFIG_LOADER%" "%DEPLOY_CONFIG_FILE%"`) do (
  if /I "%%~A"=="SOURCE_APP_DIR" set "CONFIG_SOURCE_APP_DIR=%%~B"
  if /I "%%~A"=="INSTALL_PATH" set "CONFIG_INSTALL_PATH=%%~B"
  if /I "%%~A"=="SERVICE_NAME" set "CONFIG_SERVICE_NAME=%%~B"
  if /I "%%~A"=="ENV_FILE" set "CONFIG_ENV_FILE=%%~B"
)
if defined CONFIG_SOURCE_APP_DIR set "SOURCE_APP_DIR=%CONFIG_SOURCE_APP_DIR%"
exit /b 0

:PauseBeforeClose
if /I "%TNS_NO_PAUSE%"=="1" exit /b 0
echo.
set /p "=Press any key to close this window... " <nul
pause >nul
exit /b 0
