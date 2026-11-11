"""Test signing receipts and native/outer-sign order without any signing keys."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent
HELPER = runpy.run_path(str(SCRIPTS / "monero-signing-metadata.py"))


class MoneroSigningMetadata(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="keepkey-monero-signing-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "Public Test.app"
        self.tools = self.app / "Contents/Resources/app/monero-tools"
        self.tools.mkdir(parents=True)
        self.rpc = self.tools / "monero-wallet-rpc"
        self.rpc.write_bytes(b"\xcf\xfa\xed\xfePUBLIC-FAKE-RPC-BEFORE-SIGNING")
        self.original = hashlib.sha256(self.rpc.read_bytes()).hexdigest()
        self.metadata = self.tools / "monero-tools.json"
        self.prepared = {"version": "0.18.5.4", "platform": "darwin-arm64",
                         "archiveSha256": "public archive receipt unchanged",
                         "walletRpcSha256": self.original}
        self.metadata.write_text(json.dumps(self.prepared))
        self.receipt = self.root / "pre-sign.json"

    def verify(self):
        HELPER["verify_before_signing"](self.rpc, self.metadata, self.receipt)

    def record(self):
        HELPER["record_after_signing"](self.rpc, self.metadata, self.receipt)

    def test_pre_sign_rejects_changed_raw_binary_without_changing_metadata(self):
        self.rpc.write_bytes(b"PUBLIC-TAMPERED-BEFORE-SIGNING")
        with self.assertRaises(HELPER["ReceiptError"]):
            self.verify()
        self.assertFalse(self.receipt.exists())
        self.assertEqual(json.loads(self.metadata.read_text()), self.prepared)

    def test_signing_records_current_hash_preserves_raw_receipt_and_consumes_precheck(self):
        self.verify()
        self.rpc.write_bytes(self.rpc.read_bytes() + b"PUBLIC-MOCK-NATIVE-SIGNATURE")
        self.record()
        value = json.loads(self.metadata.read_text())
        self.assertEqual(value["walletRpcSha256"], hashlib.sha256(self.rpc.read_bytes()).hexdigest())
        self.assertNotEqual(value["walletRpcSha256"], self.original)
        self.assertEqual(value["walletRpcRawSha256"], self.original)
        self.assertEqual(value["archiveSha256"], self.prepared["archiveSha256"])
        self.assertFalse(self.receipt.exists())

    def test_re_signing_preserves_first_raw_receipt(self):
        for suffix in [b"PUBLIC-SIGNATURE-ONE", b"PUBLIC-SIGNATURE-TWO"]:
            self.verify()
            self.rpc.write_bytes(self.rpc.read_bytes() + suffix)
            self.record()
        value = json.loads(self.metadata.read_text())
        self.assertEqual(value["walletRpcRawSha256"], self.original)
        self.assertEqual(value["walletRpcSha256"], hashlib.sha256(self.rpc.read_bytes()).hexdigest())

    def test_metadata_change_after_precheck_is_rejected(self):
        self.verify()
        self.metadata.write_text(json.dumps(dict(self.prepared, version="changed")))
        with self.assertRaises(HELPER["ReceiptError"]):
            self.record()

    def test_receipt_cannot_be_applied_to_another_binary_path(self):
        self.verify()
        another = self.tools / "another-public-rpc"
        another.write_bytes(self.rpc.read_bytes())
        with self.assertRaises(HELPER["ReceiptError"]):
            HELPER["record_after_signing"](another, self.metadata, self.receipt)

    def test_symlink_input_is_rejected(self):
        link = self.root / "rpc-link"
        link.symlink_to(self.rpc)
        with self.assertRaises(HELPER["ReceiptError"]):
            HELPER["verify_before_signing"](link, self.metadata, self.receipt)

    def test_electrobun_inputs_are_disposable_signed_copies_with_a_matching_receipt(self):
        worker = self.root / "public-worker"
        worker.write_bytes(b"PUBLIC-FAKE-WORKER")
        entitlement = self.root / "public-entitlements.plist"
        entitlement.write_text("PUBLIC-TEST-ENTITLEMENTS")
        output = self.root / "_build/_signed_monero"
        sources = {path: path.read_bytes() for path in (worker, self.rpc, self.metadata)}
        commands = []

        def mock_codesign(command, check):
            self.assertTrue(check)
            commands.append(command)
            if command[1] == "--force":
                path = Path(command[-1])
                path.write_bytes(path.read_bytes() + b"PUBLIC-MOCK-SIGNATURE")

        HELPER["stage_signed_copies"](worker, self.rpc, self.metadata, output, entitlement,
                                      "PUBLIC TEST IDENTITY", run=mock_codesign)
        for path, original in sources.items():
            self.assertEqual(path.read_bytes(), original)
        value = json.loads((output / "monero-tools.json").read_text())
        self.assertEqual(value["walletRpcRawSha256"], self.original)
        self.assertEqual(value["walletRpcSha256"], hashlib.sha256((output / "monero-wallet-rpc").read_bytes()).hexdigest())
        self.assertIn("--entitlements", commands[0])
        self.assertNotIn("--entitlements", commands[1])
        self.assertEqual(commands[2][1:3], ["--verify", "--strict"])
        self.assertFalse((output / ".monero-pre-sign.json").exists())

    def test_staging_cannot_overwrite_a_prepared_input(self):
        worker = self.root / "public-worker"
        worker.write_bytes(b"PUBLIC-FAKE-WORKER")
        entitlement = self.root / "public-entitlements.plist"
        entitlement.write_text("PUBLIC-TEST-ENTITLEMENTS")
        original = self.rpc.read_bytes()
        with self.assertRaises(HELPER["ReceiptError"]):
            HELPER["stage_signed_copies"](worker, self.rpc, self.metadata, self.tools, entitlement,
                                          "PUBLIC TEST IDENTITY", run=lambda *args, **kwargs: self.fail("must not sign"))
        self.assertEqual(self.rpc.read_bytes(), original)

    def test_staging_signs_a_disposable_node_with_separate_raw_and_runtime_hashes(self):
        daemon = self.tools / "monerod"
        daemon.write_bytes(b"PUBLIC-NODE")
        original = daemon.read_bytes()
        self.metadata.write_text(json.dumps(dict(self.prepared, daemonSha256=hashlib.sha256(original).hexdigest())))
        worker = self.root / "worker"
        worker.write_bytes(b"PUBLIC-WORKER")
        entitlement = self.root / "entitlements.plist"
        entitlement.write_text("PUBLIC-ENTITLEMENTS")
        output = self.root / "signed"
        def mock(command, check):
            if command[1] == "--force":
                target = Path(command[-1])
                target.write_bytes(target.read_bytes() + b"PUBLIC-SIGNATURE")
        HELPER["stage_signed_copies"](worker, self.rpc, self.metadata, output, entitlement, "PUBLIC-IDENTITY", run=mock, daemon=daemon)
        self.assertEqual(daemon.read_bytes(), original)
        value = json.loads((output / "monero-tools.json").read_text())
        self.assertEqual(value["daemonRawSha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(value["daemonSha256"], hashlib.sha256((output / "monerod").read_bytes()).hexdigest())

    def signing_fixture(self):
        worker = self.tools.parent / "monero-cli"
        worker.write_bytes(b"PUBLIC-FAKE-COMPILED-WORKER")
        macos = self.app / "Contents/MacOS"
        macos.mkdir()
        (macos / "bun").write_bytes(b"PUBLIC-FAKE-BUN")
        entitlement = self.root / "entitlements.plist"
        entitlement.write_text("PUBLIC-TEST-ENTITLEMENTS")
        commands = self.root / "commands"
        commands.mkdir()
        log = self.root / "signing-log.jsonl"
        # This command simulates mutation by native signing. The fake outer
        # signer refuses the bundle unless its metadata already matches the
        # modified RPC, so the test exercises the real shell pipeline ordering.
        codesign = commands / "codesign"
        codesign.write_text('''#!/usr/bin/env python3
import hashlib,json,os,sys
from pathlib import Path
args=sys.argv[1:]
if args[0]=='-d':
 print('com.apple.security.cs.allow-jit');sys.exit(0)
if args[0]=='--verify':sys.exit(0)
target=Path(args[-1]);kind='native'
if target.is_dir():
 kind='bundle'
 tools=target/'Contents/Resources/app/monero-tools'
 metadata=json.loads((tools/'monero-tools.json').read_text())
 current=hashlib.sha256((tools/'monero-wallet-rpc').read_bytes()).hexdigest()
 if metadata.get('walletRpcSha256')!=current or not metadata.get('walletRpcRawSha256'):sys.exit(91)
else:target.write_bytes(target.read_bytes()+b'PUBLIC-MOCK-NATIVE-SIGNATURE')
with Path(os.environ['PUBLIC_SIGNING_TEST_LOG']).open('a') as out:
 out.write(json.dumps({'kind':kind,'target':target.name,'entitlements':'--entitlements' in args})+'\\n')
''')
        codesign.chmod(0o755)
        file_command = commands / "file"
        file_command.write_text("#!/bin/sh\necho 'Mach-O 64-bit executable arm64'\n")
        file_command.chmod(0o755)
        env = {**os.environ, "PATH": str(commands) + os.pathsep + os.environ.get("PATH", ""),
               "ELECTROBUN_DEVELOPER_ID": "PUBLIC TEST IDENTITY", "ELECTROBUN_TEAMID": "PUBLICTEST",
               "PUBLIC_SIGNING_TEST_LOG": str(log)}
        return entitlement, env, log

    def test_actual_signing_pipeline_updates_receipt_before_outer_signature(self):
        entitlement, env, log = self.signing_fixture()
        result = subprocess.run(["bash", str(SCRIPTS / "sign-macos-app.sh"), str(self.app), str(entitlement)],
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        records = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([row["target"] for row in records], ["monero-cli", "monero-wallet-rpc", "bun", self.app.name])
        self.assertTrue(records[0]["entitlements"])
        self.assertFalse(records[1]["entitlements"])
        self.assertEqual(records[-1]["kind"], "bundle")
        value = json.loads(self.metadata.read_text())
        self.assertEqual(value["walletRpcRawSha256"], self.original)
        self.assertEqual(value["walletRpcSha256"], hashlib.sha256(self.rpc.read_bytes()).hexdigest())

    def test_pipeline_refuses_tampered_raw_input_before_any_signing(self):
        entitlement, env, log = self.signing_fixture()
        self.rpc.write_bytes(b"PUBLIC-TAMPERED-BEFORE-SIGNING")
        result = subprocess.run(["bash", str(SCRIPTS / "sign-macos-app.sh"), str(self.app), str(entitlement)],
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(log.exists())
        self.assertEqual(json.loads(self.metadata.read_text()), self.prepared)

    def test_pipeline_signs_node_and_records_its_checksum_without_changing_rpc_receipt(self):
        daemon = self.tools / "monerod"
        daemon.write_bytes(b"PUBLIC-FAKE-NODE")
        original = hashlib.sha256(daemon.read_bytes()).hexdigest()
        self.metadata.write_text(json.dumps(dict(self.prepared, daemonSha256=original)))
        entitlement, env, log = self.signing_fixture()
        result = subprocess.run(["bash", str(SCRIPTS / "sign-macos-app.sh"), str(self.app), str(entitlement)],
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        value = json.loads(self.metadata.read_text())
        self.assertEqual(value["daemonRawSha256"], original)
        self.assertEqual(value["daemonSha256"], hashlib.sha256(daemon.read_bytes()).hexdigest())
        self.assertEqual(value["walletRpcSha256"], hashlib.sha256(self.rpc.read_bytes()).hexdigest())
        records = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([row["target"] for row in records], ["monero-cli", "monero-wallet-rpc", "monerod", "bun", self.app.name])

    def test_pipeline_refuses_tampered_node_before_any_signing(self):
        daemon = self.tools / "monerod"
        daemon.write_bytes(b"PUBLIC-TAMPERED-NODE")
        self.metadata.write_text(json.dumps(dict(self.prepared, daemonSha256="0" * 64)))
        entitlement, env, log = self.signing_fixture()
        result = subprocess.run(["bash", str(SCRIPTS / "sign-macos-app.sh"), str(self.app), str(entitlement)],
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(log.exists())


if __name__ == "__main__":
    unittest.main()
