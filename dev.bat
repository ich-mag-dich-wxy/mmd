@echo off
cd /d "e:\mmdviewer\mmd-viewer"
set ELECTRON_IS_DEV=1
call npx concurrently -k "vite" "electron electron/main.cjs"