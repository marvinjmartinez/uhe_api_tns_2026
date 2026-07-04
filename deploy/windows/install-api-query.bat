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
set "CONFIG_SERVICE_DISPLAY_NAME="
set "CONFIG_SERVICE_PORT="
set "CONFIG_ENV_FILE="
set "CONFIG_ENV_EXAMPLE_FILE="
set "CONFIG_DB_FILE="

call :LoadDeployConfig

rem Allow explicit overrides, but default to paths derived from this running .bat
if defined TNS_PROJECT_ROOT (
  for %%I in ("%TNS_PROJECT_ROOT%") do set "PROJECT_ROOT=%%~fI"
)
if defined TNS_SOURCE_APP_DIR (
  for %%I in ("%TNS_SOURCE_APP_DIR%") do set "SOURCE_APP_DIR=%%~fI"
)
set "LOCK_HELPER=%PROJECT_ROOT%\scripts\windows\Get-LockingProcesses.ps1"
set "INSTALL_PATH=C:\tns-local-api-service"
if defined CONFIG_INSTALL_PATH set "INSTALL_PATH=%CONFIG_INSTALL_PATH%"
set "TARGET_APP_DIR=%INSTALL_PATH%\apps\api"
set "TARGET_LOG_DIR=%INSTALL_PATH%\logs"
set "SERVICE_NAME=TNSLocalAPI"
if defined CONFIG_SERVICE_NAME set "SERVICE_NAME=%CONFIG_SERVICE_NAME%"
set "SERVICE_DISPLAY_NAME=TNS Local API Query Service"
if defined CONFIG_SERVICE_DISPLAY_NAME set "SERVICE_DISPLAY_NAME=%CONFIG_SERVICE_DISPLAY_NAME%"
set "SERVICE_PORT=8086"
if defined CONFIG_SERVICE_PORT set "SERVICE_PORT=%CONFIG_SERVICE_PORT%"
set "ENV_FILE=.env.api"
if defined CONFIG_ENV_FILE set "ENV_FILE=%CONFIG_ENV_FILE%"
set "ENV_EXAMPLE_FILE=.env.example"
if defined CONFIG_ENV_EXAMPLE_FILE set "ENV_EXAMPLE_FILE=%CONFIG_ENV_EXAMPLE_FILE%"
set "SOURCE_ENV_FILE=%SOURCE_APP_DIR%\%ENV_FILE%"
set "DB_FILE=data\local-config-api.sqlite"
if defined CONFIG_DB_FILE set "DB_FILE=%CONFIG_DB_FILE%"
set "NSSM_EXE=%SCRIPT_DIR%nssm.exe"
set "LOG_DIR=%SCRIPT_DIR%logs"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"`) do if not defined LOG_STAMP set "LOG_STAMP=%%~A"
if not defined LOG_STAMP set "LOG_STAMP=%RANDOM%"
set "LOG_FILE=%LOG_DIR%\install-api-query-%LOG_STAMP%.log"
set "LOG_CONTEXT=[API_QUERY][INSTALL]"
set "SCRIPT_NAME=install-api-query.bat"

if defined TNS_INSTALL_PATH (
  set "INSTALL_PATH=%TNS_INSTALL_PATH%"
)
if defined TNS_SERVICE_NAME set "SERVICE_NAME=%TNS_SERVICE_NAME%"
if defined TNS_SERVICE_DISPLAY_NAME set "SERVICE_DISPLAY_NAME=%TNS_SERVICE_DISPLAY_NAME%"
if defined TNS_SERVICE_PORT set "SERVICE_PORT=%TNS_SERVICE_PORT%"
set "TARGET_APP_DIR=%INSTALL_PATH%\apps\api"
set "TARGET_LOG_DIR=%INSTALL_PATH%\logs"
set "SERVICE_STDOUT=%TARGET_LOG_DIR%\service-stdout.log"
set "SERVICE_STDERR=%TARGET_LOG_DIR%\service-stderr.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
type nul > "%LOG_FILE%"
call :Log "============================================================"
call :Log "Log initialized. Script=%SCRIPT_NAME%"
call :Log "Process=API_QUERY INSTALL"
call :Log "============================================================"

