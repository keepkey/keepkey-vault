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
; Kill stale bun/launcher processes that hold file locks and prevent reinstall
CloseApplications=force
CloseApplicationsFilter=bun.exe,launcher.exe,KeepKeyVault.exe
; Enable installer logging by default for diagnostics
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Clean stale hashed assets from prior versions — Vite generates unique filenames
; per build, and old files accumulate causing slow WebView2 startup.
Type: filesandordirs; Name: "{app}\Resources\app\views\mainview\assets"
; Clean Electrobun self-extraction state (update archives, update.bat scripts).
Type: filesandordirs; Name: "{localappdata}\sh.keepkey.vault"
; Clean old Electrobun self-extractor install (dir name has space — different from Inno path)
Type: filesandordirs; Name: "{localappdata}\KeepKey Vault"
; Clean stale dev-mode WebView2 profiles (528MB+ of accumulated junk)
; CRITICAL: Do NOT delete {localappdata}\com.keepkey.vault — that contains the
; warm WebView2 profile. Evidence (retro-installer-failure-2026-03-22.md) proved
; that deleting it forces a WebView2 cold-start which HANGS on some Win11 machines.
; CreateCoreWebView2EnvironmentWithOptions never completes from a fresh profile.
; Only clean the dev/ subdirectory (stale dev-mode profiles).
Type: filesandordirs; Name: "{localappdata}\com.keepkey.vault\dev"

[UninstallDelete]
; Remove Electrobun runtime state on uninstall so reinstall starts clean.
; Without this, %LOCALAPPDATA% residue survives uninstall and poisons future installs.
Type: filesandordirs; Name: "{localappdata}\sh.keepkey.vault"
Type: filesandordirs; Name: "{localappdata}\com.keepkey.vault"
Type: filesandordirs; Name: "{localappdata}\KeepKey Vault"

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
; Post-install launch — user can opt in via checkbox. Uses nowait so installer exits cleanly.
; NOTE: skipifsilent prevents zombie processes from silent/automated installs.
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Remove orphaned Electrobun update scheduled tasks on uninstall.
; These tasks run update.bat scripts that can corrupt the install directory
; if they fire after uninstall or during a reinstall.
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {{ $_.TaskName -like 'ElectrobunUpdate_*' }} | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden

[Code]
// Force-kill any running KeepKey Vault processes before installation.
// Without this, bun.exe holds locks on DLLs and the install directory,
// causing partial installs and zombie processes that survive reboots.
//
// CRITICAL: msedgewebview2.exe must also be killed. Evidence from the v1.2.5
// investigation (evidence-2026-03-22-session.md) proved that 11 orphaned
// msedgewebview2 processes were holding locks on the WebView2 user data folder,
// preventing all subsequent launches from initializing. These processes survive
// force-killing bun.exe and accumulate across failed launch attempts.
//
// NOTE: taskkill /F /IM msedgewebview2.exe will kill ALL WebView2 processes
// system-wide, including any from Edge browser tabs. This is acceptable during
// install/uninstall because the user is explicitly choosing to install/remove
// the app. A more targeted approach (killing only KeepKey-spawned WebView2
// processes) would require enumerating process trees, which Inno Setup cannot do.
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
  // Kill orphaned WebView2 renderer processes that lock the user data folder.
  // This is the root cause of the v1.2.5 poison — these survive app process kills.
  Exec('taskkill.exe', '/F /IM msedgewebview2.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('KillKeepKeyProcesses: msedgewebview2.exe result=' + IntToStr(ResultCode));
  Sleep(2000); // Wait for file handles to release
  Log('KillKeepKeyProcesses: done');
end;

// Remove orphaned ElectrobunUpdate_* scheduled tasks that can corrupt
// the install directory. Uses PowerShell for reliable task enumeration.
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
// These scripts are scheduled via Task Scheduler and attempt to rmdir /s /q
// the app directory — if they fire during or after a reinstall, they corrupt it.
procedure CleanStaleUpdateScripts();
var
  ResultCode: Integer;
  AppDataPath: String;
begin
  Log('CleanStaleUpdateScripts: starting');
  AppDataPath := ExpandConstant('{localappdata}');
  // update.bat lives in the parent of the app directory under Electrobun's state tree
  Exec('cmd.exe',
    '/c del /q "' + AppDataPath + '\sh.keepkey.vault\stable\update.bat" 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('cmd.exe',
    '/c del /q "' + AppDataPath + '\sh.keepkey.vault\canary\update.bat" 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('cmd.exe',
    '/c del /q "' + AppDataPath + '\sh.keepkey.vault\dev\update.bat" 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Remove the old Electrobun self-extractor uninstall registry entry.
// Evidence shows a duplicate "KeepKey Vault" (no version) entry pointing to
// %LOCALAPPDATA%\KeepKey Vault\uninstall.exe — from the pre-Inno installer era.
procedure CleanOldElectrobunRegistry();
var
  ResultCode: Integer;
begin
  Log('CleanOldElectrobunRegistry: starting');
  // Try running the old uninstaller silently if it exists
  if FileExists(ExpandConstant('{localappdata}\KeepKey Vault\uninstall.exe')) then
  begin
    Log('CleanOldElectrobunRegistry: found old uninstaller, running silently');
    Exec(ExpandConstant('{localappdata}\KeepKey Vault\uninstall.exe'),
      '/SILENT', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('CleanOldElectrobunRegistry: old uninstaller result=' + IntToStr(ResultCode));
  end;
  // Remove registry key if it still exists
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepKey Vault');
  Log('CleanOldElectrobunRegistry: done');
end;

function InitializeSetup(): Boolean;
begin
  Log('InitializeSetup: v1.2.6 antidote starting');
  // Kill processes first — they may hold locks on files we need to clean
  KillKeepKeyProcesses();
  // Remove scheduled tasks before they can fire during install
  CleanOrphanedScheduledTasks();
  // Remove stale update scripts
  CleanStaleUpdateScripts();
  // Clean up old Electrobun self-extractor install
  CleanOldElectrobunRegistry();
  Log('InitializeSetup: antidote cleanup complete');
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    // Kill again right before file copy in case something respawned
    KillKeepKeyProcesses();
  end;
end;

// Also clean up on uninstall — kill processes so uninstaller can remove all files
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    KillKeepKeyProcesses();
    CleanOrphanedScheduledTasks();
    CleanStaleUpdateScripts();
  end;
end;

