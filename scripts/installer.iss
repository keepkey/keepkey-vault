; KeepKey Vault - Inno Setup Installer Script
; This file is generated/maintained alongside build-windows-production.ps1
; NOTE: Install dir uses "KeepKeyVault" (no space) because Bun Workers
; silently fail when the file path contains spaces.

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
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\Resources\app-real.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#MySourceDir}\KeepKeyVault.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MySourceDir}\bin\*"; DestDir: "{app}\bin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MySourceDir}\Resources\*"; DestDir: "{app}\Resources"; Flags: ignoreversion recursesubdirs createallsubdirs
; WebView2 bootstrapper — extracted to temp, deleted after install
Source: "{#MySourceDir}\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\Resources\app-real.ico"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\Resources\app-real.ico"; Tasks: desktopicon

[Run]
; Install WebView2 Runtime if not present (required on Windows 10, pre-installed on Windows 11)
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing WebView2 Runtime..."; Flags: waituntilterminated; Check: NeedsWebView2
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
function NeedsWebView2: Boolean;
var
  Version: String;
begin
  Result := True;
  // WebView2 registers its version here when installed
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
    Result := (Version = '') or (Version = '0.0.0.0')
  else if RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
    Result := (Version = '') or (Version = '0.0.0.0');
end;
