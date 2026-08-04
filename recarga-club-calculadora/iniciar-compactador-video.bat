@echo off
setlocal
cd /d "%~dp0"
set VIDEO_COMPRESSOR_PORT=8787

echo.
echo RECARGA CLUB - Site com compactador de video
echo.
echo Abra no navegador:
echo http://127.0.0.1:8787
echo.
echo Para compactar localmente, o FFmpeg precisa estar instalado no Windows
echo ou o arquivo ffmpeg.exe precisa estar nesta pasta ou em .\tools\ffmpeg.exe.
echo.

where node >nul 2>nul
if %errorlevel%==0 (
  node video-compressor-server.js
) else (
  "C:\Users\Recarga Club\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" video-compressor-server.js
)

pause