if not defined TNS_SOURCE_APP_DIR if not defined CONFIG_SOURCE_APP_DIR call :LoadSourceAppDirFromEnv "%SOURCE_ENV_FILE%"
if not defined TNS_INSTALL_PATH if not defined CONFIG_INSTALL_PATH call :LoadInstallPathFromEnv "%SOURCE_ENV_FILE%"
if not defined TNS_SERVICE_PORT if not defined CONFIG_SERVICE_PORT call :LoadServicePortFromEnv "%SOURCE_ENV_FILE%"

call :EnsureAdmin || goto :Abort
call :Log "Starting installation of %SERVICE_NAME%."
call :Log "PROJECT_ROOT=%PROJECT_ROOT%"
call :Log "SOURCE_APP_DIR=%SOURCE_APP_DIR%"
call :Log "INSTALL_PATH=%INSTALL_PATH%"

call :ResolveNodeTools || goto :Abort
if not exist "%SOURCE_APP_DIR%\server.js" (
  call :Fail "Source app directory not found: %SOURCE_APP_DIR%"
  echo HINT: use TNS_SOURCE_APP_DIR to point to the real source tree, for example:
  echo   set TNS_SOURCE_APP_DIR=E:\Desarrollo Actual\TNS-LOCAL\tns-local-API\apps\api
  goto :Abort
)
call :ValidateSourceLayout || goto :Abort
call :Log "NODE_EXE=!NODE_EXE!"
call :Log "NPM_EXE=!NPM_EXE!"

echo Installing %SERVICE_NAME% into %INSTALL_PATH%...

call :SvcCleanupFast || goto :Abort
powershell -NoProfile -Command "$path = '%INSTALL_PATH%'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm|cmd|conhost)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
call :EnsurePreviousInstallClean || goto :Abort
call :DeleteKnownDbFilesFast || goto :Abort

call :RemoveInstallPathWithRetries || goto :Abort

mkdir "%INSTALL_PATH%" >> "%LOG_FILE%" 2>&1
mkdir "%TARGET_APP_DIR%" >> "%LOG_FILE%" 2>&1
mkdir "%TARGET_APP_DIR%\data" >> "%LOG_FILE%" 2>&1
mkdir "%TARGET_LOG_DIR%" >> "%LOG_FILE%" 2>&1

call :Log "Copying application files with robocopy."
robocopy "%SOURCE_APP_DIR%" "%TARGET_APP_DIR%" /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD node_modules deploy\windows\logs /XF service-stdout.log service-stderr.log npm-debug.log >> "%LOG_FILE%" 2>&1
set "ROBOCOPY_RC=%ERRORLEVEL%"
if %ROBOCOPY_RC% GEQ 8 (
  call :Fail "Could not copy application files. robocopy exit code %ROBOCOPY_RC%."
  exit /b 1
)

copy /y "%SOURCE_APP_DIR%\%ENV_FILE%" "%INSTALL_PATH%\%ENV_FILE%" >> "%LOG_FILE%" 2>&1 || (call :Fail "Could not copy %ENV_FILE%." & exit /b 1)
copy /y "%SOURCE_APP_DIR%\%ENV_EXAMPLE_FILE%" "%INSTALL_PATH%\%ENV_EXAMPLE_FILE%" >> "%LOG_FILE%" 2>&1 || (call :Fail "Could not copy %ENV_EXAMPLE_FILE%." & exit /b 1)
copy /y "%NSSM_EXE%" "%INSTALL_PATH%\nssm.exe" >> "%LOG_FILE%" 2>&1 || (call :Fail "Could not copy nssm.exe." & exit /b 1)

if exist "%SOURCE_APP_DIR%\%DB_FILE%" (
  call :Log "Copying seed database from source tree."
  copy /y "%SOURCE_APP_DIR%\%DB_FILE%" "%TARGET_APP_DIR%\%DB_FILE%" >> "%LOG_FILE%" 2>&1 || (call :Fail "Could not copy the seed database." & exit /b 1)
)

