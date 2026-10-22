"""Companion to test-btc-electrum.ts; runs offline with real Electrum classes."""
import asyncio
import json
import sys
from pathlib import Path
from electrum import util
from electrum.bip32 import BIP32Node, convert_bip32_strpath_to_intpath
from electrum.keystore import BIP32_KeyStore
from electrum.simple_config import SimpleConfig
from electrum.transaction import tx_from_any
from electrum.wallet import Wallet
from electrum.wallet_db import WalletDB
from electrum.version import ELECTRUM_VERSION

util.AS_LIB_USER_I_WANT_TO_MANAGE_MY_OWN_ASYNCIO_LOOP = True


async def main():
    root = Path(sys.argv[1])
    config = SimpleConfig({'electrum_path': str(root / 'config'), 'offline': True})
    if '--hardware' in sys.argv:
        # Independently verify Desktop's physical-device native SegWit result.
        # This exercises Electrum's codecs/signature verifier, not its USB plugin.
        reports = json.loads((root / 'hardware-report.json').read_text())
        checked = 0
        for report in reports:
            if report['scriptType'] != 'p2wpkh' or not report['signed']:
                continue
            db = WalletDB((root / 'p2wpkh-electrum.json').read_text(), upgrade=True)
            wallet = Wallet(db, config=config)
            wallet.synchronize()
            assert wallet.is_watching_only()
            assert wallet.get_receiving_addresses()[:5] == report['addresses']
            assert wallet.get_keystore().get_root_fingerprint() == report['fingerprint']
            unsigned = tx_from_any((root / 'p2wpkh-unsigned.psbt').read_bytes())
            unsigned.add_info_from_wallet(wallet, include_xpubs=True)
            signed = tx_from_any((root / 'p2wpkh-signed.psbt').read_bytes())
            assert signed.is_complete()
            assert signed.txid() == report['txid']
            assert signed.get_fee() == 1000
            for i, txin in enumerate(signed.inputs()):
                sig, pub = txin.witness_elements()
                assert pub in unsigned.inputs()[i].pubkeys
                assert unsigned.verify_sig_for_txin(txin_index=i, pubkey_bytes=pub, sig=sig)
            checked += 1
        assert checked, 'No signed native SegWit hardware report found'
        print(f'Electrum {ELECTRUM_VERSION}: physical KeepKey native SegWit signature, wallet origin, five addresses, fee and signed PSBT verified (USB plugin not exercised)')
        return
    for fixture in json.loads((root / 'fixtures.json').read_text()):
        name = fixture['name']
        db = WalletDB((root / f'{name}-wallet.json').read_text(), upgrade=True)
        wallet = Wallet(db, config=config)
        wallet.synchronize()
        assert wallet.is_watching_only(), name
        assert wallet.get_receiving_addresses()[:5] == fixture['addresses'], name
        ks = wallet.get_keystore()
        assert ks.get_root_fingerprint() == fixture['fingerprint'], name
        if fixture['path']:
            assert convert_bip32_strpath_to_intpath(ks.get_derivation_prefix()) == convert_bip32_strpath_to_intpath(fixture['path']), name
        (root / f'{name}-upgraded.json').write_text(db.dump())
        signed = tx_from_any((root / f'{name}-signed.psbt').read_bytes())
        assert signed.is_complete(), name
        assert signed.txid() == fixture['txid'], name
        assert signed.serialize_to_network() == fixture['txHex'], name
        unsigned = tx_from_any((root / f'{name}-unsigned.psbt').read_bytes())
        assert not unsigned.is_complete(), name
        unsigned.add_info_from_wallet(wallet, include_xpubs=True)
        (root / f'{name}-electrum-unsigned.psbt').write_bytes(unsigned.serialize_as_bytes(force_psbt=True))
        # Independent signer with the public BIP39 vector's account private key.
        node = BIP32Node.from_xkey(fixture['accountXprv'])._replace(xtype=BIP32Node.from_xkey(ks.xpub).xtype)
        signing_ks = BIP32_KeyStore({**ks.dump(), 'xprv': node.to_xprv()})
        assert signing_ks.can_sign(unsigned), name
        signing_ks.sign_transaction(unsigned, None)
        assert unsigned.is_complete(), name
        (root / f'{name}-electrum-signed.psbt').write_bytes(unsigned.serialize_as_bytes(force_psbt=True))
        print(f'Electrum {ELECTRUM_VERSION}: {name}: wallet, fingerprint, five addresses, PSBT and signatures accepted')


asyncio.run(main())
