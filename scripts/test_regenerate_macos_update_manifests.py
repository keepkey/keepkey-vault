#!/usr/bin/env python3
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("macos_update_manifests", HERE / "regenerate-macos-update-manifests.py")
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


@unittest.skipUnless(shutil.which("zstd"), "zstd is required for archive qualification")
class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="keepkey-update-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "stable-macos-x64-keepkey-vault.app.tar.zst"
        self.identity = {"version": "1.7.1", "channel": "stable", "identifier": "com.keepkey.vault", "name": "keepkey-vault", "hash": "1h47po8plcmou"}

    def pack(self, identity=None, payload=b"PUBLIC SIGNED NATIVE FIXTURE", duplicate=False, symlink=False):
        identity = self.identity if identity is None else identity
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            member = tarfile.TarInfo("keepkey-vault.app/Contents/Resources/version.json")
            data = json.dumps(identity).encode()
            member.size = len(data)
            if symlink:
                member.type = tarfile.SYMTYPE; member.linkname = "/outside/version.json"; member.size = 0
            archive.addfile(member, None if symlink else io.BytesIO(data))
            if duplicate:
                archive.addfile(member, io.BytesIO(data))
            native = tarfile.TarInfo("keepkey-vault.app/Contents/MacOS/launcher")
            native.size = len(payload); archive.addfile(native, io.BytesIO(payload))
        # Padding is part of the exact tar digest, although tar readers stop at
        # the end marker before it. This differs from the compressed hash.
        self.tar_bytes = output.getvalue() + b"\0" * 1536
        tar_path = self.root / "app.tar"
        tar_path.write_bytes(self.tar_bytes)
        subprocess.run(["zstd", "-q", "-f", str(tar_path), "-o", str(self.archive)], check=True)

    def generate(self, **extra):
        return TOOL.regenerate(self.archive, "1.7.1", "stable", "x64", self.root, **extra)

    def documents(self):
        return [json.loads((self.root / name).read_text()) for name in ["stable-macos-x64-update.json", "stable-macos-x64-update-v2.json"]]

    def test_preserves_internal_identity_and_hashes_the_complete_uncompressed_tar(self):
        self.pack(); original_archive = self.archive.read_bytes()
        result = self.generate()
        legacy, streaming = self.documents()
        self.assertEqual(legacy, {"schemaVersion": 1, "identifier": "com.keepkey.vault", "channel": "stable", "version": "1.7.1",
                                  "hash": "1h47po8plcmou", "platform": "macos", "arch": "x64", "artifact": {"file": self.archive.name}})
        self.assertEqual(streaming, {**legacy, "artifact": {**legacy["artifact"], "tarSha256": hashlib.sha256(self.tar_bytes).hexdigest(), "tarSize": len(self.tar_bytes)}})
        self.assertNotEqual(streaming["artifact"]["tarSha256"], hashlib.sha256(original_archive).hexdigest())
        self.assertEqual(self.archive.read_bytes(), original_archive)
        self.assertEqual(result["hash"], self.identity["hash"])
        self.assertTrue(self.generate(check=True)["checked"])

    def test_resigning_changes_tar_integrity_without_changing_the_embedded_app_hash(self):
        self.pack(); self.generate(); old = self.documents()[1]
        self.pack(payload=b"PUBLIC NEW SIGNATURE BYTES")
        with self.assertRaisesRegex(ValueError, "exact signed archive"):
            self.generate(check=True)
        self.generate(); new = self.documents()[1]
        self.assertEqual(new["hash"], old["hash"])
        self.assertNotEqual(new["artifact"]["tarSha256"], old["artifact"]["tarSha256"])

    def test_identity_mismatch_and_unsafe_hash_fail_before_outputs(self):
        for change in [{"version": "1.7.0"}, {"channel": "dev"}, {"identifier": "other.app"}, {"name": "another-app"}, {"hash": "../bad"}, {"arch": "arm64"}]:
            with self.subTest(change=change):
                self.pack({**self.identity, **change})
                with self.assertRaises(ValueError):
                    self.generate()
                self.assertFalse((self.root / "stable-macos-x64-update.json").exists())

    def test_duplicate_or_symlink_app_identity_is_rejected(self):
        for options in [{"duplicate": True}, {"symlink": True}]:
            with self.subTest(options=options):
                self.pack(**options)
                with self.assertRaisesRegex(ValueError, "one regular bounded"):
                    self.generate()

    def test_filename_architecture_and_corrupt_archive_are_rejected(self):
        self.pack()
        with self.assertRaisesRegex(ValueError, "filename"):
            TOOL.regenerate(self.archive, "1.7.1", "stable", "arm64", self.root)
        self.archive.write_bytes(b"not a zstd archive")
        with self.assertRaisesRegex(ValueError, "decompress"):
            self.generate()

    def test_check_rejects_stale_sidecars_without_rewriting_them(self):
        self.pack(); self.generate()
        stale = self.root / "stable-macos-x64-update-v2.json"
        stale.write_text('{"PUBLIC":"STALE"}\n')
        before = stale.read_bytes()
        with self.assertRaisesRegex(ValueError, "exact signed archive"):
            self.generate(check=True)
        self.assertEqual(stale.read_bytes(), before)

    def test_invalid_new_archive_does_not_replace_previous_valid_sidecars(self):
        self.pack(); self.generate()
        paths = list(self.root.glob("*-update*.json")); before = {path.name: path.read_bytes() for path in paths}
        self.pack({**self.identity, "version": "1.7.0"})
        with self.assertRaises(ValueError):
            self.generate()
        self.assertEqual({path.name: path.read_bytes() for path in paths}, before)


class MakeHandoffTests(unittest.TestCase):
    def test_isolated_makefile_recursion_and_script_path_survive_a_separate_working_tree(self):
        with tempfile.TemporaryDirectory(prefix="keepkey-tooling-make-") as temporary:
            root = Path(temporary)
            project = root / "projects/keepkey-vault"; project.mkdir(parents=True)
            (project / "package.json").write_text('{"version": "1.7.1"}\n')
            for path in ["modules/hdwallet/packages", "modules/proto-tx-builder/src", "modules/device-protocol", "modules/electrobun"]:
                (root / path).mkdir(parents=True)
            makefile = HERE.parent / "Makefile"
            # GNU make may execute recursive $(MAKE) lines even under -n.
            # Replace that executable with echo: no signing/download/upload can run.
            result = subprocess.run(["make", "-n", "--no-print-directory", "-f", str(makefile), "sign-release-intel", "MAKE=echo"], cwd=root, text=True, capture_output=True, check=True)
            self.assertIn('-f "' + str(makefile) + '" _sign-one-dmg', result.stdout)
            self.assertIn('MACOS_UPDATE_MANIFEST_SCRIPT="' + str(HERE / "regenerate-macos-update-manifests.py") + '"', result.stdout)
            self.assertIn('-f "' + str(makefile) + '" release-sums', result.stdout)
            self.assertIn('stable-macos-x64-update.json', result.stdout)
            self.assertIn('stable-macos-x64-update-v2.json', result.stdout)


if __name__ == "__main__":
    unittest.main()