call :Log "Installing production dependencies with npm ci."
pushd "%TARGET_APP_DIR%" || (call :Fail "Could not change directory to %TARGET_APP_DIR%." & exit /b 1)
if not exist "package.json" (popd & call :Fail "package.json is missing in %TARGET_APP_DIR%." & exit /b 1)
if not exist "package-lock.json" (popd & call :Fail "package-lock.json is missing in %TARGET_APP_DIR%." & exit /b 1)
powershell -NoProfile -Command "& '!NPM_EXE!' ci --omit=dev --no-fund --no-audit" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  call :Log "npm ci failed. Falling back to npm install."
  powershell -NoProfile -Command "& '!NPM_EXE!' install --omit=dev --no-fund --no-audit" >> "%LOG_FILE%" 2>&1
)
if errorlevel 1 (
  popd
  call :Fail "Dependency installation failed."
  exit /b 1
)
popd

call :EnsureServicePortFreeFast %SERVICE_PORT% || goto :Abort

if /I "%TNS_SKIP_SERVICE%"=="1" (
  call :Log "Skipping service registration because TNS_SKIP_SERVICE=1."
  echo Validation install completed without service registration.
  goto :Success
)

call :Log "Registering service with NSSM."
"%INSTALL_PATH%\nssm.exe" install "%SERVICE_NAME%" "%NODE_EXE%" "%TARGET_APP_DIR%\server.js" >> "%LOG_FILE%" 2>&1 || goto :ServiceInstallFailed
"%INSTALL_PATH%\nssm.exe" set "%SERVICE_NAME%" DisplayName "%SERVICE_DISPLAY_NAME%" >> "%LOG_FILE%" 2>&1 || goto :ServiceInstallFailed
"%INSTALL_PATH%\nssm.exe" set "%SERVICE_NAME%" AppDirectory "%TARGET_APP_DIR%" >> "%LOG_FILE%" 2>&1 || goto :ServiceInstallFailed
"%INSTALL_PATH%\nssm.exe" set "%SERVICE_NAME%" AppStdout "%SERVICE_STDOUT%" >> "%LOG_FILE%" 2>&1 || goto :ServiceInstallFailed
"%INSTALL_PATH%\nssm.exe" set "%SERVICE_NAME%" AppStderr "%SERVICE_STDERR%" >> "%LOG_FILE%" 2>&1 || goto :ServiceInstallFailed
"%INSTALL_PATH%\nssm.exe" set "%SERVICE_NAME%" AppRotateFiles 1 >> "%LOG_FILE%" 2>&1 || goto :ServiceInstallFailed
"%INSTALL_PATH%\nssm.exe" set "%SERVICE_NAME%" Start SERVICE_AUTO_START >> "%LOG_FILE%" 2>&1 || goto :ServiceInstallFailed

call :Log "Starting service %SERVICE_NAME%."
sc.exe start "%SERVICE_NAME%" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  call :Fail "Service start command failed."
  exit /b 1
)
call :WaitForServiceReadyFast 180
if errorlevel 1 (
  call :Fail "Service did not reach RUNNING state."
  exit /b 1
)

call :Log "Service installed and running."
echo Service %SERVICE_NAME% installed. Expected URL: http://127.0.0.1:%SERVICE_PORT%
echo Installation log: %LOG_FILE%
call :ShowStatusFast
goto :Success

:ServiceInstallFailed
call :Fail "Service registration failed."
goto :Abort

:EnsurePreviousInstallClean
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
call :ServiceExistsFast
if "%SERVICE_EXISTS%"=="1" (
  call :Fail "Service %SERVICE_NAME% still exists after cleanup."
  exit /b 1
)
exit /b 0

:RemoveInstallPathWithRetries
if not exist "%INSTALL_PATH%" exit /b 0
for /L %%N in (1,1,5) do (
  call :Log "Removing previous installation directory. Attempt %%N of 5."
  call :DeleteKnownDbFilesFast || exit /b 1
  powershell -NoProfile -Command "$path = '%INSTALL_PATH%'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm|cmd|conhost)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
  rmdir /s /q "%INSTALL_PATH%" >> "%LOG_FILE%" 2>&1
  if not exist "%INSTALL_PATH%" exit /b 0
  timeout /t 2 /nobreak >nul
)
call :Log "Processes still referencing %INSTALL_PATH%:"
call :LogLikelyLockingProcessesFast "%INSTALL_PATH%"
call :Fail "Installation path is still locked: %INSTALL_PATH%."
exit /b 1

