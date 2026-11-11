#!/usr/bin/env python3
"""Preserve the prepared RPC checksum across macOS native code signing.

Preparation authenticates the official archive. This helper checks the staged
copy against its existing receipt, records the hash before signing, then updates
the runtime hash after codesign changes the binary. The final application code
signature must seal both the modified binary and metadata. These receipt fields
are not an independent archive-signature verification or a trust root.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile


class ReceiptError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReceiptError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def regular_file(path):
    require(not path.is_symlink() and stat.S_ISREG(path.stat().st_mode),
            "Monero signing inputs must be regular files")


def checksum(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value),
            "Invalid Monero signing checksum")
    return value


def read_json(path):
    regular_file(path)
    require(path.stat().st_size <= 65536, "Monero signing metadata exceeds its bound")
    value = json.loads(path.read_text())
    require(isinstance(value, dict), "Invalid Monero signing metadata")
    return value


def write_json(path, value, mode):
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verify_before_signing(rpc, metadata, receipt, field="walletRpc"):
    regular_file(rpc)
    value = read_json(metadata)
    require(field in ("walletRpc", "daemon"), "Invalid Monero helper field")
    before = checksum(value.get(field + "Sha256"))
    require(sha256(rpc) == before, "Staged Monero wallet RPC does not match its prepared receipt")
    raw = checksum(value.get(field + "RawSha256", before))
    write_json(receipt, {"rpc": str(rpc.resolve()), "metadata": str(metadata.resolve()),
                        "metadataSha256": sha256(metadata), "beforeSha256": before,
                        "rawSha256": raw, "field": field}, 0o600)


def record_after_signing(rpc, metadata, receipt, field="walletRpc"):
    regular_file(rpc)
    before = read_json(receipt)
    require(field in ("walletRpc", "daemon") and before.get("field", "walletRpc") == field,
            "Monero signing receipt belongs to another helper")
    require(before.get("rpc") == str(rpc.resolve()) and before.get("metadata") == str(metadata.resolve()),
            "Monero signing receipt belongs to different inputs")
    require(sha256(metadata) == checksum(before.get("metadataSha256")),
            "Monero metadata changed after pre-sign verification")
    value = read_json(metadata)
    require(checksum(value.get(field + "Sha256")) == checksum(before.get("beforeSha256")),
            "Monero pre-sign checksum changed")
    value[field + "RawSha256"] = checksum(before.get("rawSha256"))
    value[field + "Sha256"] = sha256(rpc)
    write_json(metadata, value, stat.S_IMODE(metadata.stat().st_mode))
    receipt.unlink()


def stage_signed_copies(worker, rpc, metadata, output, entitlements, identity, run=subprocess.run, daemon=None):
    """Sign disposable inputs before Electrobun's own app signing/notarization."""
    for source in (worker, rpc, metadata, entitlements):
        regular_file(source)
    require(not output.is_symlink(), "Monero signing output cannot be a symlink")
    output.mkdir(parents=True, exist_ok=True)
    copies = [output / "monero-cli", output / "monero-wallet-rpc", output / "monero-tools.json"]
    sources = [worker, rpc, metadata]
    require(all(not target.is_symlink() and target.resolve() not in {p.resolve() for p in sources}
                for target in copies), "Monero signing must use disposable copies")
    for source, target in zip(sources, copies):
        shutil.copy2(source, target)
    signed_worker, signed_rpc, signed_metadata = copies
    if daemon:
        regular_file(daemon)
        signed_daemon = output / "monerod"
        require(not signed_daemon.is_symlink() and signed_daemon.resolve() != daemon.resolve(),
                "Monero signing must use disposable copies")
        require(sha256(daemon) == checksum(read_json(metadata).get("daemonSha256")),
                "Staged Monero node does not match its prepared receipt")
        shutil.copy2(daemon, signed_daemon)
    receipt = output / ".monero-pre-sign.json"
    verify_before_signing(signed_rpc, signed_metadata, receipt)
    command = ["codesign", "--force", "--verbose", "--timestamp", "--options", "runtime", "--sign", identity]
    run(command + ["--entitlements", str(entitlements), str(signed_worker)], check=True)
    run(command + [str(signed_rpc)], check=True)
    run(["codesign", "--verify", "--strict", str(signed_rpc)], check=True)
    record_after_signing(signed_rpc, signed_metadata, receipt)
    if daemon:
        verify_before_signing(signed_daemon, signed_metadata, receipt, "daemon")
        run(command + [str(signed_daemon)], check=True)
        run(["codesign", "--verify", "--strict", str(signed_daemon)], check=True)
        record_after_signing(signed_daemon, signed_metadata, receipt, "daemon")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("verify", "record", "stage"))
    parser.add_argument("--rpc", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--entitlements", type=Path)
    parser.add_argument("--identity")
    parser.add_argument("--daemon", type=Path)
    parser.add_argument("--field", choices=("walletRpc", "daemon"), default="walletRpc")
    args = parser.parse_args()
    try:
        if args.operation == "stage":
            require(args.worker and args.output and args.entitlements and args.identity,
                    "Monero staging requires worker, output, entitlements and identity")
            stage_signed_copies(args.worker, args.rpc, args.metadata, args.output, args.entitlements, args.identity, daemon=args.daemon)
        else:
            require(args.receipt, "Monero signing receipt is required")
            operation = verify_before_signing if args.operation == "verify" else record_after_signing
            operation(args.rpc, args.metadata, args.receipt, args.field)
    except (ReceiptError, OSError, ValueError, subprocess.CalledProcessError):
        parser.exit(1, "Monero signing metadata verification failed; use a fresh prepared bundle.\n")


if __name__ == "__main__":
    main()
