#!/usr/bin/env python3
"""Gate-3: clear-signing verified by the BUILT-IN anchor, no signer loaded.

Phase 1 required LoadClearsignSigner before any metadata would verify, and the
device then led with the host-chosen identity ("X (fp) describes this tx"). With
a baked key the same blob verifies with no load at all and presents as
"Insight Verified". This drives exactly that, against a kkemu built with
-DKK_CLEARSIGN_TEST_KEY=ON, and never calls load_clearsign_signer.

  KEEPKEY_SCREENSHOT=1 SCREENSHOT_DIR=out \\
  PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python python3 builtin_anchor_e2e.py
"""
import os
import sys

FW = os.environ.get("KK_FIRMWARE", os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
    "modules", "keepkey-firmware"))
sys.path.insert(0, os.path.join(FW, "deps", "python-keepkey"))

from keepkeylib.client import KeepKeyDebuglinkClient
from keepkeylib.transport_udp import UDPTransport
from keepkeylib.tools import parse_path
from keepkeylib.signed_metadata import (serialize_metadata, sign_metadata,
                                        CLASSIFICATION_VERIFIED)
from keepkeylib.clearsign_catalog import (CLEARSIGN_FLOWS_BY_KEY, FLOW_NONCE,
                                          FLOW_GAS_PRICE, FLOW_GAS_LIMIT,
                                          flow_tx_hash)

# m/0x4B4B'/0x4353'/0' of the public "all all ... all" seed -- the key the
# attestor holds and KK_CLEARSIGN_TEST_KEY bakes into slot 0.
BUILTIN_PRIV = bytes.fromhex(
    "642f523c98dfde47cf6b1c01d08ff8579c2d15a18b8019b53b83a083a2d215ad")
BUILTIN_KEY_ID = 0

flow = CLEARSIGN_FLOWS_BY_KEY["aave-v3-supply"]

client = KeepKeyDebuglinkClient(UDPTransport("127.0.0.1:11044"))
client.set_debuglink(UDPTransport("127.0.0.1:11045"))
client.auto_button = True
client.wipe_device()
client.load_device_by_mnemonic(
    mnemonic="all all all all all all all all all all all all",
    pin="", passphrase_protection=False, label="Anchor", language="english")

payload = serialize_metadata(
    chain_id=flow["chain_id"], contract_address=flow["to"],
    selector=flow["data"][:4], tx_hash=flow_tx_hash(flow),
    method_name=flow["method"], args=flow["args"], key_id=BUILTIN_KEY_ID)
blob = sign_metadata(payload, BUILTIN_PRIV)

resp = client.ethereum_send_tx_metadata(signed_payload=blob,
                                        metadata_version=1,
                                        key_id=BUILTIN_KEY_ID)
print(f"classification: {resp.classification} "
      f"(VERIFIED={CLASSIFICATION_VERIFIED})")
assert resp.classification == CLASSIFICATION_VERIFIED, (
    "built-in anchor did not verify the blob")

v, r, s = client.ethereum_sign_tx(
    n=parse_path("44'/60'/0'/0/0"), nonce=FLOW_NONCE,
    gas_price=FLOW_GAS_PRICE, gas_limit=FLOW_GAS_LIMIT, to=flow["to"],
    value=flow["value"], data=flow["data"], chain_id=flow["chain_id"])
assert r, "signing failed"
print(f"signed {flow['key']} ({flow['method']}) with NO signer loaded, v={v}")