:ResolveNodeTools
for /f "delims=" %%A in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%~fA"
for /f "delims=" %%A in ('where npm.cmd 2^>nul') do if not defined NPM_EXE set "NPM_EXE=%%~fA"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NPM_EXE if exist "C:\Program Files\nodejs\npm.cmd" set "NPM_EXE=C:\Program Files\nodejs\npm.cmd"
if not defined NODE_EXE (call :Fail "node.exe was not found in PATH." & exit /b 1)
if not defined NPM_EXE (call :Fail "npm.cmd was not found in PATH." & exit /b 1)
if not exist "%NSSM_EXE%" (call :Fail "nssm.exe was not found in %NSSM_EXE%." & exit /b 1)
for /f "tokens=1 delims=." %%A in ('"%NODE_EXE%" -v') do set "NODE_MAJOR=%%A"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if not defined NODE_MAJOR (call :Fail "Could not determine Node.js major version." & exit /b 1)
if %NODE_MAJOR% LSS 18 (call :Fail "Node.js 18 or newer is required." & exit /b 1)
exit /b 0

:ValidateSourceLayout
if not exist "%SOURCE_APP_DIR%\server.js" (call :Fail "server.js not found in source app directory." & exit /b 1)
if not exist "%SOURCE_APP_DIR%\package.json" (call :Fail "package.json not found in source app directory." & exit /b 1)
if not exist "%SOURCE_APP_DIR%\package-lock.json" (call :Fail "package-lock.json not found in source app directory." & exit /b 1)
if not exist "%SOURCE_APP_DIR%\localConfigStore.js" (call :Fail "localConfigStore.js not found in source app directory." & exit /b 1)
if not exist "%SOURCE_APP_DIR%\%ENV_FILE%" (call :Fail "%ENV_FILE% not found in source app directory." & exit /b 1)
if not exist "%SOURCE_APP_DIR%\%ENV_EXAMPLE_FILE%" (call :Fail "%ENV_EXAMPLE_FILE% not found in source app directory." & exit /b 1)
exit /b 0

:EnsureServicePortFreeFast
set "CHECK_PORT=%~1"
if not defined CHECK_PORT exit /b 0
set "PORT_OWNER_PID="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %CHECK_PORT%; $tcp = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($tcp) { $tcp } else { $udp = Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($udp) { $udp } }"`) do if not defined PORT_OWNER_PID set "PORT_OWNER_PID=%%~A"
if not defined PORT_OWNER_PID (
  call :Log "Port %CHECK_PORT% is free."
  exit /b 0
)
call :Log "Port %CHECK_PORT% is already in use by PID %PORT_OWNER_PID%."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procId = %PORT_OWNER_PID%; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -eq $procId } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | Format-List" >> "%LOG_FILE%" 2>&1
set "MATCHING_APP_PID="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$procId = %PORT_OWNER_PID%; $target = [IO.Path]::GetFullPath('%TARGET_APP_DIR%\server.js'); $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -eq $procId } | Select-Object -First 1; if ($proc -and $proc.CommandLine -and $proc.CommandLine.ToLowerInvariant().Contains($target.ToLowerInvariant())) { $proc.ProcessId }"`) do if not defined MATCHING_APP_PID set "MATCHING_APP_PID=%%~A"
if defined MATCHING_APP_PID (
  call :Log "Port %CHECK_PORT% is occupied by the same API query instance. Killing PID %MATCHING_APP_PID% and retrying."
  taskkill /PID %MATCHING_APP_PID% /T /F >> "%LOG_FILE%" 2>&1
  timeout /t 2 /nobreak >nul
  set "PORT_OWNER_PID="
  for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %CHECK_PORT%; $tcp = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($tcp) { $tcp } else { $udp = Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($udp) { $udp } }"`) do if not defined PORT_OWNER_PID set "PORT_OWNER_PID=%%~A"
  if not defined PORT_OWNER_PID (
    call :Log "Port %CHECK_PORT% is free after killing previous API query instance."
    exit /b 0
  )
  call :Log "Port %CHECK_PORT% is still in use after killing PID %MATCHING_APP_PID%."
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$procId = %PORT_OWNER_PID%; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -eq $procId } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | Format-List" >> "%LOG_FILE%" 2>&1
)
tasklist /FI "PID eq %PORT_OWNER_PID%" /NH | findstr /I /C:"node.exe" >nul 2>&1
if not errorlevel 1 (
  set "KILLED_NODE_PID=%PORT_OWNER_PID%"
  call :Log "Port %CHECK_PORT% is occupied by node.exe. Killing PID %KILLED_NODE_PID% and retrying."
  taskkill /PID %KILLED_NODE_PID% /T /F >> "%LOG_FILE%" 2>&1
  timeout /t 2 /nobreak >nul
  set "PORT_OWNER_PID="
  for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %CHECK_PORT%; $tcp = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($tcp) { $tcp } else { $udp = Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($udp) { $udp } }"`) do if not defined PORT_OWNER_PID set "PORT_OWNER_PID=%%~A"
  if not defined PORT_OWNER_PID (
    call :Log "Port %CHECK_PORT% is free after killing node.exe PID %KILLED_NODE_PID%."
    exit /b 0
  )
  call :Log "Port %CHECK_PORT% is still in use after killing node.exe PID %KILLED_NODE_PID%."
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$procId = %PORT_OWNER_PID%; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -eq $procId } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | Format-List" >> "%LOG_FILE%" 2>&1
)
call :Fail "Port %CHECK_PORT% is already in use by PID %PORT_OWNER_PID%. Stop that process or change PORT in %ENV_FILE%."
exit /b 1

