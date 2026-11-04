"""Reproduce the unsigned C773 candidates. Does not sign or access a device.

Passing this check proves deterministic compilation and static capability
checks only. The runtime and publication blockers remain in audit.json.
"""
import hashlib
import json
from pathlib import Path
import sys

here = Path(__file__).resolve().parent
for root in here.parents:
    library = root / "modules/keepkey-firmware/deps/python-keepkey"
    if (library / "keepkeylib/erc7730_compiler.py").is_file():
        sys.path.insert(0, str(library))
        break
else:
    raise SystemExit("Run inside the KeepKey stack checkout")

from keepkeylib.erc7730_compiler import compile_calldata, device_refusal

manifest = json.loads((here / "catalog-candidates.json").read_text())
for entry in manifest["entries"]:
    program = compile_calldata(
        entry["descriptor"], entry["signature"], manifest["chainId"],
        entry["contract"], trailing_data=entry["trailingData"],
    )
    expected = bytes.fromhex((here / (entry["id"] + ".c773.hex")).read_text().strip())
    if program != expected:
        raise SystemExit("Compiler bytes changed: " + entry["id"])
    if hashlib.sha256(program).hexdigest() != entry["compilation"]["sha256"]:
        raise SystemExit("Candidate hash mismatch: " + entry["id"])
    if device_refusal(program) is not None:
        raise SystemExit("Static capability check refused: " + entry["id"])
    print(entry["id"], len(program), "bytes: unsigned candidate reproduced")
