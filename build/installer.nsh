; Incursion setup: a Shortcuts page after the install folder, in the app's dark colours.
; electron-builder's own shortcuts are off (package.json), so these choices decide what gets created.

!define MUI_BGCOLOR 090C11
!define MUI_TEXTCOLOR ECEFF2
!define MUI_INSTFILESPAGE_COLORS "ECEFF2 15181E"
!define MUI_INSTFILESPAGE_PROGRESSBAR colored

!include nsDialogs.nsh
!include LogicLib.nsh

!define SETUP_KEY "Software\Incursion\Setup"

!ifndef BUILD_UNINSTALLER
  Var WantStartMenu
  Var WantDesktop
  Var StartMenuBox
  Var DesktopBox
!endif

!macro readSetupChoice ROOT NAME VAR
  ReadRegStr $0 ${ROOT} "${SETUP_KEY}" "${NAME}"
  ${if} $0 != ""
    StrCpy ${VAR} $0
  ${endif}
!macroend

!macro customInit
  ; First install: a Start menu folder, no desktop shortcut. Later installs keep the last choice.
  StrCpy $WantStartMenu ${BST_CHECKED}
  StrCpy $WantDesktop ${BST_UNCHECKED}
  !insertmacro readSetupChoice HKLM "StartMenu" $WantStartMenu
  !insertmacro readSetupChoice HKLM "Desktop" $WantDesktop
  !insertmacro readSetupChoice HKCU "StartMenu" $WantStartMenu
  !insertmacro readSetupChoice HKCU "Desktop" $WantDesktop
!macroend

; Expanded among the installer pages, after MUI2 is loaded.
!macro customPageAfterChangeDir
  Page custom ShortcutsPage ShortcutsPageLeave
  Function ShortcutsPage
    ${if} ${isUpdated}
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose where you want to find Incursion."
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}
    ${NSD_CreateLabel} 0 0 100% 20u "Incursion is always available from its install folder. Pick the shortcuts you want:"
    Pop $0
    ${NSD_CreateCheckbox} 0 26u 100% 12u "Create a Start menu folder"
    Pop $StartMenuBox
    ${NSD_SetState} $StartMenuBox $WantStartMenu
    ${NSD_CreateCheckbox} 0 44u 100% 12u "Create a desktop shortcut"
    Pop $DesktopBox
    ${NSD_SetState} $DesktopBox $WantDesktop
    nsDialogs::Show
  FunctionEnd

  Function ShortcutsPageLeave
    ${NSD_GetState} $StartMenuBox $WantStartMenu
    ${NSD_GetState} $DesktopBox $WantDesktop
  FunctionEnd
!macroend

; electron-builder's finish page, plus light text on the "Run Incursion" checkbox: themed checkboxes ignore the page's
; text colour, so its theme is switched off first.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishPageShow
  !insertmacro MUI_PAGE_FINISH

  Function FinishPageShow
    StrCpy $0 $mui.FinishPage.Run
    System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
    SetCtlColors $0 ECEFF2 090C11
  FunctionEnd
!macroend

!macro customInstall
  ${if} $WantStartMenu == ${BST_CHECKED}
    CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    WinShell::SetLnkAUMI "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "${APP_ID}"
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
  ${endif}
  ${if} $WantDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    WinShell::SetLnkAUMI "$DESKTOP\${PRODUCT_NAME}.lnk" "${APP_ID}"
  ${endif}
  ClearErrors
  WriteRegStr SHCTX "${SETUP_KEY}" "StartMenu" $WantStartMenu
  WriteRegStr SHCTX "${SETUP_KEY}" "Desktop" $WantDesktop
!macroend

!macro customUnInstall
  ${if} ${FileExists} "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
    WinShell::UninstShortcut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  ${endif}
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  ${if} ${FileExists} "$DESKTOP\${PRODUCT_NAME}.lnk"
    WinShell::UninstShortcut "$DESKTOP\${PRODUCT_NAME}.lnk"
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  ${endif}
  ${ifNot} ${isUpdated}
    DeleteRegKey SHCTX "${SETUP_KEY}"
    DeleteRegKey /ifempty SHCTX "Software\Incursion"
  ${endif}
!macroend
