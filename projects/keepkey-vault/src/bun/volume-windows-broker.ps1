# Runs with Vault's token. Both peers authenticate the kernel-reported pipe PID.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$env:PATH = [Environment]::SystemDirectory
$server = $null
$child = $null
$status = 'failed'
try {
  $source = [Console]::In.ReadLine()
  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::ASCII.GetBytes($source))
  if ([BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant() -cne '__WORKER_DIGEST__') { throw 'worker' }
  $metadata = [Console]::In.ReadLine()
  $secret = [Console]::In.ReadLine()
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class VaultPipePeer {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
}
'@
  $pipeName = 'KeepKeyVault-' + [guid]::NewGuid().ToString('N')
  $acl = New-Object IO.Pipes.PipeSecurity
  $acl.SetAccessRuleProtection($true, $false)
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $network = [Security.Principal.SecurityIdentifier]::new('S-1-5-2')
  $acl.AddAccessRule([IO.Pipes.PipeAccessRule]::new($network, 'FullControl', 'Deny'))
  $acl.AddAccessRule([IO.Pipes.PipeAccessRule]::new($me, 'FullControl', 'Allow'))
  $server = [IO.Pipes.NamedPipeServerStream]::new($pipeName, 'InOut', 1, 'Byte', 'Asynchronous', 16384, 16384, $acl)
  $connection = $server.BeginWaitForConnection($null, $null)
  # Only the random pipe name, our PID and a build-source digest enter the privileged command.
  # Shipping the authenticated helper over the existing pipe avoids the Windows command-line size limit.
  $bootstrap = '$pipeName="' + $pipeName + '";$brokerPid=' + [int]$PID + ';' +
    '$client=[IO.Pipes.NamedPipeClientStream]::new(".",$pipeName,"InOut","Asynchronous","Identification");$client.Connect(20000);' +
    '$inputReader=[IO.StreamReader]::new($client);$pending=$inputReader.ReadLineAsync();if(!$pending.Wait(20000)){exit 2};$packed=$pending.Result;' +
    '$sum=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::ASCII.GetBytes($packed));' +
    'if([BitConverter]::ToString($sum).Replace("-","").ToLowerInvariant() -cne "__WORKER_DIGEST__"){exit 2};' +
    '$data=[IO.MemoryStream]::new([Convert]::FromBase64String($packed));' +
    '$gzip=[IO.Compression.GZipStream]::new($data,[IO.Compression.CompressionMode]::Decompress);' +
    '$reader=[IO.StreamReader]::new($gzip);& ([scriptblock]::Create($reader.ReadToEnd()))'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
  if ($encoded.Length -gt 30000) { throw 'length' }
  $process = New-Object Diagnostics.ProcessStartInfo
  $process.FileName = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\powershell.exe')
  $process.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encoded
  $process.WorkingDirectory = [Environment]::SystemDirectory
  $process.UseShellExecute = $true
  $process.WindowStyle = 'Hidden'
  $identity = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (!$identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $process.Verb = 'runas' }
  try { $child = [Diagnostics.Process]::Start($process) } catch { $status = 'denied'; throw }
  if (!$connection.AsyncWaitHandle.WaitOne(30000)) { $status = 'account'; throw 'connection' }
  $server.EndWaitForConnection($connection)
  [uint32]$peer = 0
  if ($child.HasExited -or ![VaultPipePeer]::GetNamedPipeClientProcessId($server.SafePipeHandle, [ref]$peer) -or $peer -ne $child.Id) { throw 'peer' }
  $stream = [IO.StreamWriter]::new($server, [Text.UTF8Encoding]::new($false), 4096, $true)
  $stream.WriteLine($source)
  $stream.WriteLine($metadata)
  $stream.WriteLine($secret)
  $stream.Flush()
  $secret = $null
  $result = [IO.StreamReader]::new($server).ReadLineAsync()
  if (!$result.Wait(900000)) { $status = 'timeout'; throw 'timeout' }
  if ($result.Result -cin @('ok','failed','invalid','busy')) { $status = $result.Result }
} catch {} finally {
  if ($server) { $server.Dispose() }
  if ($child) { $child.Dispose() }
}
[Console]::Out.WriteLine($status)
