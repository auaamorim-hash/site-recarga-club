@echo off
setlocal
cd /d "%~dp0"
set APP_PORT=8787

echo.
echo RECARGA CLUB - servidor local
echo.
echo Abra no navegador:
echo http://127.0.0.1:8787
echo.
echo A agenda privada deve estar em .\data\agenda.json.
echo Mantenha esta janela aberta enquanto usa o site.
echo.

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  "C:\Users\Recarga Club\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
)

pause