:SvcCleanupFast
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
call :ServiceExistsFast
if "%SERVICE_EXISTS%"=="0" exit /b 0
call :Log "Stopping existing service %SERVICE_NAME%."
sc.exe stop "%SERVICE_NAME%" >> "%LOG_FILE%" 2>&1
call :WaitForServiceStateFast STOPPED 15
if errorlevel 1 call :KillServiceProcessByNameFast "%SERVICE_NAME%"
call :WaitForServiceStateFast STOPPED 10 >nul 2>&1
if exist "%INSTALL_PATH%\nssm.exe" (
  call :Log "Removing service with local NSSM."
  "%INSTALL_PATH%\nssm.exe" remove "%SERVICE_NAME%" confirm >> "%LOG_FILE%" 2>&1
  if errorlevel 1 (call :Fail "Could not remove existing service." & exit /b 1)
) else (
  call :Log "Removing service with sc.exe delete."
  sc.exe delete "%SERVICE_NAME%" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 (call :Fail "Could not remove existing service." & exit /b 1)
)
call :WaitForServiceDeletedFast 45
if errorlevel 1 (call :Fail "Service still exists after removal attempt." & exit /b 1)
exit /b 0

:ServiceExistsFast
if /I "%TNS_SKIP_SERVICE%"=="1" (
  set "SERVICE_EXISTS=0"
  exit /b 0
)
set "SERVICE_EXISTS=0"
sc.exe query "%SERVICE_NAME%" >nul 2>&1
if not errorlevel 1 set "SERVICE_EXISTS=1"
exit /b 0

:WaitForServiceStateFast
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

:WaitForServiceDeletedFast
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
set "WAIT_SECONDS=%~1"
if not defined WAIT_SECONDS set "WAIT_SECONDS=30"
for /L %%N in (1,1,%WAIT_SECONDS%) do (
  sc.exe query "%SERVICE_NAME%" >nul 2>&1
  if errorlevel 1 exit /b 0
  timeout /t 1 /nobreak >nul
)
exit /b 1

