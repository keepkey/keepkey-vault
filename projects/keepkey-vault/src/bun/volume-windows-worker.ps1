# Only the unprivileged broker may supply data to this process.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$env:PATH = [Environment]::SystemDirectory
$scratch = $null
$writer = $null
$status = 'failed'
$secure = $null
try {
  # Windows PowerShell 5.1 compiles Add-Type using temporary files. Keep these in an admin-owned directory.
  $scratch = [IO.Path]::Combine([Environment]::GetFolderPath('ProgramFiles'), 'KeepKeyVolume-' + [guid]::NewGuid().ToString('N'))
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $admin = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $acl.SetOwner($admin)
  foreach ($principal in @($admin, $system)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  [void][IO.Directory]::CreateDirectory($scratch, $acl)
  $env:TMP = $scratch
  $env:TEMP = $scratch
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class VaultVolumeBroker {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
  public static void Watch(int pid) {
    Process broker = Process.GetProcessById(pid);
    Thread monitor = new Thread(delegate() {
      try { broker.WaitForExit(900000); } finally { Environment.Exit(2); }
    });
    monitor.IsBackground = true;
    monitor.Start();
  }
}
'@
  [uint32]$peer = 0
  if (![VaultVolumeBroker]::GetNamedPipeServerProcessId($client.SafePipeHandle, [ref]$peer) -or $peer -ne $brokerPid) { throw 'peer' }
  [VaultVolumeBroker]::Watch([int]$brokerPid)
  $writer = [IO.StreamWriter]::new($client, [Text.UTF8Encoding]::new($false), 1024, $true)
  $writer.AutoFlush = $true
  $Request = $inputReader.ReadLine() | ConvertFrom-Json
  $credential = $inputReader.ReadLine()
  $status = 'invalid'
  try {
    $path = $Request.path
    $action = $Request.action
    $packageDir = [IO.Path]::GetDirectoryName($path)
    $package = [IO.Path]::GetFileName($packageDir)
    $root = [IO.Path]::GetDirectoryName($packageDir)
    if ($action -cnotin @('create', 'unlock', 'lock') -or $path -isnot [string] -or
        $path -cnotmatch '^[A-Za-z]:\\' -or $path.IndexOf(':', 2) -ge 0 -or $path.Contains('/') -or
        [IO.Path]::GetFullPath($path) -cne $path -or [IO.Path]::GetFileName($path) -cne 'payload.vhdx' -or
        [IO.Path]::GetFileName($root) -cne 'KeepKey Volumes') { throw 'path' }
    $base = [IO.Path]::GetDirectoryName($root)
    $profilePath = [Environment]::GetFolderPath('UserProfile')
    if (![string]::Equals($base, $profilePath, [StringComparison]::OrdinalIgnoreCase)) {
      if ($base -notmatch '^[A-Za-z]:\\$') { throw 'root' }
      $part = @(Get-Partition -DriveLetter $base[0] -ErrorAction Stop)
      if ($part.Count -ne 1 -or $part[0].IsBoot -or $part[0].IsSystem) { throw 'partition' }
      $disk = Get-Disk -Number $part[0].DiskNumber -ErrorAction Stop
      if ($disk.IsBoot -or $disk.IsSystem -or [string]$disk.BusType -notin @('USB','SD','MMC','1394')) { throw 'disk' }
    }
    $namePattern = '^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]{0,63}\z'
    if ($action -eq 'create') {
      if ($package -cnotmatch '^\.creating-[A-Za-z0-9]{6}\z' -or $Request.name -isnot [string] -or
          $Request.name -cnotmatch $namePattern -or $Request.name.Trim() -cne $Request.name -or
          $Request.sizeMiB -isnot [ValueType] -or [int]$Request.sizeMiB -ne $Request.sizeMiB -or
          $Request.sizeMiB -lt 128 -or $Request.sizeMiB -gt 65536) { throw 'create' }
    } else {
      if (!$package.EndsWith('.kkvolume', [StringComparison]::Ordinal) -or
          $package.Substring(0, $package.Length - 9) -cnotmatch $namePattern) { throw 'package' }
    }
    if ($action -in @('create','unlock')) {
      if ($credential -cnotmatch '^[0-9a-f]{64}\z' -or $Request.recordId -cnotmatch '^[0-9a-f]{32}\z') { throw 'credential' }
      $secure = [Security.SecureString]::new()
      for ($i = 0; $i -lt $credential.Length; $i++) { $secure.AppendChar($credential[$i]) }
      $secure.MakeReadOnly()
    } elseif ($credential.Length) { throw 'credential' }
    # Keep plaintext out of cmdlet parameter binding and PowerShell module logs.
    $Request.PSObject.Properties.Add([Management.Automation.PSNoteProperty]::new('credential', $secure))
    $credential = $null
    $status = 'failed'
    # Only this embedded function can perform a privileged operation.
    __VOLUME_ACTION_FUNCTIONS__
    $null = Invoke-KeepKeyVolumeAction $Request
    $status = 'ok'
  } catch {} finally {
    $Request = $null
    $credential = $null
    if ($secure) { $secure.Dispose() }
  }
} catch {} finally {
  if ($scratch -and [IO.Directory]::Exists($scratch)) { [IO.Directory]::Delete($scratch, $true) }
  if ($writer) { $writer.WriteLine($status) }
  if ($client) { $client.Dispose() }
}
