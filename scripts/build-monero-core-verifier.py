#!/usr/bin/env python3
"""Build the verification-only, system-library-only Monero Core library for one platform key.

darwin-arm64: libmonero_core_verify.dylib for macOS 13 (the reviewed recipe, unchanged).
win32-x64: monero_core_verify.dll from a native MSYS2 UCRT64 build, fully static, importing
only Windows/UCRT system DLLs. Run it with the UCRT64 Python in an MSYS2 UCRT64 shell.
Windows builds the pinned OpenSSL archive (the host adapter manifest's pin) rather than
using a system copy, so it checks seven archives instead of six.

All six source archives are supplied explicitly and checked before extraction.
No downloads, signing, device access or private wallet inputs are used. The final
hash is reported for qualification; stage-monero-core-verifier accepts only the
currently reviewed artifact. Compiler updates need fresh native vector checks.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "projects/keepkey-vault/monero-cli/core-verifier-manifest.json"
NATIVE = ROOT / "projects/keepkey-vault/native/monero-core-verifier"


TARGETS = {"darwin-arm64": "darwin", "win32-x64": "win32"}
OPENSSL_ARCHIVE = "openssl-3.5.9.tar.gz"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --- win32-x64: MSYS2 UCRT64, fully static -----------------------------------
# Used only for --target win32-x64; the same rules as build-monero-host-adapter.py.
# Core's CMake needs every Boost component it searches for, and Windows has no
# system Boost to satisfy configure, so all of them are built from the pinned archive.
BOOST_LIBRARIES = ["filesystem", "thread", "date_time", "chrono", "serialization", "program_options", "locale", "atomic"]
EXPORTS = ["monero_core_plan_size", "monero_core_verify"]
WINDOWS_SYSTEM_DLLS = {"kernel32.dll", "advapi32.dll", "user32.dll", "ws2_32.dll", "wsock32.dll", "mswsock.dll",
                       "iphlpapi.dll", "crypt32.dll", "bcrypt.dll", "shell32.dll", "ole32.dll", "secur32.dll",
                       "dnsapi.dll", "ucrtbase.dll"}
WINDOWS_LINK_LIBRARIES = {name[:-4] for name in WINDOWS_SYSTEM_DLLS} | {
    "uuid", "ntdll", "psapi", "userenv", "pthread", "m", "stdc++", "gcc", "gcc_eh", "mingwex", "mingw32", "moldname"}
# Core's own intermediate link of this target pulls in MSYS2 static libraries (unbound
# built against a newer OpenSSL). That binary is discarded; only the rewritten final
# link ships, and it never carries this flag, so a real missing symbol still fails it.
INTERMEDIATE_ONLY = "-Wl,--unresolved-symbols=ignore-all"
WINDOWS_TOOLCHAIN_PACKAGES = ("mingw-w64-ucrt-x86_64-", "make ", "perl ")


def windows_import_allowed(dll):
    return dll in WINDOWS_SYSTEM_DLLS or dll.startswith("api-ms-win-crt-")


def windows_pe_report(path):
    """objdump -p: the PE file format, its imported DLLs and its exported names."""
    report = subprocess.check_output(["objdump", "-p", str(path)], text=True)
    imports = sorted({line.split("DLL Name:", 1)[1].strip().lower() for line in report.splitlines() if "DLL Name:" in line})
    exports, inside = [], False
    for line in report.splitlines():
        if "[Ordinal/Name Pointer] Table" in line:
            inside = True
        elif inside and line.strip().startswith("["):
            exports.append(line.split()[-1])
        elif inside and exports and not line.strip():
            break
    return {"x86_64": "file format pei-x86-64" in report, "imports": imports, "exports": sorted(exports)}


def windows_link_command(cache, target_name, work):
    """CMake's final link line, response files expanded, with every archive or library
    from outside this build removed except Windows system import libraries."""
    lines = [shlex.split(line) for line in (cache / "CMakeFiles" / (target_name + ".dir") / "link.txt").read_text().splitlines() if line.strip()]
    lines = [line for line in lines if "-o" in line]
    if len(lines) != 1:
        raise ValueError("Expected exactly one link command for " + target_name)
    expanded = []
    for arg in lines[0]:
        expanded += shlex.split((cache / arg[1:]).read_text()) if arg.startswith("@") else [arg]
    command, dropped, inside = [], [], Path(work).resolve()
    for arg in expanded:
        if arg == INTERMEDIATE_ONLY:
            continue
        library = None
        if arg.startswith("-l"):
            library = arg[2:]
        elif arg.lower().endswith(".a") and not (cache / arg).resolve().is_relative_to(inside):
            name = Path(arg).name
            library = name[3:].split(".", 1)[0] if name.startswith("lib") else name
        if library is not None and library.lower() not in WINDOWS_LINK_LIBRARIES:
            dropped.append(arg)
            continue
        command.append(arg)
    return command, sorted(set(dropped))


def windows_toolchain():
    packages = subprocess.check_output(["pacman", "-Q"], text=True).splitlines()
    return {"compiler": subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0],
            "msys2Packages": sorted(line for line in packages if line.startswith(WINDOWS_TOOLCHAIN_PACKAGES))}


def build_windows(work, output, jobs, run, artifact, core, boost, sodium, openssl, pins):
    posix = lambda path: Path(path).as_posix()  # noqa: E731  CMake and msys tools read forward slashes
    prefix = "-ffile-prefix-map=" + posix(work) + "=/monero-verifier-build"
    sections = ["-ffunction-sections", "-fdata-sections"]
    run(["perl", "Configure", "mingw64", "no-shared", "no-tests", "no-module", "no-engine", "no-legacy", "no-dso",
         prefix] + sections, "openssl-configure.log", openssl)
    run(["make", "-j" + str(jobs), "build_libs"], "openssl-build.log", openssl)
    run(["sh", "bootstrap.sh", "--with-libraries=" + ",".join(BOOST_LIBRARIES), "--with-toolset=gcc"], "boost-bootstrap.log", boost)
    run([str(boost / "b2.exe")] + ["--with-" + name for name in BOOST_LIBRARIES] + [
        "--layout=system", "toolset=gcc", "variant=release", "link=static", "runtime-link=static", "threading=multi",
        "threadapi=win32", "target-os=windows", "architecture=x86", "address-model=64",
        "boost.locale.icu=off", "boost.locale.iconv=off", "cxxflags=" + " ".join(sections + [prefix]),
        "stage", "-j" + str(jobs)], "boost-build.log", boost)
    sodium_object = work / "sodium-verify.o"
    run(["gcc", "-c", "-O2"] + sections + [prefix, "-I" + posix(sodium / "src/libsodium/include/sodium"),
         posix(sodium / "src/libsodium/crypto_verify/verify.c"), "-o", posix(sodium_object)], "sodium-build.log")
    # Export exactly the verification ABI. With a .def file GNU ld exports nothing else.
    exports = work / "monero_core_verify.def"
    exports.write_text("LIBRARY monero_core_verify.dll\nEXPORTS\n" + "".join("    " + name + "\n" for name in EXPORTS))
    hook = work / "core-verify.cmake"
    hook.write_text("\n".join([
        "function(keepkey_verify_bridge)",
        ' add_library(monero_core_verify SHARED "' + posix(NATIVE / "verify.cpp") + '")',
        ' target_include_directories(monero_core_verify PRIVATE "' + posix(NATIVE) + '")',
        " target_link_libraries(monero_core_verify PRIVATE ringct cryptonote_basic)",
        ' set_target_properties(monero_core_verify PROPERTIES CXX_STANDARD 14 POSITION_INDEPENDENT_CODE ON PREFIX "" '
        'LIBRARY_OUTPUT_DIRECTORY "' + posix(work / "intermediate") + '" RUNTIME_OUTPUT_DIRECTORY "' + posix(work / "intermediate") + '")',
        " target_link_options(monero_core_verify PRIVATE -static -static-libgcc -static-libstdc++ -Wl,--gc-sections -Wl,--no-insert-timestamp " + INTERMEDIATE_ONLY + ")",
        "endfunction()", "cmake_language(DEFER CALL keepkey_verify_bridge)", ""]))
    cache = work / "core-build"
    mappings = " ".join(sections + [prefix, "-ffile-prefix-map=" + posix(NATIVE) + "=/monero-verifier-source"])
    stage = boost / "stage/lib"
    # ARCH=x86-64: Monero's default is -march=native, which is neither reproducible nor portable.
    run(["cmake", "-G", "MSYS Makefiles", "-S", posix(core), "-B", posix(cache), "-DMANUAL_SUBMODULES=ON", "-DBUILD_TESTS=OFF",
         "-DBUILD_DOCUMENTATION=OFF", "-DBUILD_GUI_DEPS=OFF", "-DUSE_DEVICE_TREZOR=OFF", "-DCMAKE_DISABLE_FIND_PACKAGE_HIDAPI=TRUE",
         "-DMONERO_WALLET_CRYPTO_LIBRARY=cn", "-DCMAKE_BUILD_TYPE=Release", "-DSTATIC=ON", "-DARCH=x86-64", "-DBUILD_64=ON",
         "-DUSE_READLINE=OFF", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
         "-DCMAKE_C_FLAGS=" + mappings, "-DCMAKE_CXX_FLAGS=" + mappings,
         "-DBOOST_IGNORE_SYSTEM_PATHS=ON", "-DBOOST_ROOT=" + posix(boost), "-DBoost_INCLUDE_DIR=" + posix(boost),
         "-DBoost_USE_STATIC_LIBS=ON", "-DBoost_LIBRARY_DIR_RELEASE=" + posix(stage), "-DBoost_LIBRARY_DIR_DEBUG=" + posix(stage),
         "-DOPENSSL_ROOT_DIR=" + posix(openssl), "-DOPENSSL_INCLUDE_DIR=" + posix(openssl / "include"),
         "-DOPENSSL_SSL_LIBRARY=" + posix(openssl / "libssl.a"), "-DOPENSSL_CRYPTO_LIBRARY=" + posix(openssl / "libcrypto.a"),
         "-DOPENSSL_USE_STATIC_LIBS=TRUE", "-DCMAKE_PROJECT_monero_INCLUDE=" + posix(hook)] + [
             "-DBoost_" + name.upper() + "_LIBRARY_" + variant + "=" + posix(stage / ("libboost_" + name + ".a"))
             for name in BOOST_LIBRARIES for variant in ["RELEASE", "DEBUG"]], "core-configure.log")
    run(["cmake", "--build", posix(cache), "--target", "monero_core_verify", "-j" + str(jobs)], "core-build.log")
    command, dropped = windows_link_command(cache, "monero_core_verify", work)
    command[command.index("-o") + 1] = posix(output)
    command += [posix(stage / name) for name in ["libboost_thread.a", "libboost_chrono.a", "libboost_atomic.a", "libboost_date_time.a"]]
    command += [posix(sodium_object), posix(exports)]
    run(command, "final-link.log", cache)
    pe = windows_pe_report(output)
    disallowed = [dll for dll in pe["imports"] if not windows_import_allowed(dll)]
    if not pe["x86_64"] or disallowed or pe["exports"] != EXPORTS:
        raise ValueError("Verifier must be an x86-64 PE DLL exporting only " + ", ".join(EXPORTS) +
                         " and importing only Windows/UCRT system DLLs; imports " + ", ".join(pe["imports"]) +
                         "; exports " + ", ".join(pe["exports"]))
    return {"status": "pass", "target": "win32-x64", "path": str(output), "sha256": digest(output), "size": output.stat().st_size,
            "architecture": "x86_64", "dependencies": pe["imports"], "exports": pe["exports"], "droppedLinkInputs": dropped,
            "matchesReviewedArtifact": bool(artifact) and digest(output) == artifact["sha256"], "archivesSha256": pins,
            "bridgeSha256": {p.name: digest(p) for p in NATIVE.iterdir() if p.is_file()}, **windows_toolchain()}


def build(archives, work, output, jobs, target="darwin-arm64"):
    manifest = json.loads(MANIFEST.read_text())
    if target not in TARGETS:
        raise ValueError("Unsupported target: " + target)
    # A target without a reviewed pin yet still builds; its result reports the hash to pin.
    artifact = manifest["files"].get(target)
    if sys.platform != TARGETS[target] or not 1 <= jobs <= 16:
        raise ValueError("A native " + TARGETS[target] + " host and 1..16 build jobs are required for " + target)
    if work.exists() or output.exists() or output.is_symlink():
        raise ValueError("Build directory and verifier output must not already exist")
    adapter_source = json.loads(ADAPTER_MANIFEST.read_text())["source"]
    pins = dict(manifest["source"]["archivesSha256"])
    if target != "darwin-arm64":
        pins[OPENSSL_ARCHIVE] = adapter_source["archivesSha256"][OPENSSL_ARCHIVE]
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
    if target != "darwin-arm64":
        destinations[OPENSSL_ARCHIVE] = work / "openssl-source"
        if set(pins) != set(destinations):
            raise ValueError("The complete pinned source archive set is required")
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

    # New targets get the host adapter's determinism environment. darwin-arm64 keeps the
    # inherited environment its reviewed artifact was built with.
    environment = None if target == "darwin-arm64" else {
        **os.environ, "SOURCE_DATE_EPOCH": str(adapter_source["sourceDateEpoch"]), "ZERO_AR_DATE": "1"}

    def run(command, logfile, cwd=None):
        with (work / logfile).open("w") as log:
            log.write(json.dumps(list(map(str, command))) + "\n"); log.flush()
            result = subprocess.run(command, cwd=cwd, env=environment, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError("Native build failed; inspect " + str(work / logfile))

    if target == "win32-x64":
        result = build_windows(work, output, jobs, run, artifact, core, boost, sodium, work / "openssl-source", pins)
        (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        return result

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
              "matchesReviewedArtifact": bool(artifact) and digest(output) == artifact["sha256"], "archivesSha256": pins,
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
    parser.add_argument("--target", choices=sorted(TARGETS), default="darwin-arm64")
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.archive_dir.resolve(), args.work_dir.absolute(), args.output.absolute(), args.jobs, args.target), indent=2))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + "\n")