:WaitForServiceReadyFast
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
set "WAIT_SECONDS=%~1"
if not defined WAIT_SECONDS set "WAIT_SECONDS=180"
for /L %%N in (1,1,%WAIT_SECONDS%) do (
  sc.exe query "%SERVICE_NAME%" | findstr /I /C:"STATE" | findstr /I /C:"RUNNING" >nul 2>&1
  if not errorlevel 1 exit /b 0
  if exist "%SERVICE_STDOUT%" (
    findstr /I /C:"listening on http://" "%SERVICE_STDOUT%" >nul 2>&1
    if not errorlevel 1 exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
exit /b 1

:DeleteKnownDbFilesFast
call :DeleteFileWithRetriesFast "%INSTALL_PATH%\data\local-config.sqlite" || exit /b 1
call :DeleteFileWithRetriesFast "%INSTALL_PATH%\apps\api\data\local-config-api.sqlite" || exit /b 1
exit /b 0

:DeleteFileWithRetriesFast
set "TARGET_FILE=%~1"
if not defined TARGET_FILE exit /b 0
if not exist "%TARGET_FILE%" exit /b 0
for /L %%N in (1,1,5) do (
  call :Log "Deleting file %TARGET_FILE%. Attempt %%N of 5."
  del /f /q "%TARGET_FILE%" >> "%LOG_FILE%" 2>&1
  if not exist "%TARGET_FILE%" exit /b 0
  call :KillProcessesLockingFileFast "%TARGET_FILE%"
  powershell -NoProfile -Command "$path = '%INSTALL_PATH%'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm|cmd|conhost)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
  timeout /t 2 /nobreak >nul
)
call :Log "Processes locking %TARGET_FILE%:"
call :LogProcessesLockingFileFast "%TARGET_FILE%"
call :Fail "Could not delete locked file %TARGET_FILE%."
exit /b 1

:LogLikelyLockingProcessesFast
set "LOCK_PATH=%~1"
if not defined LOCK_PATH exit /b 0
powershell -NoProfile -Command "$path = '%LOCK_PATH%'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm|cmd|conhost)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | Format-Table -AutoSize" >> "%LOG_FILE%" 2>&1
exit /b 0

:KillServiceProcessByNameFast
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
set "SERVICE_PID="
for /f "tokens=3" %%A in ('sc.exe queryex "%~1" ^| findstr /R /C:"PID[ ]*:[ ]*[0-9][0-9]*"') do set "SERVICE_PID=%%A"
if defined SERVICE_PID if not "%SERVICE_PID%"=="0" (
  call :Log "Killing service PID %SERVICE_PID%."
  taskkill /PID %SERVICE_PID% /T /F >> "%LOG_FILE%" 2>&1
  timeout /t 2 /nobreak >nul
)
exit /b 0

:KillProcessesLockingFileFast
set "LOCK_FILE=%~1"
if not defined LOCK_FILE exit /b 0
if not exist "%LOCK_HELPER%" exit /b 0
call :Log "Stopping processes locking file %LOCK_FILE%."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items = & '%LOCK_HELPER%' '%LOCK_FILE%'; foreach ($item in $items) { try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
exit /b 0

:LogProcessesLockingFileFast
set "LOCK_FILE=%~1"
if not defined LOCK_FILE exit /b 0
if not exist "%LOCK_HELPER%" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items = & '%LOCK_HELPER%' '%LOCK_FILE%'; if ($items) { $items | Format-Table -AutoSize }" >> "%LOG_FILE%" 2>&1
exit /b 0

:ShowStatusFast
call :Log "Showing related processes and recent logs."
echo.
echo Processes related to "%INSTALL_PATH%":
powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -and $_.CommandLine -like '*%INSTALL_PATH%*') -or ($_.ExecutablePath -and $_.ExecutablePath -like '*node*') } | Select-Object ProcessId, ExecutablePath, CommandLine | Format-Table -AutoSize"
if exist "%SERVICE_STDOUT%" (
  echo.
  echo -- Last lines of service-stdout.log --
  powershell -NoProfile -Command "Get-Content '%SERVICE_STDOUT%' -Tail 30"
)
if exist "%SERVICE_STDERR%" (
  echo.
  echo -- Last lines of service-stderr.log --
  powershell -NoProfile -Command "Get-Content '%SERVICE_STDERR%' -Tail 60"
)
echo.
echo -- Last lines of %LOG_FILE% --
powershell -NoProfile -Command "Get-Content '%LOG_FILE%' -Tail 80"
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
call :Log "INSTALL_PATH loaded from %ENV_CONFIG_FILE%: %INSTALL_PATH%"
set "TARGET_APP_DIR=%INSTALL_PATH%\apps\api"
set "TARGET_LOG_DIR=%INSTALL_PATH%\logs"
set "SERVICE_STDOUT=%TARGET_LOG_DIR%\service-stdout.log"
set "SERVICE_STDERR=%TARGET_LOG_DIR%\service-stderr.log"
exit /b 0

:LoadServicePortFromEnv
set "ENV_CONFIG_FILE=%~1"
set "ENV_SERVICE_PORT="
if not defined ENV_CONFIG_FILE exit /b 0
if not exist "%ENV_CONFIG_FILE%" exit /b 0
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$path = '%ENV_CONFIG_FILE%'; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path | Where-Object { $_ -notmatch '^\s*(#|$)' } | ForEach-Object { $parts = $_ -split '=', 2; if ($parts.Count -eq 2 -and $parts[0].Trim() -eq 'PORT') { $parts[1].Trim() } } | Select-Object -First 1 }"`) do if not defined ENV_SERVICE_PORT set "ENV_SERVICE_PORT=%%~A"
if not defined ENV_SERVICE_PORT exit /b 0
set "ENV_SERVICE_PORT=%ENV_SERVICE_PORT:"=%"
set "SERVICE_PORT=%ENV_SERVICE_PORT%"
call :Log "SERVICE_PORT loaded from %ENV_CONFIG_FILE%: %SERVICE_PORT%"
exit /b 0

