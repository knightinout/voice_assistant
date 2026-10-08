@echo off
REM Launch the Voice Assistant Electron app on Windows.
cd /d "%~dp0"
npx electron . --no-sandbox
