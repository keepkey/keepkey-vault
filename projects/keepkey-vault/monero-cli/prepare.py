#!/usr/bin/env python3
"""Prepare pinned, signed official Monero wallet RPC and node. Never starts a wallet/network."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
VERSION = "0.18.5.4"
FINGERPRINT = "81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92"
KEY_SHA = "7dcb19c87d41a4399b4877054111f7dbfd30531545678bc2be218bd56903904c"
MANIFEST_SHA = "292f9911ebc40adffbd89b4bec2071c9545c213df25ffa15ef4e8e0367dfb0ce"
TARGETS = {"darwin-arm64": "mac-armv8", "darwin-x64": "mac-x64", "linux-arm64": "linux-armv8",
           "linux-x64": "linux-x64", "win32-x64": "win-x64"}


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(command):
    result = subprocess.run(list(map(str, command)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        raise RuntimeError("Pinned Monero tools preparation command failed: " + str(command[0]))
    return result.stdout.decode("utf-8", errors="strict")


def main():
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}.get(platform.system(), platform.system())
    arch = {"aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}.get(platform.machine(), platform.machine())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", default=system + "-" + arch, choices=TARGETS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--archive", type=Path, help="Reuse an exact official archive; hash/signature are still verified")
    args = parser.parse_args()
    out = (args.output or HERE / "vendor" / args.platform).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        parser.error("output directory must be empty")
    for name in ["gpg", "gpgv"] + ([] if args.archive else ["curl"]):
        if not shutil.which(name):
            parser.error("missing required preparation tool: " + name)
    key, manifest = HERE / "vendor-source/binaryfate.asc", HERE / "vendor-source/hashes.txt"
    if sha(key) != KEY_SHA or sha(manifest) != MANIFEST_SHA:
        raise RuntimeError("Pinned Monero release verification sources changed")
    extension = ".zip" if args.platform.startswith("win32-") else ".tar.bz2"
    archive_name = "monero-" + TARGETS[args.platform] + "-v" + VERSION + extension
    matches = re.findall(r"^([0-9a-f]{64})  " + re.escape(archive_name) + r"$", manifest.read_text(), re.M)
    if len(matches) != 1:
        raise RuntimeError("Unsupported archive in pinned release manifest")
    with tempfile.TemporaryDirectory(prefix="keepkey-monero-release-") as temporary:
        root = Path(temporary)
        home = root / "gnupg"
        home.mkdir(mode=0o700)
        keyring = root / "release-key.gpg"
        run(["gpg", "--no-options", "--homedir", home, "--batch", "--yes", "--output", keyring, "--dearmor", key])
        verification = run(["gpgv", "--homedir", home, "--status-fd", "1", "--keyring", keyring, manifest])
        if not any(line.startswith("[GNUPG:] VALIDSIG " + FINGERPRINT + " ") for line in verification.splitlines()):
            raise RuntimeError("Release signature does not match pinned signing fingerprint")
        archive = args.archive.resolve() if args.archive else root / archive_name
        if not args.archive:
            run(["curl", "-fL", "--proto", "=https", "--tlsv1.2", "--connect-timeout", "15", "--max-time", "160",
                 "https://downloads.getmonero.org/cli/" + archive_name, "-o", archive])
        if sha(archive) != matches[0]:
            raise RuntimeError("Monero archive does not match authenticated release hash")
        binary = "monero-wallet-rpc.exe" if args.platform.startswith("win32-") else "monero-wallet-rpc"
        daemon = "monerod.exe" if args.platform.startswith("win32-") else "monerod"
        if extension == ".zip":
            with zipfile.ZipFile(archive) as content:
                for name in [binary, daemon, "LICENSE"]:
                    entries = [v for v in content.infolist() if not v.is_dir() and Path(v.filename).name == name]
                    if len(entries) != 1 or entries[0].file_size > 256 * 1024 * 1024 or stat.S_ISLNK(entries[0].external_attr >> 16):
                        raise RuntimeError("Invalid official archive contents")
                    (out / name).write_bytes(content.read(entries[0]))
        else:
            with tarfile.open(archive, "r:bz2") as content:
                for name in [binary, daemon, "LICENSE"]:
                    entries = [v for v in content if v.isfile() and Path(v.name).name == name]
                    if len(entries) != 1 or entries[0].size > 256 * 1024 * 1024:
                        raise RuntimeError("Invalid official archive contents")
                    stream = content.extractfile(entries[0])
                    if stream is None:
                        raise RuntimeError("Cannot read official archive")
                    (out / name).write_bytes(stream.read())
        (out / binary).chmod(0o755)
        (out / daemon).chmod(0o755)
        metadata = {"version": VERSION, "platform": args.platform, "archiveSha256": matches[0],
                    "signerFingerprint": FINGERPRINT, "walletRpcSha256": sha(out / binary), "daemonSha256": sha(out / daemon)}
        (out / "monero-tools.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"status": "pass", **metadata}))


if __name__ == "__main__":
    main()