:LoadSourceAppDirFromEnv
set "ENV_CONFIG_FILE=%~1"
set "ENV_SOURCE_APP_DIR="
if not defined ENV_CONFIG_FILE exit /b 0
if not exist "%ENV_CONFIG_FILE%" exit /b 0
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$path = '%ENV_CONFIG_FILE%'; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path | Where-Object { $_ -notmatch '^\s*(#|$)' } | ForEach-Object { $parts = $_ -split '=', 2; if ($parts.Count -eq 2 -and $parts[0].Trim() -eq 'SOURCE_APP_DIR') { $parts[1].Trim() } } | Select-Object -First 1 }"`) do if not defined ENV_SOURCE_APP_DIR set "ENV_SOURCE_APP_DIR=%%~A"
if not defined ENV_SOURCE_APP_DIR exit /b 0
set "ENV_SOURCE_APP_DIR=%ENV_SOURCE_APP_DIR:"=%"
for %%I in ("%ENV_SOURCE_APP_DIR%") do set "SOURCE_APP_DIR=%%~fI"
set "SOURCE_ENV_FILE=%SOURCE_APP_DIR%\%ENV_FILE%"
call :Log "SOURCE_APP_DIR loaded from %ENV_CONFIG_FILE%: %SOURCE_APP_DIR%"
exit /b 0

:EnsureServicePortFree
set "CHECK_PORT=%~1"
if not defined CHECK_PORT exit /b 0
set "PORT_OWNER_PID="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %CHECK_PORT%; $tcp = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($tcp) { $tcp } else { $udp = Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($udp) { $udp } }"`) do if not defined PORT_OWNER_PID set "PORT_OWNER_PID=%%~A"
if not defined PORT_OWNER_PID (
  call :Log "Port %CHECK_PORT% is free."
  exit /b 0
)
call :Log "Port %CHECK_PORT% is already in use by PID %PORT_OWNER_PID%."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$pid = %PORT_OWNER_PID%; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -eq $pid } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | Format-List" >> "%LOG_FILE%" 2>&1
call :Fail "Port %CHECK_PORT% is already in use by PID %PORT_OWNER_PID%. Stop that process or change PORT in %ENV_FILE%."
exit /b 1

