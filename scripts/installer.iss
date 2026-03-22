; KeepKey Vault - Inno Setup Installer Script
; This file is generated/maintained alongside build-windows-production.ps1
; NOTE: Install dir uses "KeepKeyVault" (no space) because Bun Workers
; silently fail when the file path contains spaces.
;
; IMPORTANT: This installer is intentionally minimal. The v1.2.1 installer
; shipped successfully. Every addition after that (InstallDelete, Code section,
; CloseApplications, process kills) correlated with launch failures on Windows.
; Evidence (retro-installer-failure-2026-03-22.md) proved that the installer's
; side-effects — not the binaries, not the DLL, not the profile — are what
; poison the machine. Do NOT add cleanup logic without evidence from a
; 4-machine test matrix proving it is safe.

#define MyAppName "KeepKey Vault"
#define MyAppDirName "KeepKeyVault"
#define MyAppPublisher "KEY HODLERS LLC"
#define MyAppURL "https://github.com/keepkey/keepkey-vault"
#define MyAppExeName "KeepKeyVault.exe"

; Version and source dir are passed via /D command line defines
; e.g. ISCC /DMyAppVersion=1.0.0 /DMySourceDir=C:\path\to\build

[Setup]
AppId={{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppDirName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir={#MyOutputDir}
OutputBaseFilename=KeepKey-Vault-{#MyAppVersion}-win-x64-setup
SetupIconFile={#MySourceDir}\Resources\app-real.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
WizardImageFile={#MyScriptDir}\installer-wizard.bmp
WizardSmallImageFile={#MyScriptDir}\installer-small.bmp
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\Resources\app-real.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#MySourceDir}\KeepKeyVault.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MySourceDir}\KeepKeyVault.exe.manifest"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MySourceDir}\bin\*"; DestDir: "{app}\bin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MySourceDir}\Resources\*"; DestDir: "{app}\Resources"; Flags: ignoreversion recursesubdirs createallsubdirs
; WebView2 bootstrapper — extracted to temp, deleted after install
Source: "{#MySourceDir}\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\Resources\app-real.ico"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\Resources\app-real.ico"; Tasks: desktopicon

[Run]
; Always install/update WebView2 Runtime (required on Windows 10, pre-installed on Windows 11).
; The bootstrapper is a no-op if already present and up-to-date.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing WebView2 Runtime..."; Flags: waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
