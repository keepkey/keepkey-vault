"""Independent check of a finished NU7 transparent v6 transaction.

Parses the serialized bytes alone (plus the spent outputs' amounts and scripts,
which a transaction does not carry), recomputes every ZIP-244/229 signature
digest and the txid with hashlib, and verifies each scriptSig's DER signature
against its own public key with `cryptography`. Shares no code with the Rust
sidecar or the TypeScript host. No wallet, profile or network I/O.

stdin:  {"raw_tx", "txid", "branch_id", "prevouts": [{"value", "script_pubkey"}]}
stdout: the parsed transaction and per-input results as JSON.
"""
import hashlib
import json
import struct
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils

case = json.load(sys.stdin)
raw = bytes.fromhex(case['raw_tx'])
branch = case['branch_id']
prevouts = case['prevouts']
u32 = lambda n: struct.pack('<I', n)
u64 = lambda n: struct.pack('<Q', n)


def blake(person, data=b''):
    return hashlib.blake2b(data, digest_size=32, person=person.encode()).digest()


class Reader:
    def __init__(self, data):
        self.data, self.at = data, 0

    def take(self, n):
        assert self.at + n <= len(self.data), 'truncated transaction'
        out = self.data[self.at:self.at + n]
        self.at += n
        return out

    def u32(self):
        return struct.unpack('<I', self.take(4))[0]

    def u64(self):
        return struct.unpack('<Q', self.take(8))[0]

    def compact(self):
        first = self.take(1)[0]
        if first < 253:
            return first
        assert first == 253, 'unexpected large compact size'
        value = struct.unpack('<H', self.take(2))[0]
        assert value >= 253, 'non-canonical compact size'
        return value


r = Reader(raw)
header = dict(version=r.u32(), version_group_id=r.u32(), branch_id=r.u32(), lock_time=r.u32(), expiry_height=r.u32())
inputs = []
for _ in range(r.compact()):
    inputs.append(dict(prevout_hash=r.take(32), prevout_index=r.u32(), script_sig=r.take(r.compact()), sequence=r.u32()))
outputs = []
for _ in range(r.compact()):
    outputs.append(dict(value=r.u64(), script_pubkey=r.take(r.compact())))
trailing = raw[r.at:]
assert len(inputs) == len(prevouts), 'one spent output per input'


def script(data):
    assert len(data) < 253
    return bytes([len(data)]) + data


outpoint = lambda i: i['prevout_hash'] + u32(i['prevout_index'])
prev_scripts = [bytes.fromhex(p['script_pubkey']) for p in prevouts]
header_digest = blake('ZTxIdHeadersHash', b''.join(u32(header[k]) for k in
                      ['version', 'version_group_id', 'branch_id', 'lock_time', 'expiry_height']))
prevouts_digest = blake('ZTxIdPrevoutHash', b''.join(outpoint(i) for i in inputs))
amounts_digest = blake('ZTxTrAmountsHash', b''.join(u64(p['value']) for p in prevouts))
scripts_digest = blake('ZTxTrScriptsHash', b''.join(script(s) for s in prev_scripts))
sequence_digest = blake('ZTxIdSequencHash', b''.join(u32(i['sequence']) for i in inputs))
outputs_digest = blake('ZTxIdOutputsHash', b''.join(u64(o['value']) + script(o['script_pubkey']) for o in outputs))
sapling, orchard, ironwood = blake('ZTxIdSaplingHash'), blake('ZTxIdOrchardH_v6'), blake('ZTxIdIronwd_H_v6')


def top(transparent_digest):
    return hashlib.blake2b(header_digest + transparent_digest + sapling + orchard + ironwood,
                           digest_size=32, person=b'ZcashTxHash_' + u32(branch)).digest()


txid = top(blake('ZTxIdTranspaHash', prevouts_digest + sequence_digest + outputs_digest))
results = []
for index, (i, p, prev_script) in enumerate(zip(inputs, prevouts, prev_scripts)):
    txin = blake('Zcash___TxInHash', outpoint(i) + u64(p['value']) + script(prev_script) + u32(i['sequence']))
    sighash = top(blake('ZTxIdTranspaHash', b'\x01' + prevouts_digest + amounts_digest + scripts_digest
                        + sequence_digest + outputs_digest + txin))
    s = i['script_sig']
    sig_len = s[0]
    der, hash_type = s[1:sig_len], s[sig_len]
    pubkey = s[sig_len + 2:]
    assert s[sig_len + 1] == len(pubkey) == 33 and len(s) == sig_len + 2 + 33, 'P2PKH scriptSig'
    key_hash = hashlib.new('ripemd160', hashlib.sha256(pubkey).digest()).digest()
    valid = True
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), pubkey).verify(
            der, sighash, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
    except InvalidSignature:
        valid = False
    results.append(dict(
        prevout_hash=i['prevout_hash'].hex(), prevout_index=i['prevout_index'], sequence=i['sequence'],
        value=p['value'], script_pubkey=prev_script.hex(), sighash=sighash.hex(),
        pubkey=pubkey.hex(), signature=der.hex(), sighash_type=hash_type,
        key_matches_script=prev_script == b'\x76\xa9\x14' + key_hash + b'\x88\xac',
        signature_valid=valid,
    ))

print(json.dumps(dict(
    header=header,
    inputs=results,
    outputs=[dict(value=o['value'], script_pubkey=o['script_pubkey'].hex()) for o in outputs],
    trailing=trailing.hex(),
    txid=txid.hex(),
    txid_display=txid[::-1].hex(),
    txid_matches_sidecar=txid.hex() == case['txid'],
)))
