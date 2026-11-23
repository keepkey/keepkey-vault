#!/usr/bin/env python3
"""Describe an already signed/repacked macOS update archive without changing it.

The embedded app identity/hash remain authoritative. The v2 document adds the
SHA256 and byte count of the exact uncompressed tar, including its padding.
No app code, signing tool, device, network or release API is invoked.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile

MAX_TAR_BYTES = 2 * 1024 * 1024 * 1024
MAX_METADATA_BYTES = 65536
IDENTIFIER = "com.keepkey.vault"


def regular(path):
    return not path.is_symlink() and stat.S_ISREG(path.stat().st_mode)


def archive_identity(archive, version, channel, arch):
    app_name = "keepkey-vault" if channel == "stable" else "keepkey-vault-" + channel
    prefix = channel + "-macos-" + arch
    if archive.name != prefix + "-" + app_name + ".app.tar.zst" or not regular(archive):
        raise ValueError("The archive filename must match the requested macOS channel and architecture")
    expected_member = app_name + ".app/Contents/Resources/version.json"
    hasher, total = hashlib.sha256(), 0
    with tempfile.TemporaryDirectory(prefix="keepkey-macos-update-") as temporary:
        tar_path = Path(temporary) / "signed-app.tar"
        process = subprocess.Popen(["zstd", "-d", "-q", "-c", str(archive)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            with tar_path.open("wb") as output:
                while True:
                    block = process.stdout.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    if total > MAX_TAR_BYTES:
                        raise ValueError("The macOS update tar exceeds its supported size bound")
                    hasher.update(block); output.write(block)
            if process.wait(timeout=30) != 0 or total == 0:
                raise ValueError("Could not decompress the signed macOS update archive")
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
            process.stdout.close()
        with tarfile.open(tar_path, "r:") as contents:
            members = []
            for member in contents:
                name = member.name
                while name.startswith("./"):
                    name = name[2:]
                if name == expected_member:
                    members.append(member)
            if len(members) != 1 or not members[0].isfile() or not 0 < members[0].size <= MAX_METADATA_BYTES:
                raise ValueError("The archive must contain one regular bounded app Resources/version.json")
            metadata = json.loads(contents.extractfile(members[0]).read())
    if not isinstance(metadata, dict) or metadata.get("version") != version or metadata.get("channel") != channel or metadata.get("identifier") != IDENTIFIER or metadata.get("name") != app_name:
        raise ValueError("The embedded app version, channel, identifier or name does not match the requested release")
    if not isinstance(metadata.get("hash"), str) or not re.fullmatch(r"[a-z0-9]{1,13}", metadata["hash"]):
        raise ValueError("The embedded app hash is not a safe Electrobun update identity")
    if metadata.get("platform", "macos") != "macos" or metadata.get("arch", arch) != arch:
        raise ValueError("The embedded app platform or architecture does not match the requested release")
    legacy = {"schemaVersion": 1, "identifier": IDENTIFIER, "channel": channel, "version": version,
              "hash": metadata["hash"], "platform": "macos", "arch": arch, "artifact": {"file": archive.name}}
    streaming = {**legacy, "artifact": {**legacy["artifact"], "tarSha256": hasher.hexdigest(), "tarSize": total}}
    return prefix, legacy, streaming


def regenerate(archive, version, channel, arch, output, check=False):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version):
        raise ValueError("An explicit release version is required")
    prefix, legacy, streaming = archive_identity(archive, version, channel, arch)
    documents = {output / (prefix + "-update.json"): legacy, output / (prefix + "-update-v2.json"): streaming}
    if check:
        for path, expected in documents.items():
            if not regular(path) or path.stat().st_size > MAX_METADATA_BYTES or json.loads(path.read_text()) != expected:
                raise ValueError("Update metadata does not match the exact signed archive: " + path.name)
    else:
        output.mkdir(parents=True, exist_ok=True)
        pending = []
        try:
            for path, document in documents.items():
                descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=output)
                pending.append((Path(temporary), path))
                with os.fdopen(descriptor, "w") as target:
                    json.dump(document, target, separators=(",", ":")); target.write("\n")
                    target.flush(); os.fsync(target.fileno())
                os.chmod(temporary, 0o644)
            for temporary, path in pending:
                os.replace(temporary, path)
        finally:
            for temporary, _path in pending:
                temporary.unlink(missing_ok=True)
    return {"status": "pass", "checked": check, "archive": str(archive), "version": version, "channel": channel,
            "arch": arch, "hash": legacy["hash"], "tarSha256": streaming["artifact"]["tarSha256"],
            "tarSize": streaming["artifact"]["tarSize"], "manifests": [str(path) for path in documents]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--channel", choices=["stable", "canary"], default="stable")
    parser.add_argument("--arch", choices=["arm64", "x64"], required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        archive = args.archive.absolute()
        print(json.dumps(regenerate(archive, args.version, args.channel, args.arch, (args.output_dir or archive.parent).absolute(), args.check), indent=2))
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + "\n")
