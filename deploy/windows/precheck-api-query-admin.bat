@echo off
setlocal EnableExtensions
call :RunAsAdmin "precheck-api-query.bat"
exit /b %ERRORLEVEL%

:RunAsAdmin
for %%I in ("%~dp0%~1") do set "TARGET_SCRIPT=%%~fI"
if not exist "%TARGET_SCRIPT%" (
  echo ERROR: Could not find %~1
  exit /b 1
)
net session >nul 2>&1
if %errorlevel% equ 0 (
  call "%TARGET_SCRIPT%"
  exit /b %ERRORLEVEL%
)
set "VBS_FILE=%TEMP%\tns-precheck-api-admin-%RANDOM%%RANDOM%.vbs"
(
  echo Set UAC = CreateObject^("Shell.Application"^)
  echo UAC.ShellExecute "cmd.exe", "/c """"%TARGET_SCRIPT%""""", "", "runas", 1
) > "%VBS_FILE%"
cscript //nologo "%VBS_FILE%"
set "RC=%ERRORLEVEL%"
del /f /q "%VBS_FILE%" >nul 2>&1
exit /b %RC%
