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
WizardImageFile={#MyScriptDir}\installer-wizard.bmp
WizardSmallImageFile={#MyScriptDir}\installer-small.bmp
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\Resources\app-real.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
CloseApplications=force
CloseApplicationsFilter=bun.exe,launcher.exe,KeepKeyVault.exe
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Clean stale hashed assets from prior versions — Vite generates unique filenames
; per build, and old files accumulate causing slow WebView2 startup.
Type: filesandordirs; Name: "{app}\Resources\app\views\mainview\assets"
; Clean Electrobun update state (update archives, update.bat scripts).
; This is safe — no runtime state lives here, only update mechanism residue.
Type: filesandordirs; Name: "{localappdata}\sh.keepkey.vault"
; Clean old Electrobun self-extractor install directory (has space in name).
Type: filesandordirs; Name: "{localappdata}\KeepKey Vault"
; Clean stale dev-mode WebView2 profiles (can reach 500MB+).
Type: filesandordirs; Name: "{localappdata}\com.keepkey.vault\dev"
;
; IMPORTANT: Do NOT delete {localappdata}\com.keepkey.vault itself.
; Evidence (retro-installer-failure-2026-03-22.md) proved that the warm
; WebView2 user data profile in that directory is the only thing that
; allows the app to launch on the affected Win11 machine.
; CreateCoreWebView2EnvironmentWithOptions hangs on cold-start from a
; fresh profile. Until we understand and fix the cold-start hang (likely
; requires Electrobun fork + native layer logging), this profile MUST
; be preserved across both install and uninstall.

[UninstallDelete]
; Same conservative policy as [InstallDelete]: clean update state and
; old installs, but preserve the WebView2 profile so uninstall+reinstall
; does not put the user back into cold-start territory.
Type: filesandordirs; Name: "{localappdata}\sh.keepkey.vault"
Type: filesandordirs; Name: "{localappdata}\KeepKey Vault"
Type: filesandordirs; Name: "{localappdata}\com.keepkey.vault\dev"

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

[UninstallRun]
; Remove orphaned Electrobun update scheduled tasks on uninstall.
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {{ $_.TaskName -like 'ElectrobunUpdate_*' }} | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden

[Code]
// Kill KeepKey Vault app processes so the installer can overwrite files.
// Only kills our own processes — NOT msedgewebview2.exe. Evidence showed
// that killing WebView2 processes system-wide did not fix the launch failure
// and is too blunt for an installer action.
procedure KillKeepKeyProcesses();
var
  ResultCode: Integer;
begin
  Log('KillKeepKeyProcesses: starting');
  Exec('taskkill.exe', '/F /IM KeepKeyVault.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('KillKeepKeyProcesses: KeepKeyVault.exe result=' + IntToStr(ResultCode));
  Exec('taskkill.exe', '/F /IM launcher.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('KillKeepKeyProcesses: launcher.exe result=' + IntToStr(ResultCode));
  Exec('taskkill.exe', '/F /IM bun.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('KillKeepKeyProcesses: bun.exe result=' + IntToStr(ResultCode));
  Sleep(2000);
  Log('KillKeepKeyProcesses: done');
end;

// Remove orphaned ElectrobunUpdate_* scheduled tasks.
procedure CleanOrphanedScheduledTasks();
var
  ResultCode: Integer;
begin
  Log('CleanOrphanedScheduledTasks: starting');
  Exec('powershell.exe',
    '-NoProfile -Command "Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like ''ElectrobunUpdate_*'' } | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('CleanOrphanedScheduledTasks: result=' + IntToStr(ResultCode));
end;

// Delete stale update.bat files left by Electrobun's update mechanism.
procedure CleanStaleUpdateScripts();
var
  ResultCode: Integer;
  AppDataPath: String;
begin
  Log('CleanStaleUpdateScripts: starting');
  AppDataPath := ExpandConstant('{localappdata}');
  Exec('cmd.exe',
    '/c del /q "' + AppDataPath + '\sh.keepkey.vault\stable\update.bat" 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('cmd.exe',
    '/c del /q "' + AppDataPath + '\sh.keepkey.vault\canary\update.bat" 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('cmd.exe',
    '/c del /q "' + AppDataPath + '\sh.keepkey.vault\dev\update.bat" 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('CleanStaleUpdateScripts: done');
end;

// Remove the old Electrobun self-extractor registry entry if present.
procedure CleanOldElectrobunRegistry();
var
  ResultCode: Integer;
begin
  Log('CleanOldElectrobunRegistry: starting');
  if FileExists(ExpandConstant('{localappdata}\KeepKey Vault\uninstall.exe')) then
  begin
    Log('CleanOldElectrobunRegistry: found old uninstaller, running silently');
    Exec(ExpandConstant('{localappdata}\KeepKey Vault\uninstall.exe'),
      '/SILENT', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('CleanOldElectrobunRegistry: old uninstaller result=' + IntToStr(ResultCode));
  end;
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepKey Vault');
  Log('CleanOldElectrobunRegistry: done');
end;

function InitializeSetup(): Boolean;
begin
  Log('InitializeSetup: starting');
  KillKeepKeyProcesses();
  CleanOrphanedScheduledTasks();
  CleanStaleUpdateScripts();
  CleanOldElectrobunRegistry();
  Log('InitializeSetup: cleanup complete');
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    KillKeepKeyProcesses();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    KillKeepKeyProcesses();
    CleanOrphanedScheduledTasks();
    CleanStaleUpdateScripts();
  end;
end;
