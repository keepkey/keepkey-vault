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
; Per-user install ONLY. The bundled Bun runtime opens its own program files with
; a write-class right (FILE_WRITE_ATTRIBUTES) even for read-only reads; a normal
; (non-elevated, medium-integrity) process is denied that on a read-only Program
; Files ACL, so the app hangs at the splash on launch. Installing under the user's
; writable LOCALAPPDATA avoids this. Do NOT change back to {autopf} -- an elevated
; "all users" install lands in read-only Program Files and breaks the app.
DefaultDirName={localappdata}\Programs\{#MyAppDirName}
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
; Never request elevation and never offer the "all users" choice -- an elevated /
; Program Files install lands in a read-only location the runtime cannot start
; from (see the DefaultDirName note above). Removing
; PrivilegesRequiredOverridesAllowed=dialog removes the all-users option entirely.
PrivilegesRequired=lowest
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

[Code]
{ Defense in depth for the per-user install requirement (see [Setup] notes). }
function IsUnderProgramFiles(Path: String): Boolean;
var
  L, Pf, Pf32: String;
begin
  L := Lowercase(Path);
  Pf := Lowercase(ExpandConstant('{commonpf}'));
  Pf32 := Lowercase(ExpandConstant('{commonpf32}'));
  Result := ((Pf <> '') and (Pos(Pf, L) = 1)) or ((Pf32 <> '') and (Pos(Pf32, L) = 1));
end;

function InitializeSetup(): Boolean;
var
  StaleDir: String;
begin
  Result := True;
  { Warn about a previous broken system-wide ("all users") install in Program Files. }
  StaleDir := ExpandConstant('{commonpf}\{#MyAppDirName}');
  if DirExists(StaleDir) then
    MsgBox('A previous system-wide installation was found at:' + #13#10 + StaleDir + #13#10#13#10 +
           'That copy cannot start when launched normally because it lives in a read-only location.' + #13#10#13#10 +
           'This installer will set up a working per-user copy. Afterwards, please remove the old one ' +
           'from Settings > Apps (removing it requires administrator).',
           mbInformation, MB_OK);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  { Refuse a Program Files target even if the user browses to one or runs setup }
  { elevated -- the runtime cannot launch from a read-only directory. }
  if CurPageID = wpSelectDir then
    if IsUnderProgramFiles(WizardDirValue) then
    begin
      MsgBox('KeepKey Vault must be installed in a writable, per-user location ' +
             '(not under Program Files).' + #13#10#13#10 +
             'Please choose a folder under your user profile, for example:' + #13#10 +
             ExpandConstant('{localappdata}\Programs\{#MyAppDirName}'),
             mbError, MB_OK);
      Result := False;
    end;
end;

