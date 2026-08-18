@echo off
setlocal enabledelayedexpansion
rem
rem Double-clickable launcher (Windows). Explorer opens a console window and
rem runs this, so the clarification questions still work - the console is right
rem there.
rem
rem Two batch-isms worth knowing if you edit this:
rem   - cd /d "%~dp0" is required because a shortcut or "Run as administrator"
rem     would not start us in this folder;
rem   - a variable SET inside an if(...) block cannot be read with %var% in the
rem     same block, because the whole block is expanded before it runs. That is
rem     why delayed expansion is on and !reply! is used below.
cd /d "%~dp0"

echo Workflow Preprocessor
echo =====================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo.
  echo Install it from https://nodejs.org, then double-click this file again.
  echo If you just installed it, close this window and open it again so the
  echo new PATH takes effect.
  goto :finish_error
)

if not exist "node_modules\" (
  echo First run - installing dependencies ^(this happens once^)...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. See the messages above.
    goto :finish_error
  )
  echo.
)

if not exist ".env" (
  echo No configuration yet.
  echo.
  copy /y ".env.example" ".env" >nul
  echo A starting file has been created for you:
  echo   %cd%\.env
  echo.
  echo Open it, fill in LLM_ENDPOINT and LLM_MODEL ^(and LLM_API_KEY if your
  echo gateway needs one^), save, then double-click this file again.
  echo.
  set /p "reply=Open it now in Notepad? [y/N] "
  if /i "!reply!"=="y" start notepad ".env"
  goto :finish_error
)

call npx tsx src/cli.ts --inbox %*
set "status=%errorlevel%"

rem Status 0 needs no extra line - an empty inbox and a clean run both already
rem said what happened, and "all validated" on an empty inbox would be a lie.
if "%status%"=="2" (
  echo.
  echo Some results are partial. Their open questions are listed in the JSON.
)
if "%status%"=="3" (
  echo.
  echo At least one input was rejected. The reason is shown above.
)

echo.
pause
exit /b %status%

:finish_error
echo.
pause
exit /b 1
