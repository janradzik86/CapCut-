Unicode true
!include "MUI2.nsh"
!define APP "ClipForge"
!define VER "2.0.0"
Name "${APP} ${VER}"
OutFile "..\dist\ClipForge-Setup-${VER}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\${APP}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "..\www\icons\icon.ico"
!define MUI_UNICON "..\www\icons\icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP}.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Polish"
!insertmacro MUI_LANGUAGE "English"
VIProductVersion "2.0.0.0"
VIAddVersionKey /LANG=${LANG_POLISH} "ProductName" "${APP}"
VIAddVersionKey /LANG=${LANG_POLISH} "FileDescription" "${APP} Setup"
VIAddVersionKey /LANG=${LANG_POLISH} "FileVersion" "${VER}"
VIAddVersionKey /LANG=${LANG_POLISH} "CompanyName" "${APP}"
VIAddVersionKey /LANG=${LANG_POLISH} "LegalCopyright" "MIT License"

Section "Install"
  SetOutPath "$INSTDIR"
  File "build\${APP}.exe"
  SetOutPath "$INSTDIR\app"
  File /r /x "_test" "..\www\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortcut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\${APP}.exe" 0
  CreateShortcut "$SMPROGRAMS\${APP}\Odinstaluj ${APP}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\${APP}.exe" 0
  WriteRegStr HKCU "Software\${APP}" "InstallDir" "$INSTDIR"
  !define UK "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
  WriteRegStr HKCU "${UK}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UK}" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "${UK}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UK}" "DisplayIcon" "$INSTDIR\${APP}.exe"
  WriteRegStr HKCU "${UK}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UK}" "NoModify" 1
  WriteRegDWORD HKCU "${UK}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\${APP}.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$SMPROGRAMS\${APP}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
  DeleteRegKey HKCU "Software\${APP}"
SectionEnd
