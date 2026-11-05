#!/usr/bin/env python3
"""Prepare unsigned Safe metadata for the offline ClearSign issuer.

No hardware access. --test-fixture signs ONLY with deterministic throwaway
test keys; that output is never an issuer input or production artifact.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
PYK = ROOT / "modules/keepkey-firmware/deps/python-keepkey"
sys.path.insert(0, str(PYK))
from keepkeylib import erc7730, erc7730_compiler
from keepkeylib.signed_metadata import keccak256

SAFE_TYPE = ("SafeTx(address to,uint256 value,bytes data,uint8 operation,"
             "uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,"
             "address gasToken,address refundReceiver,uint256 nonce)")
MEMBERS = [("to", "address"), ("value", "uint256"), ("data", "bytes"),
           ("operation", "uint8"), ("safeTxGas", "uint256"),
           ("baseGas", "uint256"), ("gasPrice", "uint256"),
           ("gasToken", "address"), ("refundReceiver", "address"),
           ("nonce", "uint256")]
SAFE_DESCRIPTOR = {"display": {"formats": {SAFE_TYPE: {
    "intent": "Approve Safe transaction", "fields": [
        {"path": "data", "label": "Safe call", "format": "calldata",
         "params": {"calleePath": "to", "amountPath": "value",
                    "spenderPath": "@.to"}},
        {"path": "nonce", "label": "Safe nonce", "format": "raw"}]}}}}
TRANSFER = "transfer(address to,uint256 amount)"
TRANSFER_DESCRIPTOR = {"display": {"formats": {TRANSFER: {
    "intent": "Transfer", "fields": [
        {"path": "to", "label": "Recipient", "format": "addressName"},
        {"path": "amount", "label": "Amount", "format": "tokenAmount",
         "params": {"tokenPath": "@.to"}}]}}}}
BASE_TRANSFER_DESCRIPTOR = {"display": {"formats": {TRANSFER: {
    "intent": "Transfer Base USDC", "fields": [
        {"path": "to", "label": "Recipient", "format": "addressName"},
        {"path": "amount", "label": "Amount", "format": "unit",
         "params": {"decimals": 6, "base": "USDC"}}]}}}}
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
USDC_BY_CHAIN = {1: USDC, 8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"}
TEST_FORWARDER = "0x3333333333333333333333333333333333333333"
FORWARD = "forward(address target,bytes data)"
FORWARD_DESCRIPTOR = {"display": {"formats": {FORWARD: {
    "intent": "TEST nested call", "fields": [
        {"path": "data", "label": "Forwarded call", "format": "calldata",
         "params": {"calleePath": "target"}}]}}}}


def document(chain, address):
    zero = "0x" + "00" * 20
    return {"primaryType": "SafeTx", "types": {
        "EIP712Domain": [{"name": "chainId", "type": "uint256"},
                         {"name": "verifyingContract", "type": "address"}],
        "SafeTx": [{"name": n, "type": t} for n, t in MEMBERS]},
        "domain": {"chainId": chain, "verifyingContract": address},
        "message": dict(to=USDC_BY_CHAIN.get(chain, USDC), value="0", data="0xa9059cbb" + "00" * 12
                        + "22" * 20 + (1500000).to_bytes(32, "big").hex(),
                        operation=0, safeTxGas="0", baseGas="0", gasPrice="0",
                        gasToken=zero, refundReceiver=zero, nonce="12")}


def programs(chain, address):
    yield "Safe owner approval", SAFE_DESCRIPTOR, erc7730_compiler.compile_eip712(
        SAFE_DESCRIPTOR, document(chain, address))
    # Safe calls itself for these operations. Every owner, threshold and
    # predecessor that affects the action is shown; no fixed display values.
    settings = [
        ("addOwnerWithThreshold(address owner,uint256 threshold)", "Add Safe owner",
         [("owner", "New owner", "addressName"), ("threshold", "Required signatures", "raw")]),
        ("removeOwner(address prevOwner,address owner,uint256 threshold)", "Remove Safe owner",
         [("prevOwner", "Previous owner", "addressName"), ("owner", "Remove owner", "addressName"), ("threshold", "Required signatures", "raw")]),
        ("swapOwner(address prevOwner,address oldOwner,address newOwner)", "Replace Safe owner",
         [("prevOwner", "Previous owner", "addressName"), ("oldOwner", "Old owner", "addressName"), ("newOwner", "New owner", "addressName")]),
        ("changeThreshold(uint256 threshold)", "Change Safe threshold",
         [("threshold", "Required signatures", "raw")]),
        ("enableModule(address module)", "Enable Safe module",
         [("module", "Module", "addressName")]),
        ("disableModule(address prevModule,address module)", "Disable Safe module",
         [("prevModule", "Previous module", "addressName"), ("module", "Module", "addressName")]),
        ("setGuard(address guard)", "Set Safe guard", [("guard", "Guard", "addressName")]),
        ("setFallbackHandler(address handler)", "Set Safe fallback handler",
         [("handler", "Handler", "addressName")]),
    ]
    for signature, intent, fields in settings:
        descriptor = {"display": {"formats": {signature: {
            "intent": intent, "fields": [dict(path=p, label=l, format=f)
                                           for p, l, f in fields]}}}}
        yield intent, descriptor, erc7730_compiler.compile_calldata(
            descriptor, signature, chain, bytes.fromhex(address[2:]))
    if chain == 8453:
        yield "Transfer Base USDC", BASE_TRANSFER_DESCRIPTOR, erc7730_compiler.compile_calldata(
            BASE_TRANSFER_DESCRIPTOR, TRANSFER, chain,
            bytes.fromhex(USDC_BY_CHAIN[chain][2:]))


def dump(path, body):
    path.write_text(json.dumps(body, indent=2) + "\n")


def test_fixture(out, chain=1):
    from ecdsa import SigningKey, SECP256k1
    from ecdsa.util import sigencode_string_canonize
    root = SigningKey.from_string(hashlib.sha256(b"Safe ClearSign TEST ROOT ONLY").digest(), curve=SECP256k1)
    delegate = SigningKey.from_string(hashlib.sha256(b"Safe ClearSign TEST DELEGATE ONLY").digest(), curve=SECP256k1)
    pub = lambda key: key.verifying_key.to_string("compressed")
    # Fixed public test expiry, reproducible; not a production certificate.
    body = bytes([1, 1]) + chain.to_bytes(4, "big") + (1893456000).to_bytes(4, "big") + b"Safe TEST ONLY".ljust(32, b"\0") + pub(delegate)
    domain = bytes.fromhex("8839401f8d0112b4348770ddace152e96fc5e5081aefeed6b5d8bef0d6ecdf66")
    digest = keccak256(b"\x19\x01" + domain + keccak256(body))
    cert = body + root.sign_digest_deterministic(digest, hashfunc=hashlib.sha256,
                                                sigencode=sigencode_string_canonize)
    safe = "0x1111111111111111111111111111111111111111"
    entries = list(programs(chain, safe))
    if chain == 1:
        entries.append(("USDC transfer", TRANSFER_DESCRIPTOR,
                        erc7730_compiler.compile_calldata(TRANSFER_DESCRIPTOR, TRANSFER,
                                                           chain, bytes.fromhex(USDC_BY_CHAIN[chain][2:]))))
    entries.append(("TEST forwarder", FORWARD_DESCRIPTOR,
                    erc7730_compiler.compile_calldata(FORWARD_DESCRIPTOR, FORWARD,
                                                       chain, bytes.fromhex(TEST_FORWARDER[2:]))))
    definitions = []
    for name, _, program in entries:
        envelope = erc7730.sign_envelope(program, cert, delegate.to_string())
        definitions.append(dict(name=name, definitionId="0x" + hashlib.sha256(envelope).hexdigest(),
                                envelope="0x" + envelope.hex(), kind=program[7], chainId=chain,
                                contractAddress="0x" + program[18:38].hex(),
                                selectorOrTypeHash="0x" + program[38:70 if program[7] == 2 else 42].hex()))
    dump(out, {"warning": "DETERMINISTIC THROWAWAY TEST ROOT: NEVER PUBLISH", "testRootPubkey": pub(root).hex(),
               "typedData": document(chain, safe), "definitions": definitions})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--safe", action="append", default=[], metavar="CHAIN:ADDRESS")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validator", type=Path)
    parser.add_argument("--test-fixture", type=Path)
    parser.add_argument("--test-chain", type=int, choices=[1, 8453], default=1)
    args = parser.parse_args()
    if args.test_fixture:
        if args.safe or args.output: parser.error("test fixture and issuer output are separate operations")
        test_fixture(args.test_fixture, args.test_chain)
        return
    if not args.safe or not args.output: parser.error("provide --safe CHAIN:ADDRESS and --output DIRECTORY")
    if args.output.exists() and any(args.output.iterdir()): parser.error("output directory must be empty")
    args.output.mkdir(parents=True, exist_ok=True)
    scopes, review = {}, []
    for spec in sorted(set(args.safe)):
        if not re.fullmatch(r"[1-9][0-9]*:0x[0-9a-fA-F]{40}", spec): parser.error("invalid Safe: " + spec)
        chain_text, address = spec.split(":")
        chain, address = int(chain_text), address.lower()
        for index, (name, descriptor, program) in enumerate(programs(chain, address)):
            stem = "%d-%s-%02d" % (chain, address, index)
            compiled = args.output / (stem + ".c773")
            compiled.write_bytes(program)
            dump(args.output / (stem + ".json"), descriptor)
            if args.validator: subprocess.run([str(args.validator.resolve()), str(compiled.resolve())], check=True, capture_output=True)
            scopes.setdefault(chain, []).append(program.hex())
            review.append(dict(name=name, chainId=chain, safe=address, kind=program[7],
                               contractAddress="0x" + program[18:38].hex(),
                               selectorOrTypeHash="0x" + program[38:70 if program[7] == 2 else 42].hex(),
                               programFile=compiled.name, sha256=hashlib.sha256(program).hexdigest(), bytes=len(program)))
    dump(args.output / "catalog-unsigned.json", {"entries": [
        dict(kind=2, chain_id=chain, programs_hex=sorted(set(leaves))) for chain, leaves in sorted(scopes.items())]})
    dump(args.output / "review.json", {"status": "unsigned; operator review required", "requiredFirmwareCapability": 28,
         "supported": ["canonical SafeTx CALL", "pinned MultiSend with at most 64 CALL entries"],
         "refused": ["arbitrary delegatecall", "inner delegatecall", "missing inner definition", "malformed or changed bytes"],
         "deploymentChecks": "Verify each Safe address, chain and implementation before signing; no wildcard deployment authorization.",
         "scope": "The listed Safes and their settings calls; Base includes a USDC transfer definition. Other token and protocol calls require their own authenticated definitions.",
         "baseUsdc": {"address": USDC_BY_CHAIN[8453], "decimals": 6,
                      "source": "https://developers.circle.com/stablecoins/usdc-contract-addresses",
                      "display": "unit set by signer; scaled USDC amount and raw integer"} if 8453 in scopes else None,
         "entries": review})
    print("Prepared %d unsigned programs. No device accessed." % len(review))


if __name__ == "__main__":
    main()
