#!/usr/bin/env python3
"""Build the verification-only, system-library-only Monero Core dylib for macOS13.

All six source archives are supplied explicitly and checked before extraction.
No downloads, signing, device access or private wallet inputs are used. The final
hash is reported for qualification; stage-monero-core-verifier accepts only the
currently reviewed artifact. Compiler updates need fresh native vector checks.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "projects/keepkey-vault/monero-cli/core-verifier-manifest.json"
NATIVE = ROOT / "projects/keepkey-vault/native/monero-core-verifier"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(archives, work, output, jobs):
    manifest = json.loads(MANIFEST.read_text())
    artifact = manifest["files"]["darwin-arm64"]
    if sys.platform != "darwin" or not 1 <= jobs <= 16:
        raise ValueError("A macOS host and 1..16 build jobs are required")
    if work.exists() or output.exists() or output.is_symlink():
        raise ValueError("Build directory and verifier output must not already exist")
    pins = manifest["source"]["archivesSha256"]
    for name, expected in manifest["source"]["bridgeSha256"].items():
        if digest(NATIVE / name) != expected:
            raise ValueError("The native verifier source differs from its reviewed source pin: " + name)
    for name, expected in pins.items():
        archive = archives / name
        if archive.is_symlink() or not archive.is_file() or digest(archive) != expected:
            raise ValueError("Missing or mismatched pinned source archive: " + name)
    work.mkdir(parents=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    core = work / "core-source"
    boost = work / "boost-source"
    sodium = work / "sodium-source"
    destinations = {"monero-core-v0.18.5.4.tar.gz": core,
                    "monero-randomx.tar.gz": core / "external/randomx",
                    "monero-rapidjson.tar.gz": core / "external/rapidjson",
                    "monero-supercop.tar.gz": core / "external/supercop",
                    "boost-1.90.0.tar.xz": boost, "libsodium-1.0.22.tar.gz": sodium}
    for name, destination in destinations.items():
        destination.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archives / name) as source:
            # Each pinned archive has one top-level release directory.
            for member in source:
                parts = Path(member.name).parts[1:]
                if not parts:
                    continue
                member.name = str(Path(*parts))
                source.extract(member, destination, filter="data")

    def run(command, logfile, cwd=None):
        with (work / logfile).open("w") as log:
            log.write(json.dumps(list(map(str, command))) + "\n"); log.flush()
            result = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError("Native build failed; inspect " + str(work / logfile))

    flags = "-arch arm64 -mmacosx-version-min=13.0 -ffile-prefix-map=" + str(work) + "=/monero-verifier-build"
    run(["./bootstrap.sh", "--with-libraries=thread,chrono,atomic,date_time", "--with-toolset=clang"], "boost-bootstrap.log", boost)
    run(["./b2", "--with-thread", "--with-chrono", "--with-atomic", "--with-date_time", "variant=release", "link=static",
         "runtime-link=shared", "threading=multi", "target-os=darwin", "architecture=arm", "address-model=64",
         "cxxflags=" + flags, "linkflags=-arch arm64 -mmacosx-version-min=13.0", "stage", "-j" + str(jobs)], "boost-build.log", boost)
    sodium_object = work / "sodium-verify.o"
    run(["/usr/bin/clang", "-c", "-arch", "arm64", "-mmacosx-version-min=13.0", "-O2", "-fPIC",
         "-I" + str(sodium / "src/libsodium/include/sodium"), str(sodium / "src/libsodium/crypto_verify/verify.c"),
         "-o", str(sodium_object)], "sodium-build.log")
    hook = work / "core-verify.cmake"
    hook.write_text("\n".join([
        "function(keepkey_verify_bridge)",
        ' add_library(monero_core_verify SHARED "' + str(NATIVE / "verify.cpp") + '")',
        ' target_include_directories(monero_core_verify PRIVATE "' + str(NATIVE) + '")',
        " target_link_libraries(monero_core_verify PRIVATE ringct cryptonote_basic)",
        ' set_target_properties(monero_core_verify PROPERTIES CXX_STANDARD 14 POSITION_INDEPENDENT_CODE ON LIBRARY_OUTPUT_DIRECTORY "' + str(work / "intermediate") + '")',
        " target_link_options(monero_core_verify PRIVATE -Wl,-dead_strip -Wl,-dead_strip_dylibs -Wl,-exported_symbol,_monero_core_verify -Wl,-exported_symbol,_monero_core_plan_size)",
        "endfunction()", "cmake_language(DEFER CALL keepkey_verify_bridge)", ""]))
    cache = work / "core-build"
    mappings = "-ffile-prefix-map=" + str(work) + "=/monero-verifier-build -ffile-prefix-map=" + str(NATIVE) + "=/monero-verifier-source"
    run(["cmake", "-S", str(core), "-B", str(cache), "-DMANUAL_SUBMODULES=ON", "-DBUILD_TESTS=OFF",
         "-DBUILD_DOCUMENTATION=OFF", "-DBUILD_GUI_DEPS=OFF", "-DUSE_DEVICE_TREZOR=OFF", "-DCMAKE_DISABLE_FIND_PACKAGE_HIDAPI=TRUE",
         "-DMONERO_WALLET_CRYPTO_LIBRARY=cn", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
         "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", "-DCMAKE_OSX_ARCHITECTURES=arm64",
         "-DCMAKE_C_FLAGS=" + mappings, "-DCMAKE_CXX_FLAGS=" + mappings,
         "-DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3", "-DCMAKE_PROJECT_monero_INCLUDE=" + str(hook)], "core-configure.log")
    run(["cmake", "--build", str(cache), "--target", "monero_core_verify", "-j" + str(jobs)], "core-build.log")
    # CMake discovers broad Core dependencies for its intermediate target. The
    # final verification-only dylib needs just static Boost thread and sodium's
    # constant-time compare; never ship its unrelated network/device dylibs.
    command = shlex.split((cache / "CMakeFiles/monero_core_verify.dir/link.txt").read_text())
    command = [arg for arg in command if not (arg.startswith("/opt/homebrew/") and arg.endswith(".dylib"))]
    command[command.index("-o") + 1] = str(output)
    command += [str(boost / "stage/lib" / name) for name in
                ["libboost_thread.a", "libboost_chrono.a", "libboost_atomic.a", "libboost_date_time.a"]] + [str(sodium_object)]
    run(command, "final-link.log", cache)
    dependencies = subprocess.check_output(["otool", "-L", str(output)], text=True).splitlines()[2:]
    dependencies = [line.strip().split(" (", 1)[0] for line in dependencies]
    exports = sorted(line.split()[-1] for line in subprocess.check_output(["nm", "-gU", str(output)], text=True).splitlines() if line.split())
    load_commands = subprocess.check_output(["otool", "-l", str(output)], text=True)
    if dependencies != artifact["dependencies"] or exports != sorted(artifact["exports"]) or "minos 13.0" not in load_commands or "LC_UUID" not in load_commands:
        raise ValueError("Verifier dependency, export, minimum OS or UUID contract failed")
    result = {"status": "pass", "path": str(output), "sha256": digest(output), "size": output.stat().st_size,
              "minimumMacosVersion": "13.0", "dependencies": dependencies, "exports": exports,
              "matchesReviewedArtifact": digest(output) == artifact["sha256"], "archivesSha256": pins,
              "bridgeSha256": {p.name: digest(p) for p in NATIVE.iterdir() if p.is_file()},
              "compiler": subprocess.check_output(["/usr/bin/clang++", "--version"], text=True).splitlines()[0],
              "sdkVersion": subprocess.check_output(["xcrun", "--show-sdk-version"], text=True).strip()}
    (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=8)
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.archive_dir.resolve(), args.work_dir.absolute(), args.output.absolute(), args.jobs), indent=2))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + "\n")
