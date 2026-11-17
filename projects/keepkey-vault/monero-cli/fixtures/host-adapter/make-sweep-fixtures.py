#!/usr/bin/env python3
"""Build the public fixture generator using an already built, pinned Core adapter."""
from pathlib import Path
import argparse
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("core_build", type=Path, help="Core CMake build containing the monero_host_adapter target")
    args = parser.parse_args()
    build = args.core_build.resolve()
    target = build / "CMakeFiles/monero_host_adapter.dir"
    settings = {}
    for line in (target / "flags.make").read_text().splitlines():
        if " = " in line:
            key, value = line.split(" = ", 1)
            settings[key] = shlex.split(value)
    source = Path(__file__).with_suffix(".cpp").resolve()
    link = shlex.split((target / "link.txt").read_text())
    objects = [i for i, item in enumerate(link) if item.endswith("/host-adapter.cpp.o")]
    if len(objects) != 1:
        raise ValueError("Expected exactly one adapter source object")
    with tempfile.TemporaryDirectory(prefix="monero-public-sweep-fixtures-") as directory:
        obj, executable = Path(directory) / "generator.o", Path(directory) / "generator"
        subprocess.run([link[0], *settings["CXX_DEFINES"], *settings["CXX_INCLUDES"],
                        *settings["CXX_FLAGS"], "-c", str(source), "-o", str(obj)], check=True)
        link[objects[0]], link[link.index("-o") + 1] = str(obj), str(executable)
        subprocess.run(link, cwd=build, check=True)
        subprocess.run([str(executable), str(source.parent)], check=True)


if __name__ == "__main__":
    main()
