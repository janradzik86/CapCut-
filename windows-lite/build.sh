#!/usr/bin/env bash
# Builds dist/ClipForge-Setup-<ver>.exe on Linux (needs: mingw-w64, nsis)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build ../dist
x86_64-w64-mingw32-windres launcher.rc -O coff -o build/launcher.res
x86_64-w64-mingw32-gcc -O2 -municode -mwindows -o build/ClipForge.exe launcher.c build/launcher.res -lws2_32 -lshell32 -lole32 -luuid -ladvapi32 -s
makensis -V2 installer.nsi
ls -la ../dist
