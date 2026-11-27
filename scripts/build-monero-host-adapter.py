#!/usr/bin/env python3
"""Build the read-only Monero export decoder for one platform key.

darwin-arm64: macOS 13.0 or later, Apple clang (the reviewed recipe, unchanged).
win32-x64: native MSYS2 UCRT64 (MinGW-w64 GCC) build of a fully static .exe that
imports only Windows/UCRT system DLLs. Run it with the UCRT64 Python inside an
MSYS2 UCRT64 shell, so msys perl/make/sh and the UCRT64 gcc/cmake are on PATH.

Supply all seven pinned source archives explicitly. No downloads, device access,
wallet credentials, signing or relay are involved. A fresh build records the
compiler, SDK, source pins and artifact hash for native fixture qualification.
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
MANIFEST = ROOT / "projects/keepkey-vault/monero-cli/host-adapter-manifest.json"
NATIVE = ROOT / "projects/keepkey-vault/native/monero-host-adapter"
BOOST_LIBRARIES = ["filesystem", "thread", "date_time", "chrono", "serialization", "program_options", "locale", "atomic"]
SYSTEM_DEPENDENCIES = {
    "/System/Library/Frameworks/IOKit.framework/Versions/A/IOKit",
    "/System/Library/Frameworks/Kerberos.framework/Versions/A/Kerberos",
    "/usr/lib/libmd.dylib", "/usr/lib/libc++.1.dylib", "/usr/lib/libSystem.B.dylib",
}
TARGETS = {"darwin-arm64": "darwin", "win32-x64": "win32"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_used_boost_headers(cache, boost):
    # Core marks Boost as a system include. Other dependency include paths can
    # therefore shadow it even when FindBoost selects our pinned headers/libs.
    # Validate the headers the compiler actually used, not only CMake's cache.
    used = {}
    for dependency in cache.rglob("*.o.d"):
        for name in shlex.split(dependency.read_text().replace("\\\n", " ")):
            if "/boost/" not in name:
                continue
            # Core's epee adds its own portable archive headers under boost/;
            # those belong to the separately pinned Core archive.
            if Path(name).is_relative_to(cache.parent / "core-source"):
                continue
            relative = "boost/" + name.split("/boost/", 1)[1]
            actual, pinned = Path(name), boost / relative
            if not actual.is_file() or not pinned.is_file() or digest(actual) != digest(pinned):
                raise ValueError("Compiler used a Boost header outside the pinned source bytes: " + relative)
            used[relative] = digest(pinned)
    if not used:
        raise ValueError("No compiler dependency evidence for the pinned Boost headers")
    return {"count": len(used), "sha256": hashlib.sha256(json.dumps(used, sort_keys=True).encode()).hexdigest()}


# --- win32-x64: MSYS2 UCRT64, fully static -----------------------------------
# Everything below runs only for --target win32-x64. It is kept in this file, not
# a shared module, so the manifest's buildScriptSha256 pin covers all of it.
#
# The only DLLs the shipped .exe may import: Windows and UCRT system libraries.
# A MinGW runtime (libstdc++-6, libgcc_s_seh-1, libwinpthread-1), the MSVC
# runtime (VCRUNTIME140, MSVCP140) or any third-party DLL fails the build.
WINDOWS_SYSTEM_DLLS = {"kernel32.dll", "advapi32.dll", "user32.dll", "ws2_32.dll", "wsock32.dll", "mswsock.dll",
                       "iphlpapi.dll", "crypt32.dll", "bcrypt.dll", "shell32.dll", "ole32.dll", "secur32.dll",
                       "dnsapi.dll", "ucrtbase.dll"}
# Import libraries for those DLLs, plus the static MinGW runtime pieces that -static links in.
WINDOWS_LINK_LIBRARIES = {name[:-4] for name in WINDOWS_SYSTEM_DLLS} | {
    "uuid", "ntdll", "psapi", "userenv", "pthread", "m", "stdc++", "gcc", "gcc_eh", "mingwex", "mingw32", "moldname"}
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
    """CMake's final link line with response files expanded and every archive or library
    from outside this build (the MSYS2 prefix) removed, except Windows system import
    libraries. The dropped inputs are reported, so a review sees exactly what was cut."""
    lines = [shlex.split(line) for line in (cache / "CMakeFiles" / (target_name + ".dir") / "link.txt").read_text().splitlines() if line.strip()]
    lines = [line for line in lines if "-o" in line]
    if len(lines) != 1:
        raise ValueError("Expected exactly one link command for " + target_name)
    expanded = []
    for arg in lines[0]:
        expanded += shlex.split((cache / arg[1:]).read_text()) if arg.startswith("@") else [arg]
    command, dropped, inside = [], [], Path(work).resolve()
    for arg in expanded:
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


def windows_missing_link_inputs(cache, command):
    """Files the final link reads that the Core build did not produce."""
    output = command[command.index("-o") + 1]
    return [arg for arg in command[1:] if not arg.startswith("-") and arg != output and not (cache / arg).is_file()]


def windows_toolchain():
    packages = subprocess.check_output(["pacman", "-Q"], text=True).splitlines()
    return {"compiler": subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0],
            "msys2Packages": sorted(line for line in packages if line.startswith(WINDOWS_TOOLCHAIN_PACKAGES))}


def build_windows(work, output, jobs, run, artifact, adapter, core, boost, sodium, openssl, pins):
    posix = lambda path: Path(path).as_posix()  # noqa: E731  CMake and msys tools read forward slashes
    prefix = "-ffile-prefix-map=" + posix(work) + "=/monero-host-adapter-build"
    sections = ["-ffunction-sections", "-fdata-sections"]
    # msys perl and make, as OpenSSL's NOTES-WINDOWS requires for the mingw64 target.
    run(["perl", "Configure", "mingw64", "no-shared", "no-tests", "no-module", "no-engine", "no-legacy", "no-dso",
         prefix] + sections, "openssl-configure.log", openssl)
    run(["make", "-j" + str(jobs), "build_libs"], "openssl-build.log", openssl)
    run(["sh", "bootstrap.sh", "--with-libraries=" + ",".join(BOOST_LIBRARIES), "--with-toolset=gcc"], "boost-bootstrap.log", boost)
    run([str(boost / "b2.exe")] + ["--with-" + name for name in BOOST_LIBRARIES] + [
        "--layout=system", "toolset=gcc", "variant=release", "link=static", "runtime-link=static", "threading=multi",
        "threadapi=win32", "target-os=windows", "architecture=x86", "address-model=64",
        "boost.locale.icu=off", "boost.locale.iconv=off", "cxxflags=" + " ".join(sections + [prefix]),
        "stage", "-j" + str(jobs)], "boost-build.log", boost)
    objects = []
    for name, relative in [("sodium-verify.o", "src/libsodium/crypto_verify/verify.c"),
                           ("sodium-siphash.o", "src/libsodium/crypto_shorthash/siphash24/ref/shorthash_siphash24_ref.c")]:
        objects.append(work / name)
        run(["gcc", "-c", "-O2"] + sections + [prefix, "-I" + posix(sodium / "src/libsodium/include/sodium"),
             posix(sodium / relative), "-o", posix(work / name)], name + ".log")
    hook = work / "host-adapter.cmake"
    hook.write_text("\n".join([
        "function(keepkey_host_adapter)",
        ' add_executable(monero_host_adapter "' + posix(adapter) + '")',
        " target_link_libraries(monero_host_adapter PRIVATE wallet version)",
        ' set_target_properties(monero_host_adapter PROPERTIES CXX_STANDARD 14 OUTPUT_NAME monero-host-adapter RUNTIME_OUTPUT_DIRECTORY "' + posix(work / "intermediate") + '")',
        " target_link_options(monero_host_adapter PRIVATE -static -static-libgcc -static-libstdc++ -Wl,--gc-sections -Wl,--no-insert-timestamp)",
        "endfunction()", "cmake_language(DEFER CALL keepkey_host_adapter)", ""]))
    cache = work / "core-build"
    mappings = " ".join(sections + [prefix, "-ffile-prefix-map=" + posix(NATIVE) + "=/monero-host-adapter-source"])
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
    # Core's own link of this target pulls in MSYS2's static libunbound (built against a
    # newer OpenSSL) and fails; that binary is discarded anyway. make -k still builds every
    # object and library, and the final link below, which drops unbound, is the real check.
    run(["cmake", "--build", posix(cache), "--target", "monero_host_adapter", "-j" + str(jobs), "--", "-k"], "core-build.log", check=False)
    used_boost_headers = validate_used_boost_headers(cache, boost)
    command, dropped = windows_link_command(cache, "monero_host_adapter", work)
    missing = windows_missing_link_inputs(cache, command)
    if missing:
        raise RuntimeError("Core build did not produce " + ", ".join(missing[:5]) + "; inspect " + str(work / "core-build.log"))
    command[command.index("-o") + 1] = posix(output)
    command += [posix(path) for path in objects]
    run(command, "final-link.log", cache)
    pe = windows_pe_report(output)
    disallowed = [dll for dll in pe["imports"] if not windows_import_allowed(dll)]
    if not pe["x86_64"] or disallowed:
        raise ValueError("Adapter must be an x86-64 PE importing only Windows/UCRT system DLLs; found " + ", ".join(disallowed or ["a non-x86-64 image"]))
    return {"status": "pass", "target": "win32-x64", "path": str(output), "sha256": digest(output), "size": output.stat().st_size,
            "architecture": "x86_64", "dependencies": pe["imports"], "droppedLinkInputs": dropped,
            "matchesReviewedArtifact": bool(artifact) and digest(output) == artifact["sha256"], "archivesSha256": pins,
            "usedBoostHeaders": used_boost_headers, "sourceSha256": digest(adapter), "buildScriptSha256": digest(Path(__file__)),
            **windows_toolchain()}


def build(archives, work, output, jobs, target="darwin-arm64"):
    manifest = json.loads(MANIFEST.read_text())
    source = manifest["source"]
    if target not in TARGETS:
        raise ValueError("Unsupported target: " + target)
    # A target without a reviewed pin yet still builds; its result reports the hash to pin.
    artifact = manifest["files"].get(target)
    adapter = NATIVE / "host-adapter.cpp"
    if sys.platform != TARGETS[target] or not 1 <= jobs <= 16:
        raise ValueError("A native " + TARGETS[target] + " host and 1..16 build jobs are required for " + target)
    if work.exists() or output.exists() or output.is_symlink():
        raise ValueError("Build directory and adapter output must not already exist")
    if digest(adapter) != source["sha256"] or digest(Path(__file__)) != source["buildScriptSha256"]:
        raise ValueError("The native adapter or build script differs from its reviewed source pin")
    pins = source["archivesSha256"]
    for name, expected in pins.items():
        archive = archives / name
        if archive.is_symlink() or not archive.is_file() or digest(archive) != expected:
            raise ValueError("Missing or mismatched pinned source archive: " + name)
    work.mkdir(parents=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    core, boost, sodium, openssl = (work / name for name in ["core-source", "boost-source", "sodium-source", "openssl-source"])
    destinations = {"monero-core-v0.18.5.4.tar.gz": core,
                    "monero-randomx.tar.gz": core / "external/randomx",
                    "monero-rapidjson.tar.gz": core / "external/rapidjson",
                    "monero-supercop.tar.gz": core / "external/supercop",
                    "boost-1.90.0.tar.xz": boost, "libsodium-1.0.22.tar.gz": sodium,
                    "openssl-3.5.9.tar.gz": openssl}
    if set(pins) != set(destinations):
        raise ValueError("The complete seven-archive source pin set is required")
    for name, destination in destinations.items():
        destination.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archives / name) as archive:
            for member in archive:
                parts = Path(member.name).parts[1:]
                if not parts:
                    continue
                member.name = str(Path(*parts))
                archive.extract(member, destination, filter="data")

    def run(command, logfile, cwd=None, check=True):
        with (work / logfile).open("w") as log:
            log.write(json.dumps(list(map(str, command))) + "\n"); log.flush()
            environment = {**os.environ, "SOURCE_DATE_EPOCH": str(source["sourceDateEpoch"]), "ZERO_AR_DATE": "1"}
            result = subprocess.run(command, cwd=cwd, env=environment, stdout=log, stderr=subprocess.STDOUT)
        if check and result.returncode:
            raise RuntimeError("Native build failed; inspect " + str(work / logfile))

    if target == "win32-x64":
        result = build_windows(work, output, jobs, run, artifact, adapter, core, boost, sodium, openssl, pins)
        (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        return result

    flags = "-arch arm64 -mmacosx-version-min=13.0 -ffile-prefix-map=" + str(work) + "=/monero-host-adapter-build"
    run(["/usr/bin/perl", "./Configure", "darwin64-arm64-cc", "no-shared", "no-tests", "no-module", "no-engine", "no-legacy", "no-dso",
         "-mmacosx-version-min=13.0", "-ffile-prefix-map=" + str(work) + "=/monero-host-adapter-build"], "openssl-configure.log", openssl)
    run(["make", "-j" + str(jobs), "build_libs"], "openssl-build.log", openssl)
    run(["./bootstrap.sh", "--with-libraries=" + ",".join(BOOST_LIBRARIES), "--with-toolset=clang"], "boost-bootstrap.log", boost)
    run(["./b2"] + ["--with-" + name for name in BOOST_LIBRARIES] + [
        "variant=release", "link=static", "runtime-link=shared", "threading=multi", "target-os=darwin",
        "architecture=arm", "address-model=64", "boost.locale.icu=off", "boost.locale.iconv=off",
        "cxxflags=" + flags, "linkflags=-arch arm64 -mmacosx-version-min=13.0", "stage", "-j" + str(jobs)], "boost-build.log", boost)
    sodium_object = work / "sodium-verify.o"
    run(["/usr/bin/clang", "-c", "-arch", "arm64", "-mmacosx-version-min=13.0", "-O2", "-fPIC",
         "-I" + str(sodium / "src/libsodium/include/sodium"), str(sodium / "src/libsodium/crypto_verify/verify.c"),
         "-o", str(sodium_object)], "sodium-build.log")
    siphash_object = work / "sodium-siphash.o"
    run(["/usr/bin/clang", "-c", "-arch", "arm64", "-mmacosx-version-min=13.0", "-O2", "-fPIC",
         "-I" + str(sodium / "src/libsodium/include/sodium"), str(sodium / "src/libsodium/crypto_shorthash/siphash24/ref/shorthash_siphash24_ref.c"),
         "-o", str(siphash_object)], "sodium-siphash-build.log")
    hook = work / "host-adapter.cmake"
    hook.write_text("\n".join([
        "function(keepkey_host_adapter)",
        ' add_executable(monero_host_adapter "' + str(adapter) + '")',
        " target_link_libraries(monero_host_adapter PRIVATE wallet version)",
        ' set_target_properties(monero_host_adapter PROPERTIES CXX_STANDARD 14 OUTPUT_NAME monero-host-adapter RUNTIME_OUTPUT_DIRECTORY "' + str(work / "intermediate") + '")',
        " target_link_options(monero_host_adapter PRIVATE -Wl,-dead_strip -Wl,-dead_strip_dylibs)",
        "endfunction()", "cmake_language(DEFER CALL keepkey_host_adapter)", ""]))
    cache = work / "core-build"
    mappings = "-ffile-prefix-map=" + str(work) + "=/monero-host-adapter-build -ffile-prefix-map=" + str(NATIVE) + "=/monero-host-adapter-source"
    run(["cmake", "-S", str(core), "-B", str(cache), "-DMANUAL_SUBMODULES=ON", "-DBUILD_TESTS=OFF",
         "-DBUILD_DOCUMENTATION=OFF", "-DBUILD_GUI_DEPS=OFF", "-DUSE_DEVICE_TREZOR=OFF", "-DCMAKE_DISABLE_FIND_PACKAGE_HIDAPI=TRUE",
         "-DMONERO_WALLET_CRYPTO_LIBRARY=cn", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
         "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", "-DCMAKE_OSX_ARCHITECTURES=arm64",
         "-DCMAKE_C_FLAGS=" + mappings, "-DCMAKE_CXX_FLAGS=" + mappings,
         "-DBOOST_IGNORE_SYSTEM_PATHS=ON", "-DBOOST_ROOT=" + str(boost), "-DBoost_INCLUDE_DIR=" + str(boost),
         "-DBoost_USE_STATIC_LIBS=ON", "-DBoost_LIBRARY_DIR_RELEASE=" + str(boost / "stage/lib"),
         "-DBoost_LIBRARY_DIR_DEBUG=" + str(boost / "stage/lib"),
         "-DOPENSSL_ROOT_DIR=" + str(openssl), "-DOPENSSL_INCLUDE_DIR=" + str(openssl / "include"),
         "-DOPENSSL_SSL_LIBRARY=" + str(openssl / "libssl.a"), "-DOPENSSL_CRYPTO_LIBRARY=" + str(openssl / "libcrypto.a"),
         "-DCMAKE_PROJECT_monero_INCLUDE=" + str(hook)] + [
             "-DBoost_" + name.upper() + "_LIBRARY_" + variant + "=" + str(boost / "stage/lib" / ("libboost_" + name + ".a"))
             for name in BOOST_LIBRARIES for variant in ["RELEASE", "DEBUG"]], "core-configure.log")
    run(["cmake", "--build", str(cache), "--target", "monero_host_adapter", "-j" + str(jobs)], "core-build.log")
    used_boost_headers = validate_used_boost_headers(cache, boost)
    # Core discovers broad wallet dependencies for its intermediate executable.
    # Dead-strip the read-only entry point and use only pinned static Boost,
    # OpenSSL and sodium code; never ship Homebrew runtime dylibs.
    command = shlex.split((cache / "CMakeFiles/monero_host_adapter.dir/link.txt").read_text())
    command = [arg for arg in command if not (arg.startswith("/opt/homebrew/") and arg.endswith(".dylib"))]
    if any(arg.startswith("/opt/homebrew/") and arg.endswith(".a") for arg in command):
        raise ValueError("The final adapter must not link unpinned Homebrew static archives")
    command[command.index("-o") + 1] = str(output)
    command += [str(sodium_object), str(siphash_object)]
    run(command, "final-link.log", cache)
    dependencies = [line.strip().split(" (", 1)[0] for line in
                    subprocess.check_output(["otool", "-L", str(output)], text=True).splitlines()[1:]]
    load_commands = subprocess.check_output(["otool", "-l", str(output)], text=True)
    architecture = subprocess.check_output(["lipo", "-archs", str(output)], text=True).strip()
    if not set(dependencies) <= SYSTEM_DEPENDENCIES or architecture != "arm64" or "minos 13.0" not in load_commands or "LC_UUID" not in load_commands:
        raise ValueError("Adapter dependency, architecture, minimum OS or UUID contract failed")
    result = {"status": "pass", "path": str(output), "sha256": digest(output), "size": output.stat().st_size,
              "minimumMacosVersion": "13.0", "architecture": architecture, "dependencies": dependencies,
              "matchesReviewedArtifact": bool(artifact) and digest(output) == artifact["sha256"], "archivesSha256": pins,
              "usedBoostHeaders": used_boost_headers,
              "sourceSha256": digest(adapter), "buildScriptSha256": digest(Path(__file__)),
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