:SvcCleanup
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
call :ServiceExists
if "%SERVICE_EXISTS%"=="0" exit /b 0
call :Log "Stopping existing service %SERVICE_NAME%."
sc.exe stop "%SERVICE_NAME%" >> "%LOG_FILE%" 2>&1
call :WaitForServiceState STOPPED 15
if errorlevel 1 call :KillServiceProcessByName "%SERVICE_NAME%"
call :WaitForServiceState STOPPED 10 >nul 2>&1
if exist "%INSTALL_PATH%\nssm.exe" (
  call :Log "Removing service with local NSSM."
  "%INSTALL_PATH%\nssm.exe" remove "%SERVICE_NAME%" confirm >> "%LOG_FILE%" 2>&1
  if errorlevel 1 (call :Fail "Could not remove existing service." & exit /b 1)
) else (
  call :Log "Removing service with sc.exe delete."
  sc.exe delete "%SERVICE_NAME%" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 (call :Fail "Could not remove existing service." & exit /b 1)
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

:WaitForServiceReady
if /I "%TNS_SKIP_SERVICE%"=="1" exit /b 0
set "WAIT_SECONDS=%~1"
if not defined WAIT_SECONDS set "WAIT_SECONDS=180"
for /L %%N in (1,1,%WAIT_SECONDS%) do (
  sc.exe query "%SERVICE_NAME%" | findstr /I /C:"STATE" | findstr /I /C:"RUNNING" >nul 2>&1
  if not errorlevel 1 exit /b 0
  if exist "%SERVICE_STDOUT%" (
    findstr /I /C:"listening on http://" "%SERVICE_STDOUT%" >nul 2>&1
    if not errorlevel 1 exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
exit /b 1

:KillPathProcesses
set "KILL_PATH=%~1"
if not defined KILL_PATH exit /b 0
powershell -NoProfile -Command "$path = '%KILL_PATH%'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm|cmd|conhost)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%LOG_FILE%" 2>&1
exit /b 0

:DeleteKnownDbFiles
call :DeleteFileWithRetries "%INSTALL_PATH%\data\local-config.sqlite" || exit /b 1
call :DeleteFileWithRetries "%INSTALL_PATH%\apps\api\data\local-config-api.sqlite" || exit /b 1
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

:LogLikelyLockingProcesses
set "LOCK_PATH=%~1"
if not defined LOCK_PATH exit /b 0
powershell -NoProfile -Command "$path = '%LOCK_PATH%'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath -like ($path + '*')) -or ($_.Name -match '^(node|nssm|cmd|conhost)$' -and $_.CommandLine -and $_.CommandLine -like ('*' + $path + '*')) } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | Format-Table -AutoSize" >> "%LOG_FILE%" 2>&1
exit /b 0

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

:LogProcessesLockingFile
set "LOCK_FILE=%~1"
if not defined LOCK_FILE exit /b 0
if not exist "%LOCK_HELPER%" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items = & '%LOCK_HELPER%' '%LOCK_FILE%'; if ($items) { $items | Format-Table -AutoSize }" >> "%LOG_FILE%" 2>&1
exit /b 0

:ShowStatus
call :Log "Showing related processes and recent logs."
echo.
echo Processes related to "%INSTALL_PATH%":
powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -and $_.CommandLine -like '*%INSTALL_PATH%*') -or ($_.ExecutablePath -and $_.ExecutablePath -like '*node*') } | Select-Object ProcessId, ExecutablePath, CommandLine | Format-Table -AutoSize"
if exist "%SERVICE_STDOUT%" (
  echo.
  echo -- Last lines of service-stdout.log --
  powershell -NoProfile -Command "Get-Content '%SERVICE_STDOUT%' -Tail 30"
)
if exist "%SERVICE_STDERR%" (
  echo.
  echo -- Last lines of service-stderr.log --
  powershell -NoProfile -Command "Get-Content '%SERVICE_STDERR%' -Tail 60"
)
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
  if /I "%%~A"=="SERVICE_DISPLAY_NAME" set "CONFIG_SERVICE_DISPLAY_NAME=%%~B"
  if /I "%%~A"=="SERVICE_PORT" set "CONFIG_SERVICE_PORT=%%~B"
  if /I "%%~A"=="ENV_FILE" set "CONFIG_ENV_FILE=%%~B"
  if /I "%%~A"=="ENV_EXAMPLE_FILE" set "CONFIG_ENV_EXAMPLE_FILE=%%~B"
  if /I "%%~A"=="DB_FILE" set "CONFIG_DB_FILE=%%~B"
)
if defined CONFIG_SOURCE_APP_DIR set "SOURCE_APP_DIR=%CONFIG_SOURCE_APP_DIR%"
exit /b 0

:PauseBeforeClose
if /I "%TNS_NO_PAUSE%"=="1" exit /b 0
echo.
set /p "=Press any key to close this window... " <nul
pause >nul
exit /b 0
