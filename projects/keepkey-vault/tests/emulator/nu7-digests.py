"""Independent public-fixture ZIP-244/229 hashes; no wallet/profile/network I/O."""
import hashlib
import json
import struct
import sys

fixture = json.load(sys.stdin)
inputs = fixture['inputs']
outputs = fixture['outputs']
u32 = lambda n: struct.pack('<I', n)
u64 = lambda n: struct.pack('<Q', n)

def h(person, data=b''):
    return hashlib.blake2b(data, digest_size=32, person=person.encode()).digest()

def script(value):
    data = bytes.fromhex(value)
    assert len(data) < 253
    return bytes([len(data)]) + data

def outpoint(value):
    return bytes.fromhex(value['prevout_txid']) + u32(value['prevout_index'])

branch = 0x77190AD9
header = h('ZTxIdHeadersHash', b''.join(u32(n) for n in [0x80000006, 0xD884B698, branch, 0, 0]))
prevouts = h('ZTxIdPrevoutHash', b''.join(outpoint(i) for i in inputs))
amounts = h('ZTxTrAmountsHash', b''.join(u64(i['amount']) for i in inputs))
scripts = h('ZTxTrScriptsHash', b''.join(script(i['script_pubkey']) for i in inputs))
sequences = h('ZTxIdSequencHash', b''.join(u32(i['sequence']) for i in inputs))
out = h('ZTxIdOutputsHash', b''.join(u64(o['value']) + script(o['script_pubkey']) for o in outputs))
transparent = lambda txin: h('ZTxIdTranspaHash', b'\x01' + prevouts + amounts + scripts + sequences + out + txin)
sapling = h('ZTxIdSaplingHash')
orchard = h('ZTxIdOrchardH_v6')
ironwood = h('ZTxIdIronwd_H_v6')

def top(transparent_component):
    return hashlib.blake2b(header + transparent_component + sapling + orchard + ironwood,
                          digest_size=32, person=b'ZcashTxHash_' + u32(branch)).hexdigest()

hashes = [top(transparent(h('Zcash___TxInHash', outpoint(i) + u64(i['amount'])
                           + script(i['script_pubkey']) + u32(i['sequence'])))) for i in inputs]
print(json.dumps({
    'digests': {'header': header.hex(), 'transparent': transparent(h('Zcash___TxInHash')).hex(),
                'sapling': sapling.hex(), 'orchard': orchard.hex(), 'ironwood': ironwood.hex()},
    'input_sighashes': hashes,
    'txid_internal': top(h('ZTxIdTranspaHash', prevouts + sequences + out)),
}))
