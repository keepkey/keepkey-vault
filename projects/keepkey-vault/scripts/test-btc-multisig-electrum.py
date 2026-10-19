"""Independent Electrum 4.8 check of btc-multisig-hardware-check.ts evidence.

PYTHONPATH=/path/to/electrum python scripts/test-btc-multisig-electrum.py DIR TYPE
Optionally pass a Desktop partial PSBT to verify and complete with the PUBLIC
synthetic test cosigner (seed bytes 0x02 repeated). Never accepts a real seed,
connects to a device/network, or broadcasts. Keep public wallet evidence local.
"""
import json
import sys
from pathlib import Path
from electrum.bip32 import BIP32Node
from electrum.descriptor import parse_descriptor
from electrum.transaction import PartialTransaction


def check(root: Path, kind: str, partial: Path = None):
    assert kind in ('p2wsh', 'p2sh-p2wsh', 'p2sh')
    policy = json.loads((root / f'{kind}-policy.json').read_text())
    filename = partial or root / f'{kind}-cosigned.psbt'
    tx = PartialTransaction.from_raw_psbt(filename.read_bytes())
    unsigned = PartialTransaction.from_raw_psbt((root / f'{kind}-unsigned.psbt').read_bytes())
    assert tx.serialize_to_network(include_sigs=False) == unsigned.serialize_to_network(include_sigs=False)
    public_test_master = BIP32Node.from_rootseed(bytes([2]) * 32, xtype='standard')
    keypairs = {}
    for i, txin in enumerate(tx.inputs()):
        assert txin.bip32_paths
        branch, index = next(iter(txin.bip32_paths.values()))[1][-2:]
        assert branch in (0, 1)
        desc = policy['descriptor'].split('#')[0].replace('/<0;1>/*', f'/{branch}/{index}')
        txin.script_descriptor = parse_descriptor(desc)
        assert len(txin.sigs_ecdsa) == (1 if partial else 2)
        for pub, sig in txin.sigs_ecdsa.items():
            assert tx.verify_sig_for_txin(txin_index=i, pubkey_bytes=pub, sig=sig)
        if partial:
            assert not txin.is_complete()
            for pub, (fingerprint, path) in txin.bip32_paths.items():
                if fingerprint == public_test_master.calc_fingerprint_of_this_node():
                    child = public_test_master.subkey_at_private_derivation(path)
                    assert child.eckey.get_public_key_bytes(compressed=True) == pub
                    keypairs[pub] = child.eckey.get_secret_bytes()
    assert tx.get_fee() == 1000
    if partial:
        assert keypairs
        tx.sign(keypairs)
        for i, txin in enumerate(tx.inputs()):
            assert len(txin.sigs_ecdsa) == 2
            for pub, sig in txin.sigs_ecdsa.items():
                assert tx.verify_sig_for_txin(txin_index=i, pubkey_bytes=pub, sig=sig)
        (root / f'{kind}-electrum-completed.psbt').write_bytes(tx.serialize_as_bytes(force_psbt=True))
    assert tx.is_complete()
    tx.finalize_psbt()
    report = next(r for r in json.loads((root / 'hardware-report.json').read_text()) if r['type'] == kind)
    assert tx.txid() == report['txid']
    print(f'Electrum: {kind}: signatures verified, fee 1000 sats, finalized txid matches Desktop; partial round trip={bool(partial)}')


if __name__ == '__main__':
    check(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]) if len(sys.argv) > 3 else None)
