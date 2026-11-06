#!/usr/bin/env python3
"""Derive Desktop send fixtures from the firmware research tree's public adapter fixtures.

Reads only the checked-in public plan ABI files. Writes one JSON file:
adapter-format plan/outputs replies (inverse of plan_from_adapter), the Python
reference 65000 encoding, a synthetic signed-tx layout accepted by the
reference parser, and a libsodium-encrypted key-image record.
"""
import ctypes, ctypes.util, hashlib, json, sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(ROOT / "commands"))
import test_signing as signing  # noqa: E402
import test_wire as wire  # noqa: E402
import test_key_image as key_images  # noqa: E402

FIXTURES = ROOT / "evidence/2026-11-04-host/fixtures"


def adapter_plan(plan):
    inputs = []
    for s in plan.sources[:plan.input_count]:
        inputs.append({"amount": s.amount, "real_member": s.real_member, "output_index": s.output_index,
                       "subaddress_major": s.subaddress_major, "subaddress_minor": s.subaddress_minor,
                       "tx_public_key": bytes(s.tx_public_key).hex(), "mask": bytes(s.mask).hex(),
                       "additional_tx_public_keys": [bytes(s.additional_tx_public_keys[i]).hex() for i in range(s.additional_key_count)],
                       "ring": [{"global_index": r.global_index, "public_key": bytes(r.public_key).hex(),
                                 "commitment": bytes(r.commitment).hex()} for r in s.ring]})
    outputs = [{"amount": d.amount, "address": bytes(d.address).decode(), "is_change": bool(d.is_change),
                "change_major": d.change_major, "change_minor": d.change_minor} for d in plan.destinations[:plan.output_count]]
    return {"status": "pass", "network": plan.network, "fee": plan.fee, "inputs": inputs, "outputs": outputs}


def outputs_reply(plan):
    items = []
    for i, s in enumerate(plan.sources[:plan.input_count]):
        real = s.ring[s.real_member]
        items.append({"transfer_index": i, "amount": s.amount, "global_index": real.global_index,
                      "out_key": bytes(real.public_key).hex(), "tx_public_key": bytes(s.tx_public_key).hex(),
                      "additional_tx_public_keys": [bytes(s.additional_tx_public_keys[n]).hex() for n in range(s.additional_key_count)],
                      "output_index": s.output_index, "subaddress_major": s.subaddress_major,
                      "subaddress_minor": s.subaddress_minor})
    return {"status": "pass", "offset": 0, "total": plan.input_count, "outputs": items}


def det(label, n=32):
    out = b""
    counter = 0
    while len(out) < n:
        out += hashlib.sha256(f"{label}/{counter}".encode()).digest()
        counter += 1
    return out[:n]


def synthetic_tx(plan, name):
    blob = wire.vint(2) + wire.vint(0) + wire.vint(plan.input_count)
    key_images = []
    for i, s in enumerate(plan.sources[:plan.input_count]):
        blob += b"\x02" + wire.vint(0) + wire.vint(16)
        last = 0
        for r in s.ring:
            blob += wire.vint(r.global_index - last)
            last = r.global_index
        image = det(f"{name}/key-image/{i}")
        key_images.append(image.hex())
        blob += image
    blob += wire.vint(plan.output_count)
    for j in range(plan.output_count):
        blob += wire.vint(0) + b"\x03" + det(f"{name}/output/{j}") + det(f"{name}/tag/{j}", 1)
    extra = b"\x01" + det(f"{name}/tx-public")
    blob += wire.vint(len(extra)) + extra
    prefix_end = len(blob)
    blob += b"\x06" + wire.vint(plan.fee)
    for j in range(plan.output_count):
        blob += det(f"{name}/amount/{j}", 8)
    for j in range(plan.output_count):
        blob += det(f"{name}/commitment/{j}")
    base_end = len(blob)
    rounds = 7
    blob += wire.vint(1) + det(f"{name}/bp", 6 * 32) + wire.vint(rounds) + det(f"{name}/L", rounds * 32)
    blob += wire.vint(rounds) + det(f"{name}/R", rounds * 32)
    blob += det(f"{name}/clsag", plan.input_count * 18 * 32) + det(f"{name}/pseudo", plan.input_count * 32)
    parsed = signing.parse_transaction(blob)
    assert parsed["prefix_end"] == prefix_end and parsed["base_end"] == base_end and parsed["fee"] == plan.fee
    assert [i["key_image"] for i in parsed["inputs"]] == key_images
    return {"hex": blob.hex(), "prefixEnd": prefix_end, "baseEnd": base_end, "keyImages": key_images}


def sealed_key_image():
    lib = ctypes.CDLL(ctypes.util.find_library("sodium") or "/opt/homebrew/lib/libsodium.dylib")
    assert lib.sodium_init() >= 0
    key, nonce = det("key-image/enc-key"), det("key-image/nonce", 12)
    plaintext = det("key-image/image") + det("key-image/signature", 64)
    out = ctypes.create_string_buffer(len(plaintext) + 16)
    length = ctypes.c_ulonglong()
    fn = lib.crypto_aead_chacha20poly1305_ietf_encrypt
    fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulonglong), ctypes.c_void_p, ctypes.c_ulonglong,
                   ctypes.c_void_p, ctypes.c_ulonglong, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    assert fn(out, ctypes.byref(length), plaintext, len(plaintext), None, 0, None, nonce, key) == 0
    return {"key": key.hex(), "iv": nonce.hex(), "blob": out.raw[:length.value].hex(), "plaintext": plaintext.hex()}


result = {"source": "keepkey-firmware tools/monero-feasibility evidence/2026-11-04-host/fixtures (public test material)",
          "cases": {}, "sealedKeyImage": sealed_key_image()}
for name in ("base", "subaddress", "four-inputs-reversed-selection"):
    raw = (FIXTURES / f"{name}-plan.bin").read_bytes()
    plan = signing.Plan.from_buffer_copy(raw)
    request = json.loads((FIXTURES / f"{name}-request.json").read_text())
    result["cases"][name] = {"planBinSha256": hashlib.sha256(raw).hexdigest(), "walletAddress": request["address"],
                             "adapterPlan": adapter_plan(plan), "adapterOutputs": outputs_reply(plan),
                             "signRequestHex": signing.encode_plan(plan).hex(), "signedTransaction": synthetic_tx(plan, name),
                             "transferDetailsHex": [key_images.transfer({"output_public": o["out_key"], "tx_public": o["tx_public_key"],
                                 "output_index": o["output_index"], "major": o["subaddress_major"], "minor": o["subaddress_minor"]},
                                 additional=[bytes.fromhex(k) for k in o["additional_tx_public_keys"]])["body"].hex()
                                 for o in outputs_reply(plan)["outputs"]]}
OUT.write_text(json.dumps(result, indent=1) + "\n")
print(json.dumps({"written": str(OUT), "cases": list(result["cases"])}))
