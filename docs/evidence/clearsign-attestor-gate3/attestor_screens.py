#!/usr/bin/env python3
"""Gate-3 capture: the ClearsignAttestorSign confirm screens (firmware #323).

Run a kkemu built with -DKK_CLEARSIGN_ATTESTOR=ON -DKK_DEBUG_LINK=ON from an
empty directory (a stale emulator.img makes it exit 1 with no message), then:

  KK_FIRMWARE=/path/to/keepkey-firmware \\
  PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python \\
  python3 attestor_screens.py ./out

python-keepkey has no generated ClearsignAttestor* classes, so the attestor
exchange is written/read at the wire layer (##, >HL header) instead of through
mapping. Everything else -- wipe/load, DebugLink press, OLED decode -- is the
existing zoo harness.

Payload = the real production Relay Bridge depositNative schema from
projects/keepkey-vault/src/bun/solana-schemas-local.json.
"""
import base64
import json
import os
import struct
import sys
import time

FW = os.environ.get("KK_FIRMWARE", os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
    "modules", "keepkey-firmware"))
sys.path.insert(0, os.path.join(FW, "deps", "python-keepkey"))
sys.path.insert(0, os.path.join(FW, "scripts", "zoo"))

from keepkeylib.client import KeepKeyDebuglinkClient
from keepkeylib.transport_udp import UDPTransport
from keepkeylib import messages_pb2 as proto
from screenshot import capture_screenshot

MSG_SIGN = 1702
MSG_SIGNATURE = 1703
MSG_BUTTON_REQUEST = proto.MessageType_ButtonRequest
MSG_BUTTON_ACK = proto.MessageType_ButtonAck
MSG_FAILURE = proto.MessageType_Failure

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                        "..", "projects", "keepkey-vault", "src", "bun",
                        "solana-schemas-local.json")
SCHEMA_KEY = "99vqwtbwytrqqd9ysxbdum3kbdxpavxytaq3cfnjsrn2:0d9e0ddf5fd51c06"


def frame(msg_type, body=b""):
    return b"##" + struct.pack(">HL", msg_type, len(body)) + body


def varint(n):
    out = b""
    while n > 0x7F:
        out += bytes([(n & 0x7F) | 0x80])
        n >>= 7
    return out + bytes([n])


def max_schema():
    """Worst case for the confirm body: 4 max-length args + 4 max-length
    accounts at index 255. 238 bytes, the largest KKSOLSC1 payload there is."""
    p = b"KKSOLSC1" + b"\x01" + bytes(range(32)) + b"\x08" + bytes(8)
    p += bytes([20]) + b"P" * 20 + bytes([20]) + b"I" * 20
    p += b"\x04" + b"".join(bytes([1, 16]) + f"Arg{i}".ljust(16, "x").encode()
                            for i in range(4))
    p += b"\x04" + b"".join(bytes([255, 16]) + f"Acct{i}".ljust(16, "x").encode()
                            for i in range(4))
    return p


def run_flow(client, payload, prefix, expect_shots):
    t = client.transport
    t._write(frame(MSG_SIGN, b"\x0a" + varint(len(payload)) + payload), None)

    shots = 0
    while True:
        msg_type, data = t._read()
        if msg_type != MSG_BUTTON_REQUEST:
            break
        shots += 1
        time.sleep(0.2)
        name = os.path.join(OUT, f"{prefix}-{shots}.png")
        capture_screenshot(client.debug, name, scale=3)
        print(f"  captured {name} ({os.path.getsize(name)}B)")
        client.debug.press_yes()
        t._write(frame(MSG_BUTTON_ACK), None)

    if msg_type == MSG_FAILURE:
        f = proto.Failure()
        f.ParseFromString(bytes(data))
        raise SystemExit(f"FAILED: {f.message}")
    if msg_type != MSG_SIGNATURE:
        raise SystemExit(f"unexpected response type {msg_type}")
    assert shots == expect_shots, f"expected {expect_shots} screens, got {shots}"
    return bytes(data)


def main():
    schema = json.load(open(REGISTRY))["schemas"][SCHEMA_KEY]
    payload = base64.b64decode(schema["payload"])
    print(f"payload: {schema['program']} / {schema['instruction']}, {len(payload)} bytes")

    client = KeepKeyDebuglinkClient(UDPTransport("127.0.0.1:11044"))
    client.set_debuglink(UDPTransport("127.0.0.1:11045"))

    client.auto_button = True
    client.wipe_device()
    client.load_device_by_mnemonic(
        mnemonic="all all all all all all all all all all all all",
        pin="", passphrase_protection=False, label="KeepKey Attestor",
        language="english",
    )
    client.auto_button = False

    data = run_flow(client, payload, "attestor-confirm", 5)

    print("worst-case schema (4 max args + 4 max accounts, 238B):")
    mx = max_schema()
    assert len(mx) == 238, len(mx)
    run_flow(client, mx, "attestor-maxlabels", 10)

    # ClearsignAttestorSignature: field 1 = signature, field 2 = public_key
    sig = data[2:2 + data[1]]
    pub = data[2 + data[1] + 2:]
    print(f"signature: {sig.hex()} ({len(sig)}B)")
    print(f"pubkey:    {pub.hex()} ({len(pub)}B)")
    assert len(sig) == 64 and len(pub) == 33

    try:
        import hashlib
        from ecdsa import VerifyingKey, SECP256k1
        vk = VerifyingKey.from_string(pub, curve=SECP256k1)
        vk.verify_digest(sig, hashlib.sha256(payload).digest())
        print("signature verifies against returned pubkey over SHA256(payload)")
    except ImportError:
        print("(ecdsa not installed - skipped host-side verify)")


main()
