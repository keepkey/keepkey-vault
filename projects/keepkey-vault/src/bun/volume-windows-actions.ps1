# Invoked only inside the one-action UAC worker. All image and volume objects
# are resolved from a local, pinned package path. No raw disk IDs are accepted.
function Initialize-KeepKeyVirtualDiskApi {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class KeepKeyVhd {
    [StructLayout(LayoutKind.Sequential)]
    struct StorageType { public uint Device; public Guid Vendor; }
    [StructLayout(LayoutKind.Sequential)]
    struct CreateV2 {
        public Guid UniqueId;
        public ulong MaximumSize;
        public uint BlockSize, LogicalSector, PhysicalSector;
        public IntPtr ParentPath, SourcePath;
        public uint OpenFlags;
        public StorageType ParentType, SourceType;
        public Guid Resiliency;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct CreateParameters { public uint Version; public CreateV2 V2; }
    [StructLayout(LayoutKind.Sequential)]
    struct OpenV2 { public uint Version, GetInfoOnly, ReadOnly; public Guid Resiliency; }
    [StructLayout(LayoutKind.Explicit, Size=64)]
    struct DiskInfo {
        [FieldOffset(0)] public uint Version;
        [FieldOffset(8)] public uint Subtype;
        [FieldOffset(8)] public Guid Identifier;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct AttachParameters { public uint Version, Reserved; }
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfoNative {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHi, SizeLo, Links, IndexHi, IndexLo;
    }
    [DllImport("virtdisk.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern uint CreateVirtualDisk(ref StorageType type, string path, uint access,
        IntPtr descriptor, uint flags, uint providerFlags, ref CreateParameters parameters, IntPtr overlapped, out SafeFileHandle handle);
    [DllImport("virtdisk.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern uint OpenVirtualDisk(ref StorageType type, string path, uint access, uint flags,
        ref OpenV2 parameters, out SafeFileHandle handle);
    [DllImport("virtdisk.dll", ExactSpelling=true)]
    static extern uint GetVirtualDiskInformation(SafeFileHandle handle, ref uint bytes, ref DiskInfo info, out uint used);
    [DllImport("virtdisk.dll", ExactSpelling=true)]
    static extern uint AttachVirtualDisk(SafeFileHandle handle, IntPtr descriptor, uint flags,
        uint providerFlags, ref AttachParameters parameters, IntPtr overlapped);
    [DllImport("virtdisk.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern uint GetVirtualDiskPhysicalPath(SafeFileHandle handle, ref uint bytes, StringBuilder device);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfoNative info);

    // Hold real read access so the share checks participate. Directory handles
    // deny write and delete, while the payload allows the VHD provider to
    // write. OPEN_REPARSE_POINT makes each check inspect the link itself.
    public static List<SafeFileHandle> Pin(string path, bool existing) {
        var directories = new Stack<string>();
        for (var parent=Directory.GetParent(path); parent!=null; parent=parent.Parent) {
            // The root is checked via the mounted volume identity in the runner.
            if (parent.Parent!=null) directories.Push(parent.FullName);
        }
        var held = new List<SafeFileHandle>();
        try {
            while (directories.Count>0) held.Add(PinOne(directories.Pop(), true));
            if (existing) held.Add(PinOne(path, false));
            return held;
        } catch {
            foreach (var h in held) h.Dispose();
            throw;
        }
    }
    static SafeFileHandle PinOne(string path, bool directory) {
        var h = CreateFileW(path, 1, directory ? 1u : 3u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        FileInfoNative info;
        if (h.IsInvalid || !GetFileInformationByHandle(h,out info) ||
            (info.Attributes & 0x400)!=0 || ((info.Attributes & 0x10)!=0)!=directory ||
            (!directory && info.Links!=1)) {
            h.Dispose(); throw new IOException("Unsafe volume path.");
        }
        return h;
    }
    public static void VerifyStandalone(string path, string recordId) {
        var type = new StorageType { Device=3, Vendor=new Guid("ec984aec-a0f9-47e9-901f-71415a66345b") };
        var open = new OpenV2 { Version=2, GetInfoOnly=1, ReadOnly=1 };
        SafeFileHandle handle;
        // NO_PARENTS prevents loading an image-specified parent, including a remote one.
        if (OpenVirtualDisk(ref type,path,0,1,ref open,out handle)!=0) throw new IOException("Invalid VHDX.");
        using (handle) {
            uint bytes=64, used;
            var info = new DiskInfo { Version=7 };
            if (GetVirtualDiskInformation(handle,ref bytes,ref info,out used)!=0 || info.Subtype!=3)
                throw new IOException("Expected a standalone expanding VHDX.");
            if (!String.IsNullOrEmpty(recordId)) {
                bytes=64; info = new DiskInfo { Version=2 };
                if (GetVirtualDiskInformation(handle,ref bytes,ref info,out used)!=0 ||
                    info.Identifier!=Guid.ParseExact(recordId,"N")) throw new IOException("Wrong VHDX identity.");
            }
        }
    }
    public static SafeFileHandle Create(string path, int sizeMiB, Guid id) {
        var type = new StorageType { Device=3, Vendor=new Guid("ec984aec-a0f9-47e9-901f-71415a66345b") };
        var p = new CreateParameters { Version=2, V2=new CreateV2 {
            UniqueId=id, MaximumSize=(ulong)sizeMiB*1048576, LogicalSector=512, PhysicalSector=4096
        }};
        SafeFileHandle h;
        // No parent/source and no full-allocation or overwrite flag. An
        // existing file causes CreateVirtualDisk to fail.
        if (CreateVirtualDisk(ref type,path,0,IntPtr.Zero,0,0,ref p,IntPtr.Zero,out h)!=0)
            throw new IOException("Could not create a new VHDX.");
        return h;
    }
    public static string AttachNew(SafeFileHandle h) {
        var p = new AttachParameters { Version=1 };
        // No PERMANENT_LIFETIME: closing this handle detaches the new disk.
        if (AttachVirtualDisk(h,IntPtr.Zero,0,0,ref p,IntPtr.Zero)!=0) throw new IOException("VHDX attach failed.");
        var device = new StringBuilder(256); uint bytes = (uint)device.Capacity*2;
        if (GetVirtualDiskPhysicalPath(h,ref bytes,device)!=0) throw new IOException("VHDX identity unavailable.");
        return device.ToString();
    }
}
'@
}

function Get-KeepKeyImage($path) {
    $images = @(Get-DiskImage -ImagePath $path -StorageType VHDX -ErrorAction Stop)
    if ($images.Count -ne 1 -or [int]$images[0].CimInstanceProperties['StorageType'].Value -ne 3 -or $images[0].ImagePath -ne $path) {
        throw 'image'
    }
    return $images[0]
}

function Get-KeepKeyDisk($path, $physicalPath, $expectedId) {
    $image = Get-KeepKeyImage $path
    if (!$image.Attached -or $image.DevicePath -notmatch '^\\\\\.\\PhysicalDrive[0-9]+$' -or
        ($physicalPath -and $physicalPath -ne $image.DevicePath)) { throw 'image' }
    $disks = @($image | Get-Disk -ErrorAction Stop)
    if ($disks.Count -ne 1) { throw 'image' }
    $disk = $disks[0]
    # STORAGE_BUS_TYPE 15 is BusTypeFileBackedVirtual.
    if ([int]$disk.CimInstanceProperties['BusType'].Value -ne 15 -or $disk.Number -ne $image.Number -or $disk.IsBoot -ne $false -or
        $disk.IsSystem -ne $false -or !$disk.UniqueId -or $disk.Size -ne $image.Size) { throw 'image' }
    if ($expectedId -and ([guid]$disk.Guid).ToString('N') -ne $expectedId) { throw 'image' }
    return $disk
}

function Get-KeepKeyDataPartition($disk) {
    $partitions = @($disk | Get-Partition -ErrorAction Stop)
    $basic = @(foreach ($part in $partitions) {
        if ($part.DiskNumber -ne $disk.Number -or $part.IsSystem -or $part.IsBoot) { throw 'image' }
        $type = ([guid]$part.GptType).ToString('D')
        if ($type -eq 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7') { $part }
        elseif ($type -ne 'e3c9e316-0b5c-4db8-817d-f92df00215ae') { throw 'image' }
    })
    if ($basic.Count -ne 1 -or !$basic[0].Guid) { throw 'image' }
    return $basic[0]
}

function Get-KeepKeyVolume($disk) {
    $partition = Get-KeepKeyDataPartition $disk
    $volumes = @($partition | Get-Volume -ErrorAction Stop)
    if ($volumes.Count -ne 1 -or $volumes[0].Path -notmatch '^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$') { throw 'image' }
    return $volumes[0]
}

# The BitLocker cmdlets accept drive letters. Re-resolve the letter and match
# its stable volume GUID immediately before each BitLocker call.
function Get-KeepKeyMountPoint($volume) {
    $letter = [string]$volume.DriveLetter
    if ($letter -notmatch '^[A-Z]$') { throw 'image' }
    $current = @(Get-Volume -DriveLetter $letter -ErrorAction Stop)
    if ($current.Count -ne 1 -or $current[0].Path -ne $volume.Path) { throw 'image' }
    return $letter + ':'
}

function Confirm-KeepKeyProtection($status) {
    if ($status.VolumeType -ne 'Data' -or $status.AutoUnlockEnabled -eq $true -or
        $status.VolumeStatus -ne 'FullyEncrypted' -or $status.ProtectionStatus -ne 'On' -or
        @($status.KeyProtector).Count -ne 1 -or $status.KeyProtector[0].KeyProtectorType -ne 'Password') { throw 'protection' }
}

function Invoke-KeepKeyVolumeAction($Request) {
    $ErrorActionPreference = 'Stop'
    $WarningPreference = 'SilentlyContinue'
    $ProgressPreference = 'SilentlyContinue'
    $path = [string]$Request.path
    $op = [string]$Request.action
    if ($op -notin @('create','unlock','lock') -or $path -notmatch '^[A-Za-z]:\\' -or
        $path.Substring(2) -match '[:\x00-\x1F<>"|?*]' -or [IO.Path]::GetFullPath($path) -cne $path -or
        [IO.Path]::GetFileName($path) -ne 'payload.vhdx') { throw 'path' }
    $parent = [IO.Directory]::GetParent($path)
    if ($null -eq $parent.Parent -or $parent.Parent.Name -ne 'KeepKey Volumes') { throw 'path' }
    if ($op -eq 'create') {
        if ($parent.Name -cnotmatch '^\.creating-[a-zA-Z0-9]{6}$' -or $Request.sizeMiB -lt 128 -or $Request.sizeMiB -gt 65536 -or
            [string]$Request.name -notmatch '^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]{0,63}$') { throw 'path' }
    } elseif ($parent.Name -notmatch '\.kkvolume$') { throw 'path' }
    if ($op -ne 'lock' -and ([string]$Request.recordId -cnotmatch '^[0-9a-f]{32}$' -or
        $Request.credential -isnot [Security.SecureString] -or $Request.credential.Length -ne 64)) { throw 'credential' }

    Initialize-KeepKeyVirtualDiskApi
    $pins = [KeepKeyVhd]::Pin($path, $op -ne 'create')
    $newHandle = $null
    $attachedHere = $false
    $unlockConfirmed = $false
    $password = $null
    try {
        if ($op -ne 'lock') {
            $password = $Request.credential
        }
        if ($op -eq 'create') {
            $id = [guid]::ParseExact($Request.recordId, 'N')
            $newHandle = [KeepKeyVhd]::Create($path, $Request.sizeMiB, $id)
            $physicalPath = [KeepKeyVhd]::AttachNew($newHandle)
            $disk = Get-KeepKeyDisk $path $physicalPath $null
            if ($disk.PartitionStyle -ne 'RAW' -or $disk.NumberOfPartitions -ne 0 -or
                $disk.Size -ne ([uint64]$Request.sizeMiB * 1MB)) { throw 'image' }
            if ($disk.IsOffline) {
                Set-Disk -InputObject $disk -IsOffline $false
                $disk = Get-KeepKeyDisk $path $physicalPath $null
                if ($disk.PartitionStyle -ne 'RAW' -or $disk.NumberOfPartitions -ne 0) { throw 'image' }
            }
            Initialize-Disk -InputObject $disk -PartitionStyle GPT -Confirm:$false
            $disk = Get-KeepKeyDisk $path $physicalPath $null
            Set-Disk -InputObject $disk -Guid $id.ToString('B')
            $disk = Get-KeepKeyDisk $path $physicalPath $Request.recordId
            $created = New-Partition -InputObject $disk -UseMaximumSize -AssignDriveLetter
            $disk = Get-KeepKeyDisk $path $physicalPath $Request.recordId
            $partition = Get-KeepKeyDataPartition $disk
            if ($created.Guid -ne $partition.Guid -or $created.DiskNumber -ne $disk.Number) { throw 'image' }
            # NTFS permits a maximum label length of 32 UTF-16 code units.
            $label = [string]$Request.name
            if ($label.Length -gt 32) {
                $length = if ([char]::IsHighSurrogate($label[31])) { 31 } else { 32 }
                $label = $label.Substring(0, $length)
            }
            $null = Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel $label -Confirm:$false
            $volume = Get-KeepKeyVolume (Get-KeepKeyDisk $path $physicalPath $Request.recordId)
            if ($volume.FileSystemType -ne 'NTFS') { throw 'image' }
            $null = Enable-BitLocker -MountPoint (Get-KeepKeyMountPoint $volume) -EncryptionMethod XtsAes256 -PasswordProtector -Password $password -UsedSpaceOnly -Confirm:$false
            $deadline = [DateTime]::UtcNow.AddMinutes(7)
            do {
                $status = Get-BitLockerVolume -MountPoint (Get-KeepKeyMountPoint $volume)
                if ($status.VolumeStatus -eq 'FullyEncrypted') { break }
                if ([DateTime]::UtcNow -ge $deadline) { throw 'protection' }
                Start-Sleep -Milliseconds 500
            } while ($true)
            if ($status.AutoUnlockEnabled -eq $true) { $null = Disable-BitLockerAutoUnlock -MountPoint (Get-KeepKeyMountPoint $volume) }
            Confirm-KeepKeyProtection (Get-BitLockerVolume -MountPoint (Get-KeepKeyMountPoint $volume))
            $null = Lock-BitLocker -MountPoint (Get-KeepKeyMountPoint $volume) -Confirm:$false
            if ((Get-BitLockerVolume -MountPoint (Get-KeepKeyMountPoint $volume)).LockStatus -ne 'Locked') { throw 'busy' }
            $newHandle.Dispose()
            $newHandle = $null
            if ((Get-KeepKeyImage $path).Attached) { throw 'busy' }
            [KeepKeyVhd]::VerifyStandalone($path, $Request.recordId)
            return
        }

        [KeepKeyVhd]::VerifyStandalone($path, $Request.recordId)
        $image = Get-KeepKeyImage $path
        if ($op -eq 'unlock') {
            if ($image.Attached) { throw 'busy' }
            $null = Mount-DiskImage -ImagePath $path -StorageType VHDX -Access ReadWrite -PassThru
            $attachedHere = $true
        } elseif (!$image.Attached) { return }
        $expectedId = $null
        if ($op -eq 'unlock') { $expectedId = $Request.recordId }
        $disk = Get-KeepKeyDisk $path $null $expectedId
        if ($disk.IsOffline -and $op -eq 'unlock') {
            Set-Disk -InputObject $disk -IsOffline $false
            $disk = Get-KeepKeyDisk $path $null $expectedId
        }
        $volume = Get-KeepKeyVolume $disk
        if ([string]$volume.DriveLetter -notmatch '^[A-Z]$' -and $op -eq 'unlock') {
            Add-PartitionAccessPath -InputObject (Get-KeepKeyDataPartition $disk) -AssignDriveLetter
            $volume = Get-KeepKeyVolume (Get-KeepKeyDisk $path $null $expectedId)
        }
        $before = Get-BitLockerVolume -MountPoint (Get-KeepKeyMountPoint $volume)
        if ($before.VolumeType -ne 'Data') { throw 'image' }
        if ($op -eq 'unlock') {
            if ($before.LockStatus -ne 'Locked') { throw 'protection' }
            $null = Unlock-BitLocker -MountPoint (Get-KeepKeyMountPoint $volume) -Password $password -Confirm:$false
            $after = Get-BitLockerVolume -MountPoint (Get-KeepKeyMountPoint $volume)
            Confirm-KeepKeyProtection $after
            if ($after.LockStatus -ne 'Unlocked') { throw 'credential' }
            $readable = Get-KeepKeyVolume (Get-KeepKeyDisk $path $image.DevicePath $expectedId)
            if ($readable.Path -ne $volume.Path -or $readable.FileSystemType -ne 'NTFS' -or [string]$readable.DriveLetter -notmatch '^[A-Z]$') { throw 'image' }
            $unlockConfirmed = $true
        } else {
            if ($before.LockStatus -eq 'Unlocked') {
                $letter = Get-KeepKeyMountPoint $volume
                try { $null = Lock-BitLocker -MountPoint $letter -Confirm:$false } catch { throw 'busy' }
            }
            if ((Get-BitLockerVolume -MountPoint (Get-KeepKeyMountPoint $volume)).LockStatus -ne 'Locked') { throw 'busy' }
            Dismount-DiskImage -ImagePath $path -StorageType VHDX -Confirm:$false
            if ((Get-KeepKeyImage $path).Attached) { throw 'busy' }
        }
    } finally {
        if ($attachedHere -and !$unlockConfirmed) {
            Dismount-DiskImage -ImagePath $path -StorageType VHDX -ErrorAction SilentlyContinue
        }
        if ($newHandle) { $newHandle.Dispose() }
        if ($password) { $password.Dispose() }
        foreach ($handle in $pins) { $handle.Dispose() }
    }
}
