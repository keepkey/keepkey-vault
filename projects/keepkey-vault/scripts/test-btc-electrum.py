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
