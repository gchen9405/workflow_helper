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

echo Workflow Improvement Reports
echo ============================
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

rem The pipeline needs its three sibling packages BUILT, not just its own
rem node_modules - "npm run setup" does both and is safe to re-run.
set "needsetup="
if not exist "node_modules\" set "needsetup=1"
if not exist "..\narrator\dist\" set "needsetup=1"
if not exist "..\recommender\dist\" set "needsetup=1"
if not exist "..\preprocessor\dist\" set "needsetup=1"
if defined needsetup (
  echo First run - installing and building ^(this happens once^)...
  echo.
  call npm run setup
  if errorlevel 1 (
    echo.
    echo npm run setup failed. See the messages above.
    goto :finish_error
  )
  echo.
)

rem One .env can live here or at the repo root; either is found automatically.
if not exist ".env" if not exist "..\.env" (
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
rem said what happened.
if "%status%"=="2" (
  echo.
  echo Some reports use the deterministic summary because the model's was
  echo unavailable; the reports are still complete.
)
if "%status%"=="3" (
  echo.
  echo At least one input had nothing to recommend on. Its report explains why.
)

echo.
pause
exit /b %status%

:finish_error
echo.
pause
exit /b 1
