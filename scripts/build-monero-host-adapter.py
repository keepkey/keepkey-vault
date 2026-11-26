#!/usr/bin/env python3
"""Build the read-only Monero export decoder for one Desktop target.

Targets: darwin-arm64 (macOS 13.0 or later, Apple clang) and win32-x64 (MSYS2
UCRT64 MinGW-w64 GCC, fully static runtime; run under MSYS2 Python).

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
TARGETS = {"darwin-arm64": "darwin", "win32-x64": ("msys", "cygwin")}
# Windows system DLLs the static MinGW build may import. MinGW runtime DLLs and
# the MSVC runtime are never allowed: the adapter must run without sidecars.
WIN32_ALLOWED_IMPORTS = {"kernel32.dll", "advapi32.dll", "ws2_32.dll", "crypt32.dll", "bcrypt.dll", "user32.dll",
                         "iphlpapi.dll", "mswsock.dll", "shell32.dll", "ole32.dll", "ucrtbase.dll"}
WIN32_FORBIDDEN_IMPORTS = ("libstdc++", "libgcc_s", "libwinpthread", "vcruntime", "msvcp", "msvcrt.dll")


def native_path(path):
    """Windows form of an MSYS path, for native MinGW tools."""
    return subprocess.check_output(["cygpath", "-m", str(path)], text=True).strip()


def posix_path(name):
    """MSYS form of a native C:/... path written by native MinGW tools."""
    name = name.replace("\\", "/")
    return "/" + name[0].lower() + name[2:] if len(name) > 2 and name[1] == ":" and name[2] == "/" else name


def pe_imports(path):
    dump = subprocess.check_output(["objdump", "-p", str(path)], text=True)
    return sorted({line.split("DLL Name:", 1)[1].strip() for line in dump.splitlines() if "DLL Name:" in line})


def pe_imports_problem(imports):
    for name in imports:
        lower = name.lower()
        if any(lower.startswith(bad) for bad in WIN32_FORBIDDEN_IMPORTS):
            return "forbidden runtime import " + name
        if lower not in WIN32_ALLOWED_IMPORTS and not lower.startswith("api-ms-win-"):
            return "import outside the Windows system allow-list " + name
    return None


def msys2_packages():
    return subprocess.check_output(["pacman", "-Q"], text=True).splitlines()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_used_boost_headers(cache, boost, to_path=str):
    # Core marks Boost as a system include. Other dependency include paths can
    # therefore shadow it even when FindBoost selects our pinned headers/libs.
    # Validate the headers the compiler actually used, not only CMake's cache.
    used = {}
    for dependency in cache.rglob("*.o.d"):
        for name in shlex.split(dependency.read_text().replace("\\\n", " ")):
            name = to_path(name)
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


def build(archives, work, output, jobs, target="darwin-arm64"):
    manifest = json.loads(MANIFEST.read_text())
    source = manifest["source"]
    if target not in TARGETS:
        raise ValueError("Unsupported target " + target + "; supported: " + ", ".join(TARGETS))
    artifact = manifest["files"].get(target, {})
    adapter = NATIVE / "host-adapter.cpp"
    host = TARGETS[target]
    if not sys.platform.startswith(host) or not 1 <= jobs <= 16:
        raise ValueError("A " + target + " build host and 1..16 build jobs are required")
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

    def run(command, logfile, cwd=None):
        with (work / logfile).open("w") as log:
            log.write(json.dumps(list(map(str, command))) + "\n"); log.flush()
            environment = {**os.environ, "SOURCE_DATE_EPOCH": str(source["sourceDateEpoch"]), "ZERO_AR_DATE": "1"}
            if target == "win32-x64":
                # Native MinGW tools get explicit native paths; never rewrite them.
                environment["MSYS2_ARG_CONV_EXCL"] = "*"
            result = subprocess.run(command, cwd=cwd, env=environment, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError("Native build failed; inspect " + str(work / logfile))

    if target == "win32-x64":
        result = build_win32(work, output, jobs, run, artifact, pins, adapter, core, boost, sodium, openssl)
    else:
        result = build_darwin(work, output, jobs, run, artifact, pins, adapter, core, boost, sodium, openssl)
    (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def build_darwin(work, output, jobs, run, artifact, pins, adapter, core, boost, sodium, openssl):
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
              "matchesReviewedArtifact": digest(output) == artifact["sha256"], "archivesSha256": pins,
              "usedBoostHeaders": used_boost_headers,
              "sourceSha256": digest(adapter), "buildScriptSha256": digest(Path(__file__)),
              "compiler": subprocess.check_output(["/usr/bin/clang++", "--version"], text=True).splitlines()[0],
              "sdkVersion": subprocess.check_output(["xcrun", "--show-sdk-version"], text=True).strip()}
    return result


def expand_response_files(command, cwd):
    expanded = []
    for arg in command:
        if arg.startswith("@") and (cwd / arg[1:]).is_file():
            expanded += shlex.split((cwd / arg[1:]).read_text())
        else:
            expanded.append(arg)
    return expanded


def link_command(link_txt):
    lines = [line for line in link_txt.read_text().splitlines() if " -o " in line]
    if len(lines) != 1:
        raise ValueError("Expected exactly one link command in " + str(link_txt))
    return shlex.split(lines[0])


def msys2_library(arg):
    # Import or static libraries from the MSYS2 tree are unpinned; only the
    # pinned OpenSSL, Boost and sodium builds may reach the shipped binary.
    lower = arg.replace("\\", "/").lower()
    return lower.endswith(".a") and ("/msys64/" in lower or lower.startswith(("/ucrt64/", "/mingw64/", "/usr/lib/")))


def build_win32(work, output, jobs, run, artifact, pins, adapter, core, boost, sodium, openssl):
    n = native_path
    nwork, nnative = n(work), n(NATIVE)
    prefix = "-ffile-prefix-map=" + nwork + "=/monero-host-adapter-build"
    run(["/usr/bin/perl", "./Configure", "mingw64", "no-shared", "no-tests", "no-module", "no-engine", "no-legacy", "no-dso",
         prefix], "openssl-configure.log", openssl)
    run(["make", "-j" + str(jobs), "build_libs"], "openssl-build.log", openssl)
    run(["sh", "./bootstrap.sh", "--with-libraries=" + ",".join(BOOST_LIBRARIES), "--with-toolset=gcc"], "boost-bootstrap.log", boost)
    run(["./b2"] + ["--with-" + name for name in BOOST_LIBRARIES] + [
        "--layout=system", "toolset=gcc", "variant=release", "link=static", "runtime-link=static", "threading=multi",
        "threadapi=win32", "target-os=windows", "architecture=x86", "address-model=64",
        "boost.locale.icu=off", "boost.locale.iconv=off",
        "cxxflags=" + prefix + " -ffunction-sections -fdata-sections", "stage", "-j" + str(jobs)], "boost-build.log", boost)
    objects = []
    for name, relative in [("sodium-verify.o", "crypto_verify/verify.c"),
                           ("sodium-siphash.o", "crypto_shorthash/siphash24/ref/shorthash_siphash24_ref.c")]:
        objects.append(work / name)
        run(["gcc", "-c", "-O2", "-ffunction-sections", "-fdata-sections", prefix,
             "-I" + n(sodium / "src/libsodium/include/sodium"), n(sodium / "src/libsodium" / relative),
             "-o", n(work / name)], name.replace(".o", "-build.log"))
    hook = work / "host-adapter.cmake"
    hook.write_text("\n".join([
        "function(keepkey_host_adapter)",
        ' add_executable(monero_host_adapter "' + n(adapter) + '")',
        " target_link_libraries(monero_host_adapter PRIVATE wallet version)",
        ' set_target_properties(monero_host_adapter PROPERTIES CXX_STANDARD 14 OUTPUT_NAME monero-host-adapter RUNTIME_OUTPUT_DIRECTORY "' + n(work / "intermediate") + '")',
        " target_link_options(monero_host_adapter PRIVATE -Wl,--gc-sections)",
        "endfunction()", "cmake_language(DEFER CALL keepkey_host_adapter)", ""]))
    cache = work / "core-build"
    mappings = prefix + " -ffile-prefix-map=" + nnative + "=/monero-host-adapter-source -ffunction-sections -fdata-sections"
    stage = boost / "stage/lib"
    run(["cmake", "-G", "MSYS Makefiles", "-S", n(core), "-B", n(cache), "-DMANUAL_SUBMODULES=ON", "-DBUILD_TESTS=OFF",
         "-DBUILD_DOCUMENTATION=OFF", "-DBUILD_GUI_DEPS=OFF", "-DUSE_DEVICE_TREZOR=OFF", "-DCMAKE_DISABLE_FIND_PACKAGE_HIDAPI=TRUE",
         "-DMONERO_WALLET_CRYPTO_LIBRARY=cn", "-DCMAKE_BUILD_TYPE=Release", "-DSTATIC=ON",
         "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_C_FLAGS=" + mappings, "-DCMAKE_CXX_FLAGS=" + mappings + " -Wa,-mbig-obj",
         "-DCMAKE_C_USE_RESPONSE_FILE_FOR_OBJECTS=OFF", "-DCMAKE_CXX_USE_RESPONSE_FILE_FOR_OBJECTS=OFF",
         "-DCMAKE_C_USE_RESPONSE_FILE_FOR_LIBRARIES=OFF", "-DCMAKE_CXX_USE_RESPONSE_FILE_FOR_LIBRARIES=OFF",
         "-DBOOST_IGNORE_SYSTEM_PATHS=ON", "-DBOOST_ROOT=" + n(boost), "-DBoost_INCLUDE_DIR=" + n(boost),
         "-DBoost_USE_STATIC_LIBS=ON", "-DBoost_LIBRARY_DIR_RELEASE=" + n(stage), "-DBoost_LIBRARY_DIR_DEBUG=" + n(stage),
         "-DOPENSSL_ROOT_DIR=" + n(openssl), "-DOPENSSL_INCLUDE_DIR=" + n(openssl / "include"),
         "-DOPENSSL_SSL_LIBRARY=" + n(openssl / "libssl.a"), "-DOPENSSL_CRYPTO_LIBRARY=" + n(openssl / "libcrypto.a"),
         "-DCMAKE_PROJECT_monero_INCLUDE=" + n(hook)] + [
             "-DBoost_" + name.upper() + "_LIBRARY_" + variant + "=" + n(stage / ("libboost_" + name + ".a"))
             for name in BOOST_LIBRARIES for variant in ["RELEASE", "DEBUG"]], "core-configure.log")
    run(["cmake", "--build", n(cache), "--target", "monero_host_adapter", "-j" + str(jobs)], "core-build.log")
    used_boost_headers = validate_used_boost_headers(cache, boost, posix_path)
    directory = cache / "CMakeFiles/monero_host_adapter.dir"
    command = expand_response_files(link_command(directory / "link.txt"), cache)
    command = [arg for arg in command if not msys2_library(arg) and arg != "-Wl,--export-all-symbols"]
    command[command.index("-o") + 1] = n(output)
    command += [n(o) for o in objects] + ["-static", "-static-libgcc", "-static-libstdc++",
                                          "-Wl,--gc-sections", "-Wl,--no-insert-timestamp"]
    run(command, "final-link.log", cache)
    imports = pe_imports(output)
    header = subprocess.check_output(["objdump", "-f", str(output)], text=True)
    problem = pe_imports_problem(imports)
    if problem or "pei-x86-64" not in header:
        raise ValueError("Adapter import or architecture contract failed: " + (problem or header))
    return {"status": "pass", "path": str(output), "sha256": digest(output), "size": output.stat().st_size,
            "architecture": "x86_64", "dependencies": imports,
            "matchesReviewedArtifact": digest(output) == artifact.get("sha256"), "archivesSha256": pins,
            "usedBoostHeaders": used_boost_headers,
            "sourceSha256": digest(adapter), "buildScriptSha256": digest(Path(__file__)),
            "compiler": subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0],
            "linker": subprocess.check_output(["ld", "--version"], text=True).splitlines()[0],
            "msys2Packages": msys2_packages()}


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
